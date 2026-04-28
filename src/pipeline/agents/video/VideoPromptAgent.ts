import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

/**
 * CV-05 — VideoPromptAgent (Mirror)
 * Genera el prompt final para modelos de video (Veo/Sora).
 */
export class VideoPromptAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        aspectRatio: string;
        seed: number;
        useBrandColors?: boolean;
        brandColors?: any;
    }): Promise<any> {
        console.log(`[VideoPromptAgent] Generating Video prompt (Mirror)...`);
        
        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[VideoPromptAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const systemMessage = `Você é um especialista em prompts para geração de vídeo (Veo 3.1).
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
                  "energy": "Vibe da cena",
                  "gestures": "Ações físicas coreografadas"
                },
                "setting": {
                  "location": "Cenário premium com setup",
                  "lighting": "Configuração técnica de luz dramática",
                  "props": ["Item 1", "Item 2"]
                },
                "camera": {
                  "style": "Pro-Camera Rig, 4k high-fidelity",
                  "movement": "Descrição dos movimentos de câmera",
                  "shots": [
                    "Shot 1 (00:00-00:04): Scene 1...",
                    "Shot 2 (00:04-00:08): Scene CTA..."
                  ],
                  "color_grade": "Rich contrast"
                },
                "audio": {
                  "music": "High-energy electronic track",
                  "voice_language": "Portuguese (Angola)",
                  "voice_tone": "Professional, deep, and authoritative"
                },
                "narration_script": {
                  "shot_1": "Narração em PT-AO",
                  "shot_2": "Narração em PT-AO"
                },
                "duration_seconds": 8,
                "aspect_ratio": "${params.aspectRatio}",
                "format": "short-form",
                "pacing": "Epic and impactful"
              }
            }`;
            let userMessage = `Analysis: ${params.analysis}. Request: ${params.userPrompt}. Ratio: ${params.aspectRatio}. Seed: ${params.seed}`;

            if (params.useBrandColors && params.brandColors) {
                userMessage += `\nBrand Colors: ${JSON.stringify(params.brandColors)}`;
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
                    'VideoPromptAgent', 
                    response.usage.prompt_tokens, 
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            return JSON.parse(response.choices[0]?.message?.content || '{}');
        } catch (error: any) {
            console.error('[VideoPromptAgent] Error:', error.message);
            
            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }
            
            throw error;
        }
    }
}
