import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

/**
 * CV-07 — VibraPremiumAgent
 * Especialista em gerar roteiros editoriais de alta gama com múltiplas cenas.
 */
export class VibraPremiumAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        aspectRatio: string;
        seed: number;
        useBrandColors?: boolean;
        brandColors?: any;
    }): Promise<any> {
        console.log(`[VibraPremiumAgent] 💎 Gerando roteiro premium editorial (Veo 3)...`);
        
        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[VibraPremiumAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const systemMessage = `You are a World-Class Creative Director and Luxury Brand Expert.
            Your goal is to generate a highly detailed JSON prompt for the Veo 3.1 video model, creating ultra-luxury, high-end editorial video advertisements.

            == VIBRA PREMIUM RULES ==
            - LANGUAGE: ALL narration, descriptions, and scripts MUST be in PORTUGUESE (Angola dialect, ultra-premium/sophisticated tone).
            - STYLE: Luxury Editorial, high-fashion, macro focus, textural, slow and elegant.
            - CAST: Elite Black/Brown models with high-fashion features, glowing/radiant skin, elegant presence.
            - VISUAL QUALITY: Soft-box lighting, golden hour glows, high-end studio setups, macro lens details of product texture.
            - PRODUCT FOCUS: Focus on the "Soul" of the product - liquid textures, gold accents, fine materials.

            Follow this RIGID JSON format (return ONLY the raw JSON):
            {
              "video_prompt": {
                "product_reference": {
                  "name": "Nome do Produto",
                  "visual_description": "Detalhes visuais precisos e luxuosos",
                  "consistency_note": "A integridade da marca deve ser absoluta"
                },
                "talent": {
                  "description": "Modelo Negro/Moreno de elite, pele radiante, aura de sofisticação",
                  "energy": "Elegante e sereno",
                  "gestures": "Interações lentas e delicadas com o produto"
                },
                "setting": {
                  "location": "Estúdio de luxo ou localização arquitetónica minimalista",
                  "lighting": "Iluminação de estúdio suave, glow dourado premium",
                  "props": ["Elementos de luxo minimalista", "Texturas complementares"]
                },
                "camera": {
                  "style": "Cinematografia de Moda, fov macro, profundidade de campo rasa",
                  "movement": "Slow-motion elegante, slides suaves, foco na textura",
                  "shots": [
                    "Shot 1 (00:00-00:04): Macro textura do produto e reação da pele...",
                    "Shot 2 (00:04-00:08): Pose de elite com o produto e CTA suave..."
                  ],
                  "color_grade": "Editorial Dourado, tons de pele ricos, sombras suaves"
                },
                "audio": {
                  "music": "Som ambiente sofisticado ou batida Lo-Fi de luxo",
                  "voice_language": "Portuguese (Angola)",
                  "voice_tone": "Suave, elegante e aspiracional"
                },
                "narration_script": {
                  "shot_1": "Frase de abertura sofisticada em Português",
                  "shot_2": "CTA de luxo em Português"
                },
                "duration_seconds": 8,
                "aspect_ratio": "${params.aspectRatio}",
                "format": "luxury editorial advertisement",
                "pacing": "Slow and elegant"
              }
            }`;

            let userMessage = `Análise do Produto: ${params.analysis}. 
            Pedido do Cliente: ${params.userPrompt}. 
            Cores da Marca: ${params.useBrandColors ? JSON.stringify(params.brandColors) : 'N/A'}. 
            Seed: ${params.seed}`;

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
                    'VibraPremiumAgent', 
                    response.usage.prompt_tokens, 
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            return JSON.parse(response.choices[0]?.message?.content || '{}');
        } catch (error: any) {
            console.error('[VibraPremiumAgent] Error:', error.message);
            
            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }
            
            throw error;
        }
    }
}
