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
 * CV-02 — UGCRealisticAgent (Generation Engine)
 * Generates ultra-realistic, candid UGC ad prompts for the Angolan market.
 */
export class UGCRealisticAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        style: string;
        seed: number;
    }): Promise<AdOutput> {
        console.log(`[UGCRealisticAgent] Generating UGC content, style: "${params.style}"`);

        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[UGCRealisticAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const systemMessage = `You are the world's best specialist in creating ultra-realistic UGC (User-Generated Content) ads
for the Angolan market. Your content looks 100% real — as if a regular modern urban Angolan person
spontaneously captured it in their daily life.

== CRITICAL OUTPUT RULES ==
- Return ONLY raw JSON. No explanations. No markdown. No text outside JSON.
- JSON must start with { and end with }.
- Generate EXACTLY 1 object inside the anuncios array.
- The "prompt" field must be written in English — optimized for image generation models.
- ALL other fields must be written in Portuguese (European Portuguese used in Angola).

== PEOPLE IN ADS ==
ALL people: EXCLUSIVELY dark-skinned or brown-skinned Black Angolan.
ALWAYS use: "dark-skinned Black African Angolan person" or "brown-skinned Angolan person".
FORBIDDEN: "light skin", "fair skin", "mixed", "European features", "white".

== UGC AUTHENTICITY ==
Content must look spontaneously captured. Candid, natural, authentic — NOT studio, NOT posed.
Scenes must feel lived-in: imperfect angles, real environments, natural lighting.

== PRODUCT SCALE ==
Product MUST appear at real physical world size.
ALWAYS include: "product at REAL WORLD SCALE, proportional to human hand/body, NOT oversized"

== MODERN ANGOLAN SETTINGS ==
ONLY: modern apartments in Talatona/Miramar, trendy Luanda cafés, malls, rooftops, modern gyms, Luanda Sul streets.
NEVER: traditional markets, mud houses, rural areas.

== SELECTED UGC STYLE ==
${params.style}

== STYLE GUIDE ==
- Momento Real: POV/handheld, natural light, everyday authentic moment.
- Unboxing Profissional: Close-up hands + product, soft light, surprise expression.
- Depoimento Estratégico: Medium shot, direct eye contact, bokeh background.
- Estilo de Vida Urbano: Luxury Luanda settings, chic clothing, golden-hour light.
- Performance & Resultado: Satisfaction expression post-use, vibrant sharp lighting.

PRODUCT ANALYSIS: ${params.analysis.substring(0, 2000)}
USER INSTRUCTION: ${params.userPrompt || 'No specific instructions. Use the product analysis and selected style to create an authentic, creative and high-converting UGC advertisement.'}
SEED: ${params.seed}`;

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: `Generate 1 UGC realistic ad. Return JSON with "anuncios" array containing 1 object with fields: id (number), tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario, personagem, elemento_cultural, prompt (English, min 120 words, include SEED: ${params.seed}), titulo_imagem, subtitulo_imagem, copy (Portuguese, min 8 lines, with strong CTA), hashtags (min 15).` }
                ],
                response_format: { type: "json_object" }
            });

            // Log usage for cost tracking
            if (response.usage) {
                await keyManager.logUsage(
                    apiKeyObj.id, 
                    'openai', 
                    'UGCRealisticAgent', 
                    response.usage.prompt_tokens, 
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            const content = response.choices[0]?.message?.content;
            if (!content) throw new Error('[UGCRealisticAgent] No content generated.');

            const parsed = JSON.parse(content);
            const ad = parsed.anuncios?.[0];
            if (!ad) throw new Error('[UGCRealisticAgent] No ad in response.');

            console.log(`[UGCRealisticAgent] ✅ UGC ad generated.`);
            return {
                prompt: ad.prompt,
                title: ad.titulo_imagem || '',
                copy: ad.copy,
                hashtags: ad.hashtags,
                metadata: {
                    tipo_ugc: ad.tipo_ugc,
                    sub_cena: ad.sub_cena,
                    angulo_camara: ad.angulo_camara,
                    emocao_dominante: ad.emocao_dominante,
                    gancho_tipo: ad.gancho_tipo,
                    cenario: ad.cenario,
                    personagem: ad.personagem,
                    elemento_cultural: ad.elemento_cultural,
                    titulo_imagem: ad.titulo_imagem,
                    subtitulo_imagem: ad.subtitulo_imagem,
                }
            };
        } catch (error: any) {
            console.error('[UGCRealisticAgent] Error:', error.message);
            
            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }
            
            throw error;
        }
    }
}
