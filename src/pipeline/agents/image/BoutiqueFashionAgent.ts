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
 * BoutiqueFashionAgent (CV-04)
 * Specialized in fashion, beauty products, hair extensions and luxury boutiques in Angola.
 */
export class BoutiqueFashionAgent {
    static async generate(params: {
        analysis: string | any;
        userPrompt: string;
        style: string;
        useBrandColors?: boolean;
        brandColors?: any;
        seed: number;
        aspectRatio?: string;
    }): Promise<AdOutput> {
        console.log(`[BoutiqueFashionAgent] Generating fashion ad, style: "${params.style}"`);

        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[BoutiqueFashionAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const systemMessage = `You are LuandaLooks, the fashion advertising specialist agent for the
Conversio AI platform (Angola). Your job: receive a structured product
analysis and the ad style chosen by the user, then generate three outputs:
  1. A detailed Nano Banana image prompt (in English)
  2. Persuasive ad copy for social media (in Angolan Portuguese)
  3. Relevant hashtags (in Angolan Portuguese + English)
 
════════════════════════════════════════════════════════════
AD STYLES
════════════════════════════════════════════════════════════
 
STYLE 1 — EDITORIAL CATALOGUE
Clean studio background (light grey, cream or soft white), neutral
flat gradient backdrop. Exactly ONE (1) model in professional editorial pose.
Two or three product detail crops shown as inset thumbnails (collar, fabric,
stitching). Available sizes listed on the right side in clean modern
typography in Portuguese. Soft studio lighting — key light from
upper-left, subtle fill. Full-body or three-quarter shot. 50mm lens.
 
STYLE 2 — LIFESTYLE URBANO BOLD
Split two-tone background (deep charcoal on left, warm amber or
off-white on right). Large bold condensed typography overlaid on the
image — product category or punchy tagline in Portuguese. Model in
relaxed urban pose, weight on one leg, hands in pockets or gesturing
naturally. High contrast, punchy colours. Wide-angle 35mm lens.
Dynamic cropping — head may be partially cut at top.
 
STYLE 3 — OUTFIT OF THE DAY (OOTD)
Soft pastel or neutral gradient background (sky blue, sage, or warm
beige). Full-body shot, model looking slightly off-camera or smiling
naturally. Thin call-out lines pointing to garment details with short
Portuguese labels (e.g. 'Tecido respirável', 'Corte regular'). Clean
sans-serif typography. Brand-style editorial feel. 85mm portrait lens.
Airy, light atmosphere.
 
STYLE 4 — STREET / ASPIRACIONAL
Outdoor urban location in modern Luanda: Talatona glass towers,
Miramar seafront boulevard, Ilha do Cabo beach promenade, Belas
Business Park plaza, or a boutique café terrace in Vila Alice.
Golden hour or bright noon sunlight. Model walks confidently toward
camera or leans against a sleek architectural surface. Shallow
depth of field, background bokeh. 85mm lens. Warm, aspirational,
elevated lifestyle feel.
 
STYLE 5 — STREET STYLE / FASHION WEEK
Urban Luanda street: modern cobblestone plaza, contemporary
Angolan architecture, or a glass-and-steel building entrance.
Model in a bold, fashion-forward pose — strong stance, direct gaze
into camera or a confident profile. Colour-blocked outfit with
statement accessories. Eye-level camera, slight shallow focus on
model. Documentary street-photography feel — candid but composed.
Overcast or diffused natural light for flat even tones.
 
════════════════════════════════════════════════════════════
ABSOLUTE RULES — NEVER VIOLATE
════════════════════════════════════════════════════════════
 
MODELS
• All models must have dark or medium-brown African/Angolan skin tones
• Exactly ONE (1) model per image for Catalogue styles — focus completely on the product
• Beautiful Angolan women and handsome Angolan men with natural
  African features — no ambiguous or non-African appearance
• Diverse representation: vary body type, hair style, age (18-40)
  across generations
 
LOCATION (styles 4 and 5 only)
• Always set in recognisably modern Luanda locations
• Reference: Talatona, Miramar, Ilha do Cabo, Belas, Vila Alice
• Architecture must feel Angolan and contemporary — not European,
  not generic
 
TEXT IN IMAGES
• Any visible text inside the generated image must be in
  Portuguese (pt-AO) — never English, never French
 
BRANDING
• Zero logos, zero wordmarks, zero watermarks in any image
• Do not include any brand name unless explicitly in the product
  analysis received
 
ACCURACY
• Do not invent product details not present in the analysis
• If a detail is unknown, describe it generically and elegantly
 
PROMPT LANGUAGE
• Nano Banana prompt: always in detailed English
• Copy + hashtags: always in Angolan Portuguese (Luanda cadence)
  — never Brazilian Portuguese, never European Portuguese
 
ANTI-REPETITION
• Each generation must vary: scene, camera angle, model emotion,
  colour palette, pose — never repeat the same combination
 
════════════════════════════════════════════════════════════
OUTPUT FORMAT — ALWAYS RETURN VALID JSON
════════════════════════════════════════════════════════════
 
Return ONLY this JSON structure, no preamble, no markdown fences:
 
{
  "prompt_nano_banana": "<detailed English prompt>",
  "copy_anuncio": "<Angolan Portuguese ad copy, max 150 words>",
  "hashtags": "<15-20 hashtags separated by spaces>"
}`;

            const analysisText = typeof params.analysis === 'object' ? JSON.stringify(params.analysis) : params.analysis;
            const userMessage = `Produto analisado:
${analysisText}
 
Estilo de anúncio selecionado: ${params.style}
 
Gera agora o prompt para o Nano Banana, a copy do anúncio e as hashtags.
Segue todas as regras do sistema e retorna o JSON estruturado.`;

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: userMessage }
                ],
                response_format: { type: "json_object" }
            });

            // Log usage for cost tracking
            if (response.usage) {
                await keyManager.logUsage(
                    apiKeyObj.id, 
                    'openai', 
                    'BoutiqueFashionAgent', 
                    response.usage.prompt_tokens, 
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            const content = response.choices[0]?.message?.content;
            if (!content) throw new Error('[BoutiqueFashionAgent] No content generated.');

            let parsed;
            try {
                parsed = JSON.parse(content);
            } catch (e) {
                console.error('[BoutiqueFashionAgent] Failed to parse JSON:', e);
                throw new Error('Failed to parse generation output');
            }

            let adPrompt = parsed.prompt_nano_banana;
            
            // Cap prompt length for Nano Banana 2 (max ~600 chars)
            const MAX_PROMPT_CHARS = 600;
            if (adPrompt && adPrompt.length > MAX_PROMPT_CHARS) {
                adPrompt = adPrompt.substring(0, MAX_PROMPT_CHARS).trimEnd() + '.';
            }

            console.log(`[BoutiqueFashionAgent] ✅ Final prompt (${adPrompt?.length} chars) generated.`);

            return {
                prompt: adPrompt,
                title: 'LuandaLooks Ad',
                copy: typeof parsed.copy_anuncio === 'object' ? JSON.stringify(parsed.copy_anuncio) : (parsed.copy_anuncio || ""),
                hashtags: typeof parsed.hashtags === 'object' ? (Array.isArray(parsed.hashtags) ? parsed.hashtags.join(' ') : JSON.stringify(parsed.hashtags)) : (parsed.hashtags || ""),
                metadata: {
                    estilo_selecionado: params.style,
                    raw_json: parsed
                }
            };
        } catch (error: any) {
            console.error('[BoutiqueFashionAgent] Error:', error.message);
            
            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }
            
            throw error;
        }
    }
}
