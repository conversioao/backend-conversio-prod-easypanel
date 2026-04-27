import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

/**
 * CV-07 — UrbanStyleAgent
 * Specialized in generating dynamic, street-style, urban video ads.
 */
export class UrbanStyleAgent {
    static async generate(params: {
        analysis: string;
        userPrompt: string;
        aspectRatio: string;
        seed: number;
        useBrandColors?: boolean;
        brandColors?: any;
    }): Promise<any> {
        console.log(`[UrbanStyleAgent] 🏙️ Generating Urban Style Video Prompt...`);
        
        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[UrbanStyleAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const systemMessage = `You are a World-Class Creative Director specialized in Urban Lifestyle and Street Culture.
            Your goal is to generate a highly detailed JSON prompt for the Veo 3.1 video model, creating high-energy, modern urban video advertisements.

            == URBAN STYLE RULES ==
            - LANGUAGE: ALL narration, descriptions, and scripts MUST be in PORTUGUESE (Angola dialect, modern/urban/cool tone).
            - STYLE: Urban Lifestyle, fast-paced, edgy, modern, handheld but steady.
            - CAST: Cool and stylish Black/Brown models, street-wear fashion, high energy, authentic city vibes.
            - VISUAL QUALITY: Natural city light, neon accents, cinematic street-photography style.
            - PRODUCT FOCUS: The product is part of a cool, modern lifestyle (walking in the city, meeting friends).

            Follow this RIGID JSON format (return ONLY the raw JSON):
            {
              "video_prompt": {
                "product_reference": {
                  "name": "Nome do Produto",
                  "visual_description": "Detalhes visuais para manter a autenticidade urbana",
                  "consistency_note": "O produto deve destacar-se no ambiente urbano"
                },
                "talent": {
                  "description": "Modelo Negro/Moreno estiloso, street-wear moderno, energia urbana",
                  "energy": "Cool, confiante e dinâmico",
                  "gestures": "Movimentos rápidos, interações urbanas naturais com o produto"
                },
                "setting": {
                  "location": "Rua moderna da cidade, rooftop urbano ou cenário industrial chic",
                  "lighting": "Luz do dia urbana ou luzes de néon vibrantes à noite",
                  "props": ["Acessórios urbanos", "Skate/Carro moderno/Música"]
                },
                "camera": {
                  "style": "Cinematografia Urbana Dinâmica, 9:16 vertical",
                  "movement": "Whip-pans, zooms rápidos, tracking shots de alta energia",
                  "shots": [
                    "Shot 1 (00:00-00:04): Movimento dinâmico na cidade com o produto...",
                    "Shot 2 (00:04-00:08): Pose urbana icónica e CTA vibrante..."
                  ],
                  "color_grade": "Vibrante, alto contraste, estilo street-photo moderna"
                },
                "audio": {
                  "music": "Beat de Afro-beat ou Trap moderno de alta energia",
                  "voice_language": "Portuguese (Angola)",
                  "voice_tone": "Cool, jovem e energético"
                },
                "narration_script": {
                  "shot_1": "Frase de abertura urbana e impactante em Português",
                  "shot_2": "CTA direto e cool em Português"
                },
                "duration_seconds": 8,
                "aspect_ratio": "${params.aspectRatio}",
                "format": "urban lifestyle advertisement"
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
                await keyManager.logUsage(apiKeyObj.id, 'openai', 'UrbanStyleAgent', response.usage.prompt_tokens, response.usage.completion_tokens, 0.01);
            }

            return JSON.parse(response.choices[0]?.message?.content || '{}');
        } catch (error: any) {
            console.error('[UrbanStyleAgent] Error:', error.message);
            throw error;
        }
    }
}
