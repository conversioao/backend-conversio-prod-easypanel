import OpenAI from 'openai';
import { getOpenAIKey, getKieKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';
import { KieAiNode } from '../../nodes/KieAiNode.js';

export class BrandingIdentityAgent {
    static async extractDNA(params: {
        brandName: string;
        slogan?: string;
        sector: string;
        description: string;
        visualStyle: string;
        approvedLogoPrompt: string;
    }) {
        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) throw new Error('[BrandingIdentityAgent] No working OpenAI API key available.');

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret, timeout: 60000 });

        const systemPrompt = `És um director de arte especialista em sistemas de identidade visual.
Recebes a descrição de uma marca e o prompt do logótipo aprovado.
Deves extrair e definir o DNA visual da marca para guiar a criação consistente dos restantes elementos.

Gera um JSON com:
{
  "paleta": {
    "primaria": "#hex",
    "secundaria": "#hex",
    "acento": "#hex",
    "neutro": "#hex",
    "fundo": "#hex"
  },
  "tipografia": {
    "titulo": "nome da fonte Google Fonts",
    "corpo": "nome da fonte Google Fonts"
  },
  "estiloGeral": "descrição em 1-2 frases do estilo visual coerente",
  "elementosVisuais": "descrição de formas, texturas e elementos decorativos a usar"
}

Responde APENAS com JSON válido, sem texto adicional.`;

        const userMessage = `Marca: ${params.brandName}
Nicho: ${params.sector}
Descrição: ${params.description}
Estilo Visual: ${params.visualStyle}
Prompt do Logótipo: ${params.approvedLogoPrompt}`;

        try {
            const response = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage }
                ],
                response_format: { type: 'json_object' },
                temperature: 0.7
            });

            if (response.usage) {
                await keyManager.logUsage(
                    apiKeyObj.id, 'openai', 'BrandingIdentityAgent_DNA',
                    response.usage.prompt_tokens, response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            const content = response.choices[0]?.message?.content;
            if (!content) throw new Error('Empty response from OpenAI.');

            return JSON.parse(content);
        } catch (err: any) {
            console.error('[BrandingIdentityAgent] DNA error:', err.message);
            throw err;
        }
    }

    static async generateItem(params: {
        prompt: string;
        aspectRatio: string;
        inputImageUrl: string;
        resolution?: string;
    }) {
        const kieKeyObj = await getKieKey();
        const kieKey = kieKeyObj?.key_secret;

        // Use nano-banana-2 which is fast and reliable.
        const model = 'nano-banana-2';
        
        // If the URL is a local blob or data URL, KIE.ai can't use it, so we don't pass it.
        // It must be an absolute http(s) URL.
        const isValidUrl = params.inputImageUrl && params.inputImageUrl.startsWith('http');
        const imageUrls = isValidUrl ? [params.inputImageUrl] : undefined;

        try {
            const taskId = await KieAiNode.createTask({
                model,
                prompt: params.prompt,
                aspectRatio: params.aspectRatio,
                imageUrls,
                apiKey: kieKey
            });
            const imageUrl = await KieAiNode.pollJobStatus(taskId, 15, 5, kieKey);
            return { imageUrl, status: 'completed' };
        } catch (err: any) {
            console.error(`[BrandingIdentityAgent] Generate item failed:`, err.message);
            throw new Error(err.message || 'Falha ao gerar item de identidade.');
        }
    }
}
