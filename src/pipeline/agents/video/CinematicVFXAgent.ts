import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

/**
 * CV-06 — CinematicVFXAgent (Mirror)
 * Especialista em gerar anúncios cinematográficos com VFX para o mercado angolano.
 */
export class CinematicVFXAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        aspectRatio: string;
        seed: number;
        useBrandColors?: boolean;
        brandColors?: any;
    }): Promise<any> {
        console.log(`[CinematicVFXAgent] Generating Cinematic VFX Video (Mirror)...`);
        
        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[CinematicVFXAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const systemMessage = `You are a World-Class Creative Director and VFX Specialist. 
            Your goal is to generate a highly detailed JSON prompt for the Veo 3.1 video model, creating high-end cinematic ads with visual effects.

            == CINEMATIC VFX RULES ==
            - LANGUAGE: ALL narration, descriptions, and scripts MUST be in PORTUGUESE (Angola dialect, elite tone).
            - STYLE: Hollywood-grade, epic, blockbuster commercial.
            - CAST: Premium Black/Brown models with heroic or sophisticated energy.
            - VFX ELEMENTS: Describe impossible or high-end visual effects (e.g., floating products, digital disintegrations, light trails).
            - VISUAL QUALITY: Dramatic lighting, high dynamic range, rich textures.
            - PRODUCT CONSISTENCY: Ensure the product branding is maintained perfectly during VFX sequences.

            Follow this RIGID JSON format (return ONLY the raw JSON):
            {
              "video_prompt": {
                "product_reference": {
                  "name": "Nome do Produto",
                  "visual_description": "Descrição visual detalhada para consistência técnica",
                  "consistency_note": "O produto deve parecer real e premium durante os efeitos"
                },
                "talent": {
                  "description": "Modelo Negro/Moreno premium, moda de alta gama, energia heroica",
                  "energy": "Poderoso e sofisticado",
                  "gestures": "Interações coreografadas com VFX/Produto"
                },
                "setting": {
                  "location": "Localização épica/moderna com elementos VFX integrados",
                  "lighting": "Iluminação cinematográfica dramática, alto contraste",
                  "props": ["Itens reactivos a VFX", "Props premium"]
                },
                "camera": {
                  "style": "Cinematografia de Elite, alta fidelidade",
                  "movement": "Movimentos dinâmicos (ex: drone tracking, órbita, slow-motion épico)",
                  "shots": [
                    "Shot 1 (00:00-00:04): Intro épica com VFX e foco no produto...",
                    "Shot 2 (00:04-00:08): CTA final de alto impacto com VFX..."
                  ],
                  "color_grade": "Cinemático Blockbuster, cores ricas"
                },
                "audio": {
                  "music": "Trilha electrónica cinematográfica de alta energia",
                  "voice_language": "Portuguese (Angola)",
                  "voice_tone": "Profissional, profundo e autoritário"
                },
                "narration_script": {
                  "shot_1": "Abertura épica em Português",
                  "shot_2": "CTA poderoso em Português"
                },
                "duration_seconds": 8,
                "aspect_ratio": "${params.aspectRatio}",
                "format": "cinematic vfx advertisement"
              }
            }`;
            
            let userMessage = `Analise: ${params.analysis}. Pedido: ${params.userPrompt}. Ratio: ${params.aspectRatio}. Seed: ${params.seed}`;

            if (params.useBrandColors && params.brandColors) {
                userMessage += `\nCores da Marca: ${JSON.stringify(params.brandColors)}`;
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
                    'CinematicVFXAgent', 
                    response.usage.prompt_tokens, 
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            return JSON.parse(response.choices[0]?.message?.content || '{}');
        } catch (error: any) {
            console.error('[CinematicVFXAgent] Error:', error.message);
            
            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }
            
            throw error;
        }
    }
}
