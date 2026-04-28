import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

/**
 * CV-05 — UGCVideoAgent
 * Especialista em gerar roteiros e prompts para vídeos UGC (User Generated Content)
 * focados no mercado Angolano.
 */
export class UGCVideoAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        aspectRatio: string;
        seed: number;
        useBrandColors?: boolean;
        brandColors?: any;
    }): Promise<any> {
        console.log(`[UGCVideoAgent] 🎬 Gerando roteiro criativo para vídeo UGC (Mirror)...`);
        
        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[UGCVideoAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            // Nota: No backend esta é uma versão auto-contida. 
            // A execução em produção ocorre na Generation Engine.
            const systemMessage = `You are a World-Class Creative Director specialized in UGC (User Generated Content).
            Your goal is to generate a highly detailed JSON prompt for the Veo 3.1 video model.

            == UGC AGENT RULES ==
            - LANGUAGE: ALL narration, descriptions, and scripts MUST be in PORTUGUESE (Angola dialect, premium tone).
            - STYLE: Authentic, selfie-style or home-studio, relatable, high-trust.
            - CAST: Premium Black/Brown models with glowing skin, authentic and charismatic.
            - VISUAL QUALITY: Natural lighting or soft home-studio setup.
            - CAMERAWORK: Handheld movements, direct eye contact with camera.
            - PRODUCT FOCUS: The model must be showing, touching, or using the product naturally.

            Follow this RIGID JSON format (return ONLY the raw JSON):
            {
              "video_prompt": {
                "product_reference": {
                  "name": "Nome do Produto",
                  "visual_description": "Descrição visual detalhada para consistência técnica",
                  "consistency_note": "Garantir que o produto pareça real e consistente"
                },
                "talent": {
                  "description": "Modelo Negro/Moreno premium, pele radiante, estilo autêntico",
                  "energy": "Carismático e confiante",
                  "gestures": "Interagindo com o produto, apontando para detalhes"
                },
                "setting": {
                  "location": "Cenário autêntico (ex: sala moderna, casa de banho premium, jardim iluminado)",
                  "lighting": "Luz natural suave ou iluminação de estúdio caseiro",
                  "props": ["Acessórios modernos", "Elementos do quotidiano"]
                },
                "camera": {
                  "style": "Cinematografia UGC vertical, estilo smartphone premium",
                  "movement": "Movimentos naturais de mão, zooms subtis",
                  "shots": [
                    "Shot 1 (00:00-00:04): Introdução autêntica com o produto...",
                    "Shot 2 (00:04-00:08): Demonstração e CTA em Português..."
                  ],
                  "color_grade": "Natural, vibrante e limpo"
                },
                "audio": {
                  "music": "Beat moderno e leve (Afro-house suave ou Pop)",
                  "voice_language": "Portuguese (Angola)",
                  "voice_tone": "Amigável e entusiasta"
                },
                "narration_script": {
                  "shot_1": "Abertura impactante em Português",
                  "shot_2": "CTA forte em Português"
                },
                "duration_seconds": 8,
                "aspect_ratio": "${params.aspectRatio}",
                "format": "ugc video advertisement",
                "pacing": "Dinâmico e envolvente"
              }
            }`;
            
            let userMessage = `Analise este produto: ${params.analysis}. 
            Pedido do utilizador: ${params.userPrompt}. 
            Proporção: ${params.aspectRatio}. Seed: ${params.seed}`;

            if (params.useBrandColors && params.brandColors) {
                userMessage += `\nCores da marca: ${JSON.stringify(params.brandColors)}`;
            }

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
                    'UGCVideoAgent', 
                    response.usage.prompt_tokens, 
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            return JSON.parse(response.choices[0]?.message?.content || '{}');
        } catch (error: any) {
            console.error('[UGCVideoAgent] Error:', error.message);
            
            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }
            
            throw error;
        }
    }
}
