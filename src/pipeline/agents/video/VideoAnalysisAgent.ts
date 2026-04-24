import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

/**
 * CV-04 — VideoAnalysisAgent
 * High-depth Vision analysis for Video campaigns in Angola
 */
export class VideoAnalysisAgent {
    static async analyze(imageUrl: string, userPrompt: string): Promise<string> {
        console.log(`[VideoAnalysisAgent] Analyzing product for video (Mirror)...`);

        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            return JSON.stringify({ error: 'No working OpenAI API key available.' });
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Analyze this image for a video marketing campaign. Be detailed about lighting, texture and mood." },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: `User request: ${userPrompt}` },
                            { type: "image_url", image_url: { url: imageUrl } },
                        ],
                    },
                ],
                max_tokens: 1000,
            });

            // Log usage for cost tracking
            if (response.usage) {
                await keyManager.logUsage(
                    apiKeyObj.id, 
                    'openai', 
                    'VideoAnalysisAgent', 
                    response.usage.prompt_tokens, 
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            return response.choices[0]?.message?.content || '{}';
        } catch (error: any) {
            console.error('[VideoAnalysisAgent] Error:', error.message);
            
            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }
            
            return JSON.stringify({ error: error.message });
        }
    }
}

