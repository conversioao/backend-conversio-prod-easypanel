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
            const systemMessage = `Você é um especialista em criação de anúncios de vídeo cinematográficos de alta gama com VFX para o mercado angolano.
            ESTILO: Hollywood, comercial de luxo, efeitos visuais épicos.
            PESSOAS: Africanos negros/morenos angolanos.
            IDIOMA: Português de Angola (narração potente).
            
            Siga RIGOROSAMENTE este formato JSON BRUTO (retorne APENAS o JSON, sem markdown blocks \`\`\`json):
            {
              "video_prompt": {
                "product_reference": {
                  "name": "Nome do Produto",
                  "visual_description": "Descrição visual detalhada para consistência técnica",
                  "consistency_note": "Aviso obrigatório de consistência visual do produto"
                },
                "talent": {
                  "description": "Young black/mixed-race woman/man (Angolan), vestuário premium",
                  "energy": "Vibe da cena (ex: Sophisticated, heroic)",
                  "gestures": "Ações físicas coreografadas"
                },
                "setting": {
                  "location": "Cenário premium com VFX setup",
                  "lighting": "Configuração técnica de luz dramática",
                  "props": ["Item 1", "Item 2"]
                },
                "camera": {
                  "style": "Cinematic Pro-Camera Rig, 4k high-fidelity com VFX",
                  "movement": "Descrição dos movimentos de câmera impossíveis/VFX",
                  "shots": [
                    "Shot 1 (00:00-00:04): Scene 1 com VFX...",
                    "Shot 2 (00:04-00:08): Scene CTA com VFX..."
                  ],
                  "color_grade": "Hollywood Blockbuster, Rich contrast"
                },
                "audio": {
                  "music": "High-energy cinematic electronic track with bass drops",
                  "voice_language": "Portuguese (Angola)",
                  "voice_tone": "Professional, deep, and authoritative"
                },
                "narration_script": {
                  "shot_1": "Narração épica em PT-AO",
                  "shot_2": "Narração épica com CTA em PT-AO"
                },
                "duration_seconds": 8,
                "aspect_ratio": "${params.aspectRatio}",
                "format": "cinematic vfx short-form",
                "pacing": "Epic and impactful"
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
