import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

/**
 * CV-08 — MinimalistStudioAgent
 * Specialized in clean, high-end minimalist studio product showcases.
 */
export class MinimalistStudioAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        aspectRatio: string;
        seed: number;
        useBrandColors?: boolean;
        brandColors?: any;
    }): Promise<any> {
        console.log(`[MinimalistStudioAgent] ⚪ Generating Minimalist Studio Video Prompt...`);
        
        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[MinimalistStudioAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const systemMessage = `You are a World-Class Creative Director and Minimalist Product Specialist.
            Your goal is to generate a highly detailed JSON prompt for the Veo 3.1 video model, creating clean, technical, high-end product showcase videos.

            == MINIMALIST STUDIO RULES ==
            - LANGUAGE: ALL narration, descriptions, and scripts MUST be in PORTUGUESE (Angola dialect, clean/precise/technical tone).
            - STYLE: Minimalist Studio, technical detail, focus on geometry, material, and form.
            - CAST: Elegant and minimal Black/Brown models, focus on hands, profiles, and graceful interaction.
            - VISUAL QUALITY: Precise studio lighting, clean backgrounds (white/grey/neutral), focus on product texture and branding.
            - PRODUCT FOCUS: Technical showcase - showing the mechanism, the texture of the material, and the pure form.

            Follow this RIGID JSON format (return ONLY the raw JSON):
            {
              "video_prompt": {
                "product_reference": {
                  "name": "Nome do Produto",
                  "visual_description": "Detalhes técnicos e materiais precisos",
                  "consistency_note": "O produto deve parecer tecnicamente perfeito"
                },
                "talent": {
                  "description": "Modelo Negro/Moreno elegante, movimentos precisos e minimalistas",
                  "energy": "Focado e profissional",
                  "gestures": "Interações técnicas e graciosas com o produto (ex: abrir, tocar na textura)"
                },
                "setting": {
                  "location": "Estúdio minimalista high-end com fundo neutro infinito",
                  "lighting": "Iluminação técnica de estúdio, sombras suaves e precisas",
                  "props": ["Acessórios de design minimalista", "Elementos geométricos"]
                },
                "camera": {
                  "style": "Cinematografia Técnica, fov macro, foco profundo",
                  "movement": "Movimentos de precisão (ex: sliders retos, rotação 360, zooms lentos)",
                  "shots": [
                    "Shot 1 (00:00-00:04): Showcase técnico da textura e design do produto...",
                    "Shot 2 (00:04-00:08): Uso técnico preciso e CTA limpo..."
                  ],
                  "color_grade": "Limpo, neutro, alta fidelidade de cores"
                },
                "audio": {
                  "music": "Batida minimalista e moderna (Electronic ou Neo-Classical)",
                  "voice_language": "Portuguese (Angola)",
                  "voice_tone": "Preciso, calmo e informativo"
                },
                "narration_script": {
                  "shot_1": "Frase de abertura técnica e clara em Português",
                  "shot_2": "CTA direto e profissional em Português"
                },
                "duration_seconds": 8,
                "aspect_ratio": "${params.aspectRatio}",
                "format": "minimalist studio advertisement"
              }
            }`;
            
            const userMessage = `Analysis: ${params.analysis}. User Prompt: ${params.userPrompt}. Ratio: ${params.aspectRatio}. Seed: ${params.seed}`;

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: userMessage }
                ],
                response_format: { type: "json_object" }
            });

            if (response.usage) {
                await keyManager.logUsage(apiKeyObj.id, 'openai', 'MinimalistStudioAgent', response.usage.prompt_tokens, response.usage.completion_tokens, 0.01);
            }

            return JSON.parse(response.choices[0]?.message?.content || '{}');
        } catch (error: any) {
            console.error('[MinimalistStudioAgent] Error:', error.message);
            throw error;
        }
    }
}
