import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

export interface BrandAnalysisOutput {
    company_name: string;
    brand_colors: {
        primary: string;
        secondary: string;
        accent: string | null;
        background: string;
        tone: 'dark' | 'light' | 'vibrant' | 'muted';
        palette: string[];
        palette_description: string;
    };
}

/**
 * BrandColorExtractorAgent
 * Analyzes a given logo image URL using OpenAI Vision to extract brand identity colors 
 * and infer the company name. Designed to replace the legacy n8n webhook.
 */
export class BrandColorExtractorAgent {
    static async analyze(imageUrl: string): Promise<BrandAnalysisOutput> {
        console.log(`[BrandColorExtractorAgent] Analyzing logo at URL: ${imageUrl}`);
        
        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            throw new Error('[BrandColorExtractorAgent] No working OpenAI API key available.');
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const systemMessage = `És um especialista em Design Guiado e Identidade de Marca (Branding).
A tua missão é olhar para um logótipo fornecido e extrair, com a máxima precisão, a identidade visual exata em formato HEX.

DEVES CUMPRIR AS SEGUINTES REGRAS EXATAMENTE:
1. Responde APENAS com um objeto JSON puro. Nenhuma marcação Markdown.
2. Formato obrigatório:
{
    "company_name": "Nome visível no logotipo ou 'A Minha Marca' se não houver texto",
    "brand_colors": {
        "primary": "#HEX",
        "secondary": "#HEX",
        "accent": "#HEX ou null",
        "background": "#HEX (cor predominante para o fundo apropriado, geralmente escuro se o logotipo for claro)",
        "tone": "dark" | "light" | "vibrant" | "muted",
        "palette": ["#HEX1", "#HEX2", "#HEX3"],
        "palette_description": "Breve descrição em Português de Angola da paleta"
    }
}
3. Nunca inventes cores. Lê os tons reais dos píxeis do logótipo.`;

            const response = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemMessage },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Extrai a paleta de cores e o nome desta marca.' },
                            { type: 'image_url', image_url: { url: imageUrl } }
                        ]
                    }
                ],
                response_format: { type: 'json_object' }
            });

            // Log usage for cost tracking
            if (response.usage) {
                await keyManager.logUsage(
                    apiKeyObj.id, 
                    'openai', 
                    'BrandColorExtractorAgent', 
                    response.usage.prompt_tokens, 
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            const content = response.choices[0]?.message?.content;
            if (!content) {
                throw new Error('[BrandColorExtractorAgent] O modelo GPT-4o não devolveu conteúdo.');
            }

            const parsed = JSON.parse(content) as BrandAnalysisOutput;
            return parsed;
        } catch (error: any) {
            console.error('[BrandColorExtractorAgent] Error:', error.message);
            
            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }
            
            throw error;
        }
    }
}
