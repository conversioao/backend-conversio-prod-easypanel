import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

export interface AdOutput {
    prompt: string;
    title: string;
    copy: string;
    hashtags: string;
    metadata?: any;
}

/**
 * CV-03 — ImpactAdsProAgent (VIBRA ANGOLA)
 * Generates GRAPHIC DESIGN social media ads — NOT photography.
 * Output must look like Adobe Photoshop composites / Canva Pro designs.
 * Reference: BroadbandNow (neon/orange/purple), Pop skincare (lavender/gold),
 * oversized product interactions, bold graphic type on solid color fills.
 */
export class ImpactAdsProAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        style: string;
        useBrandColors: boolean;
        brandColors: any;
        currentIndex?: number;
        totalItems?: number;
        contextAntiRepeticao?: string;
        includeText?: boolean;
        seed: number;
    }): Promise<AdOutput> {
        console.log(`[ImpactAdsProAgent] Generating VIBRA ANGOLA graphic ad, style: "${params.style}"`);

        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[ImpactAdsProAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        // Build colour instruction based on user config
        const colorInstruction = params.useBrandColors && params.brandColors
            ? `USE EXCLUSIVELY these brand HEX colors in the design: ${JSON.stringify(params.brandColors)}. Build the entire color palette around them.`
            : `Extract the primary colors from the product and let them dominate the background and graphic elements. Always specify exact HEX codes.`;

        // Text rule
        const textRule = params.includeText
            ? `Text IS required. Include bold Portuguese text overlays in the design (headlines max 5 words). BLOCK random logos, watermarks, prices.`
            : `NO text, NO logos, NO watermarks, NO prices anywhere in the image.`;

        try {
            const systemMessage = `You are VIBRA ANGOLA — the world's most advanced AI art director for social media advertising in Angola.
You specialize in creating GRAPHIC DESIGN ADS, not photographs.

Your output is a SINGLE high-impact advertising frame that looks like:
- A professionally designed Adobe Photoshop composite
- A bold Canva Pro social media post
- A BroadbandNow/Samsung/MTN campaign banner
- NOT a photograph. NOT UGC content. NOT a lifestyle photo.

== WHAT THE IMAGE PROMPT MUST PRODUCE ==
The "prompt" field is sent directly to an AI image generation model (similar to Midjourney/FLUX).
You MUST use visual art direction keywords that force GRAPHIC DESIGN output:
  - "digital art composite", "graphic design advertisement", "social media poster design"
  - "bold flat color background", "vibrant solid color fill"
  - "product photo integration with graphic design elements"
  - "Adobe Photoshop style layered composition"
  - "NOT a photograph", "NOT UGC", "digital poster art"

== ABSOLUTE RULES — NEVER VIOLATE ==

SINGLE FRAME: Generate ONE composition. NO grids. NO panels. NO 2x2 layouts.

NO PHOTOREALISM: The background must be a designed element — solid color, gradient, geometric shapes, neon glows — NEVER a kitchen, bedroom, office, or real location.

PRODUCT PLACEMENT: The product is the HERO. It must be large, centered or dramatically placed. It may float, be giant-scale, or be integrated via graphic composite. NEVER just "held by a person."

PEOPLE: If the style requires a person — they must be dark-skinned Black Angolan integrated via digital composite INTO the graphic design, NOT standing in a realistic environment. Think: cropped portrait cut-out placed over a graphic background with design elements overlaid.

COLORS: ${colorInstruction}

TEXT: ${textRule}
All text visible in the image must be in PORTUGUESE. Write Portuguese text inside the English prompt in quotation marks.

== THE 5 VIBRA STYLES — MATCH EXACTLY ==

VIBRA GIGANTE:
Design: Bold solid-color background (beige, cream, or pastel). The product is rendered at SURREAL GIANT scale — 3x to 5x larger than a human. A dark-skinned Black Angolan figure (cut-out composite, NOT in a real room) hugs, leans on, or sits near the giant product. Graphic design elements: floating bubbles, stars, playful shapes. Style: Whimsical pop art poster. Reference: oversized ice cream / giant perfume bottle ads.

VIBRA POP GRID:
Design: Deep VIBRANT SOLID color background (hot pink #FF2D78, electric cyan #00E5FF, or neon yellow #FFE600). Multiple instances or angles of the product arranged in a dynamic pattern (stacked, orbiting, angled). Bold diagonal or curved graphic lines. Halftone dots texture overlay. Style: High-energy graphic design poster, reminiscent of Pop Art / streetwear brand campaigns. NO person needed — product IS the hero.

VIBRA GLOSS EDITORIAL:
Design: Soft lavender #C8A8E9 or warm golden #F5C842 gradient background. Macro close-up of the product (cream texture, liquid drop, glass reflection). If a person is shown: ONLY a small cropped detail — a glowing Black woman's cheek/hand touching the product, with graphic glow overlays (light flares, shimmer). Floating design elements: sparkles, geometric frames, luxury icon flourishes. Style: Sephora / premium beauty brand campaign poster.

VIBRA TECH ENERGY:
Design: Near-black background (#0A0A0F). Electric neon light trails in purple (#8A2BE2), orange (#FF6B00), and electric blue (#00BBFF) streaming across the composition. Product floats centered and glows as if lit by neon. A dark-skinned Black Angolan wearing tech gear (headphones, gaming glasses) is shown as a graphic composite cutout with glow rim-lighting. Speed lines, circuit motifs, energy particle effects. Style: Gaming brand / telecom "fastest network" campaign.

VIBRA PREMIUM SERVICE:
Design: Deep rich background — midnight navy #0D1B2A or forest green #0A2E1F. A dark-skinned Black professional (man or woman) shown as clean composite cutout in stylish business-casual attire. Floating UI/UX dashboard elements, digital arcs, glowing badge icons. Clean geometric frame lines. Logo placeholder area. Style: Fintech / luxury service brand LinkedIn/Instagram campaign ad.

== COLOR RULE ==
${colorInstruction}

== OUTPUT FORMAT — RETURN VALID JSON ONLY ==
{
  "anuncios": [{
    "id": 1,
    "estilo_selecionado": "<style name>",
    "prompt": "<150+ word English image generation prompt using graphic design language, forced digital art style keywords, specific HEX colors, any Portuguese text in quotes>",
    "titulo_imagem": "<bold Portuguese headline, max 5 words>",
    "subtitulo_imagem": "<Portuguese subheadline or CTA, max 8 words>",
    "copy_anuncio": "<Angolan Portuguese ad copy, conversational, max 120 words, ends with CTA>",
    "hashtags": "<15-20 Portuguese hashtags>",
    "usar_cores_marca": true
  }]
}`;

            const userMessage = `Create a VIBRA ANGOLA graphic design social media advertisement.

PRODUCT: ${params.analysis}
SELECTED STYLE: ${params.style}
USER INSTRUCTIONS: ${params.userPrompt || 'Create a premium high-impact social media advertisement.'}

CRITICAL REQUIREMENTS FOR THE "prompt" FIELD:
1. Start with: "Digital art composite social media advertisement poster, graphic design style, NOT a photograph"
2. Describe the BACKGROUND as a designed element (solid color HEX, gradient, geometric shapes) — NEVER a real location
3. Describe the product placement as HERO ELEMENT — large, dramatic, floating, or giant-scale
4. Include at least 3 specific graphic design elements (neon glow, halftone dots, geometric shapes, light trails, sparkles, etc.)
5. If person is needed for this style: describe as "digital composite cutout of dark-skinned Black Angolan" placed over the graphic background — NOT in a real setting
6. Include specific HEX color codes
7. End with anti-UGC keywords: "graphic design quality, digital poster, social media ad quality, NOT photography, NO real room background"

Return ONLY valid JSON. No markdown. No explanations.`;

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: userMessage }
                ],
                response_format: { type: "json_object" },
                temperature: 0.85,
            });

            // Log usage for cost tracking
            if (response.usage) {
                await keyManager.logUsage(
                    apiKeyObj.id,
                    'openai',
                    'ImpactAdsProAgent',
                    response.usage.prompt_tokens,
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            const content = response.choices[0]?.message?.content;
            if (!content) throw new Error('[ImpactAdsProAgent] No content generated.');

            const parsed = JSON.parse(content);
            const ad = parsed.anuncios?.[0];
            if (!ad) throw new Error('[ImpactAdsProAgent] No ad in response.');

            console.log(`[ImpactAdsProAgent] ✅ VIBRA graphic ad generated. Style: ${ad.estilo_selecionado}`);
            return {
                prompt: ad.prompt,
                title: ad.titulo_imagem || 'VIBRA ANGOLA',
                copy: ad.copy_anuncio || ad.copy,
                hashtags: ad.hashtags,
                metadata: {
                    estilo_selecionado: ad.estilo_selecionado || params.style,
                    titulo_imagem: ad.titulo_imagem,
                    subtitulo_imagem: ad.subtitulo_imagem,
                    usar_cores_marca: ad.usar_cores_marca,
                }
            };
        } catch (error: any) {
            console.error('[ImpactAdsProAgent] Error:', error.message);

            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }

            throw error;
        }
    }
}
