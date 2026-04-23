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
            const systemMessage = `Você é um especialista em criação de anúncios de vídeo UGC (User-Generated Content) para o mercado angolano. 
            Seu objetivo é gerar um prompt JSON super estruturado para o modelo Veo 3.1, seguindo o padrão pedido.

            == REGRAS DO AGENTE UGC ==
            - TALENTO: OBRIGATÓRIAMENTE pessoa negra ou morena (angolana), mid 20s, estilo autêntico.
            - RITMO: Natural, focado no produto.
            - PRODUTO: Sempre visível e manuseado pelo talento.
            - ÁUDIO: Português de Angola (PT-AO). NUNCA usar sotaque ou expressões brasileiras.
            - CTA OBRIGATÓRIO: O último shot DEVE conter um Call-to-Action claro, com o talento a segurar/mostrar o produto.

            Siga RIGOROSAMENTE este formato JSON BRUTO (retorne APENAS o JSON, sem markdown blocks \`\`\`json):
            {
              "video_prompt": {
                "product_reference": {
                  "name": "Nome do Produto",
                  "visual_description": "Descrição detalhada e visualizável do produto",
                  "consistency_note": "Aviso obrigatório de consistência visual do produto"
                },
                "talent": {
                  "description": "Young black/mixed-race woman/man (Angolan), mid 20s, roupas...",
                  "energy": "Vibe autêntica e quente",
                  "gestures": "Ações exatas e interações com o produto"
                },
                "setting": {
                  "location": "Local da gravação",
                  "lighting": "Iluminação exata",
                  "props": [
                    "Item de cena 1",
                    "Item de cena 2"
                  ]
                },
                "camera": {
                  "style": "Handheld vertical phone-style, medium shot",
                  "movement": "Movimento de câmera e ritmo",
                  "shots": [
                    "Shot 1 (00:00-00:04): Descrição do que acontence...",
                    "Shot 2 (00:04-00:08): Descrição com o CTA final..."
                  ],
                  "color_grade": "Natural, clean, bright"
                },
                "audio": {
                  "music": "None",
                  "voice_language": "Portuguese (Angola)",
                  "voice_tone": "Casual and warm"
                },
                "narration_script": {
                  "shot_1": "Frase de abertura em PT-AO",
                  "shot_2": "Frase de CTA clara em PT-AO"
                },
                "duration_seconds": 8,
                "aspect_ratio": "${params.aspectRatio}",
                "format": "vertical short-form",
                "pacing": "Natural and clear"
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
