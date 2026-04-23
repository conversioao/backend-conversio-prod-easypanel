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
            const systemMessage = `Você é o VIBRA PREMIUM, um Diretor Criativo de elite especializado em anúncios cinematográficos para o mercado angolano.
            Seu objetivo é gerar um prompt JSON super estruturado para o modelo Veo 3.1, seguindo um padrão editorial de luxo.

            == ESTRUTURA DO VIBRA PREMIUM ==
            - 4 Cenas rápidas e dinâmicas (Total: 8 a 10 segundos).
            - Estilo: Editorial de Moda / Tech de Luxo.
            - Ritmo: Cortes rápidos, transições suaves, foco em detalhes macro.
            - Narração: Profissional, aspiracional, em Português (Angola) SEM gírias vulgares.

            == REGRAS DE OURO ==
            1. PROMPT TÉCNICO: Deve ser em Inglês, extremamente detalhado, descrevendo iluminação (Rim light, soft boxes), câmera (Dolly zoom, orbital) e texturas.
            2. TALENTO: Personagens angolanas negras/morenas, vestuário premium.
            3. CONSISTÊNCIA: O produto deve estar presente e ser o herói em todas as cenas.

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
                  "energy": "Vibe da cena (ex: Sophisticated, high-energy)",
                  "gestures": "Ações físicas coreografadas"
                },
                "setting": {
                  "location": "Cenário premium (ex: Luxury condo, studio with neon shadows)",
                  "lighting": "Configuração técnica de luz (ex: Volumetric lighting, warm sunset glow)",
                  "props": [
                    "Item de cena 1",
                    "Item de cena 2"
                  ]
                },
                "camera": {
                  "style": "Cinematic, high-end commercial",
                  "movement": "Descrição dos movimentos de câmera (ex: 4 scenes with dynamic cuts)",
                  "shots": [
                    "Shot 1 (00:00-00:02): Descrição técnica em Inglês",
                    "Shot 2 (00:02-00:04): Descrição técnica em Inglês",
                    "Shot 3 (00:04-00:06): Descrição técnica em Inglês",
                    "Shot 4 (00:06-00:08): Descrição técnica em Inglês com foco no CTA visual"
                  ],
                  "color_grade": "Aesthetic de cor (ex: Teal and Orange, High Contrast)"
                },
                "audio": {
                  "music": "Descrição da trilha sonora (ex: Upbeat Afro-Tech, Amapiano Luxury)",
                  "voice_language": "Portuguese (Angola)",
                  "voice_tone": "Professional, smooth, aspirational"
                },
                "narration_script": {
                  "shot_1": "Linha de narração em PT-AO",
                  "shot_2": "Linha de narração em PT-AO",
                  "shot_3": "Linha de narração em PT-AO",
                  "shot_4": "Linha de narração em PT-AO with CTA claro"
                },
                "duration_seconds": 8,
                "aspect_ratio": "${params.aspectRatio}",
                "format": "cinematic short-form",
                "pacing": "Fast-paced editorial cuts"
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
