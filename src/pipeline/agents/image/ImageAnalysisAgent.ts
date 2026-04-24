import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../../../config.js';
import { keyManager } from '../../../services/KeyManager.js';

/**
 * CV-01 — ImageAnalysisAgent
 * Analyzes a product image using GPT-4o Vision to extract details
 * for use in the image generation pipeline (UGC, ImpactAds, etc.)
 */
export class ImageAnalysisAgent {
    static async analyze(imageUrl: string): Promise<string> {
        console.log(`[ImageAnalysisAgent] Analyzing product image: ${imageUrl.substring(0, 50)}...`);

        const apiKeyObj = await getOpenAIKey();
        if (!apiKeyObj) {
            return 'OpenAI API Key not available.';
        }

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "You are a senior product analyst for a creative advertising agency. Your task is to analyze a product image and describe it in detail for an ad generation pipeline. Focus on: branding, physical dimensions (scale), colors, materials, and key visual features. Output a concise but detailed technical analysis in English."
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Analyze this product for an advertising campaign. Describe it physically and identify the brand/type." },
                            {
                                type: "image_url",
                                image_url: {
                                    url: imageUrl,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 500,
            });

            // Log usage for cost tracking
            if (response.usage) {
                await keyManager.logUsage(
                    apiKeyObj.id, 
                    'openai', 
                    'ImageAnalysisAgent', 
                    response.usage.prompt_tokens, 
                    response.usage.completion_tokens,
                    (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
                );
            }

            const analysis = response.choices[0]?.message?.content || 'Unidentified product.';
            console.log(`[ImageAnalysisAgent] Analysis complete.`);
            return analysis;
        } catch (error: any) {
            console.error('[ImageAnalysisAgent] Error analyzing image:', error.message);
            
            // Report failure to trigger failover
            if (error.status === 401 || error.status === 429 || error.message.includes('API key')) {
                await keyManager.reportFailure(apiKeyObj.id, error.message);
            }
            
            return 'Could not analyze product image. Proceed with general instructions.';
        }
    }
}
