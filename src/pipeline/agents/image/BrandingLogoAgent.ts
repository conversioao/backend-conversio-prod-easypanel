import OpenAI from 'openai';
import { getOpenAIKey, getKieKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';
import { KieAiNode } from '../../nodes/KieAiNode.js';

export interface LogoVariant {
    id: string;
    estilo: string;
    prompt: string;
    imageUrl: string | null;
    status: 'pending' | 'completed' | 'failed';
    error?: string;
}

export interface BrandingLogoResult {
    variants: LogoVariant[];
    totalGenerated: number;
    errors: number;
}

/**
 * BrandingLogoAgent
 * Step 1: Calls GPT-4o-mini to generate 4 distinct logo prompts from brand data.
 * Step 2: Calls KIE.ai (Nano Banana Pro / Gemini) in parallel for all 4 prompts.
 */
export class BrandingLogoAgent {
    static async generate(params: {
        brandName: string;
        slogan?: string;
        sector: string;
        description: string;
        visualStyle: string;
        userId?: string;
        regenerateStyle?: { id: string; estilo: string };
    }): Promise<BrandingLogoResult> {
        const isRegen = !!params.regenerateStyle;
        console.log(`[BrandingLogoAgent] Generating logo kit for: "${params.brandName}" (Regen: ${isRegen})`);

        // ── Step 1: Generate prompts via OpenAI (GPT-4o-mini) ─────────────────
        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[BrandingLogoAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({
            apiKey: apiKeyObj.key_secret,
            timeout: 60000
        });

        const styleGuide: Record<string, string> = {
            'modern-minimal': 'ultra-minimalist SaaS logo, sleek tech brand, geometric shapes, dynamic gradient, high-end modern, dark background, premium corporate identity, dribbble style',
            'luxury':         'luxurious minimal logo, gold accents on dark background, premium SaaS feel, fine vector lines, high-end exclusive branding, elegant, sleek typography focus',
            'colorful':       'vibrant tech logo, bold neon gradients, energetic SaaS brand, dark modern background, dynamic 3D glassmorphism icon, premium dribbble logo design',
            'traditional':    'classic but modern corporate logo, solid trust, timeless tech symbol, sleek execution, dark mode background, professional established brand',
            'youthful':       'bold startup logo, modern street-tech, vibrant dynamic colors on dark background, contemporary web3 or AI vibe, high-impact minimalistic',
        };

        const styleDesc = styleGuide[params.visualStyle] || params.visualStyle;

        let systemPrompt = '';
        let userMessage = '';

        if (isRegen) {
            systemPrompt = `You are a world-class brand identity specialist and top-tier Dribbble UI/UX designer.
Generate 1 distinct image-generation prompt for a premium logo creation based on the requested style.
The style to focus on is: ${params.regenerateStyle!.estilo}.

Each prompt must:
- Be written in clear English optimised for image generation models
- Start with: "Premium modern minimal logo design for ${params.brandName},"
- Reflect the visual style: ${styleDesc}
- Subtly incorporate the brand sector: ${params.sector}
- Specify: solid dark or contrasting premium background, vector-style, sleek typography, centered perfect composition, minimalist abstract icon, flat or subtle gradient design, dribbble top logo style
- Make sure it reflects the requested specific approach: ${params.regenerateStyle!.estilo}

Respond ONLY with valid JSON.
Format:
{
  "prompts": [
    { "id": "${params.regenerateStyle!.id}", "estilo": "${params.regenerateStyle!.estilo}", "prompt": "..." }
  ]
}`;
            userMessage = `Brand: ${params.brandName}
Sector: ${params.sector}
Description: ${params.description}
Generate 1 completely new prompt for the style: ${params.regenerateStyle!.estilo}.`;
        } else {
            systemPrompt = `You are a world-class brand identity specialist and top-tier Dribbble UI/UX designer.
You receive brand information and generate 2 distinct, highly professional image-generation prompts for premium logo creation.

Each prompt must:
- Be written in clear English optimised for image generation models
- Start with: "Premium modern minimal logo design for ${params.brandName},"
- Reflect the visual style: ${styleDesc}
- Subtly incorporate the brand sector: ${params.sector}
- If a tagline or slogan is provided, ensure the logo concept aligns with its meaning or vibe.
- Specify: solid dark or contrasting premium background, vector-style, sleek typography, centered perfect composition, minimalist abstract icon, flat or subtle gradient design, dribbble top logo style
- Only include the brand name text if explicitly noted as "typographic"
- Each of the 2 variations must have a completely distinct visual approach (e.g., one geometric symbol, one minimalist lettermark)

Respond ONLY with valid JSON. No markdown. No explanation. No text outside the JSON.
Format:
{
  "prompts": [
    { "id": "v1", "estilo": "Symbol & Text", "prompt": "..." },
    { "id": "v2", "estilo": "Abstract Lettermark", "prompt": "..." }
  ]
}`;
            userMessage = `Brand name: ${params.brandName}
${params.slogan ? `Tagline: ${params.slogan}` : ''}
Sector: ${params.sector}
Description: ${params.description}
Visual style: ${params.visualStyle} — ${styleDesc}

Generate the 2 high-end logo prompts now.`;
        }

        let prompts: Array<{ id: string; estilo: string; prompt: string }> = [];

        try {
            const response = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage }
                ],
                response_format: { type: 'json_object' },
                temperature: 0.8
            });

            if (response.usage) {
                await keyManager.logUsage(
                    apiKeyObj.id, 'openai', 'BrandingLogoAgent',
                    response.usage.prompt_tokens, response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            const content = response.choices[0]?.message?.content;
            if (!content) throw new Error('[BrandingLogoAgent] Empty response from OpenAI.');

            const parsed = JSON.parse(content);
            prompts = parsed.prompts || [];
            if (prompts.length === 0) throw new Error('[BrandingLogoAgent] No prompts returned.');
            console.log(`[BrandingLogoAgent] ✅ ${prompts.length} prompts generated by OpenAI.`);

        } catch (err: any) {
            console.error('[BrandingLogoAgent] OpenAI error:', err.message);
            if (err.status === 401 || err.status === 429 || String(err.message).includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, err.message);
            }
            throw err;
        }

        // ── Step 2: Generate images in parallel via KIE.ai ────────────────────
        const kieKeyObj = await getKieKey();
        const kieKey = kieKeyObj?.key_secret;

        // Use Nano Banana 2 model (Gemini image generation via KIE.ai)
        const model = 'nano-banana-2';

        const imageResults = await Promise.allSettled(
            prompts.map(async (p) => {
                try {
                    const taskId = await KieAiNode.createTask({
                        model,
                        prompt: p.prompt,
                        aspectRatio: '1:1',
                        apiKey: kieKey
                    });
                    const imageUrl = await KieAiNode.pollJobStatus(taskId, 12, 5, kieKey);
                    console.log(`[BrandingLogoAgent] ✅ ${p.id} image ready: ${imageUrl?.substring(0, 60)}...`);
                    return { ...p, imageUrl, status: 'completed' as const };
                } catch (err: any) {
                    console.error(`[BrandingLogoAgent] ❌ ${p.id} failed:`, err.message);
                    return { ...p, imageUrl: null, status: 'failed' as const, error: err.message };
                }
            })
        );

        const variants: LogoVariant[] = imageResults.map((result, i) => {
            if (result.status === 'fulfilled') return result.value;
            return {
                id: prompts[i]?.id || `v${i + 1}`,
                estilo: prompts[i]?.estilo || 'Variação',
                prompt: prompts[i]?.prompt || '',
                imageUrl: null,
                status: 'failed',
                error: String(result.reason)
            };
        });

        const completed = variants.filter(v => v.status === 'completed').length;
        const errors = variants.filter(v => v.status === 'failed').length;

        console.log(`[BrandingLogoAgent] 🎉 Done: ${completed}/4 images generated, ${errors} errors.`);

        return { variants, totalGenerated: completed, errors };
    }
}
