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
                        content: `You are a Senior Creative Director for a premium advertising agency. 
                        Your task is to analyze a product image and create a "Creative Vision" for a high-end video campaign (like UGC or Editorial).
                        
                        You MUST identify and describe:
                        1. **Product Type**: Is it masculine, feminine, or children's?
                        2. **Visual Features**: Branding, colors, materials, and textures.
                        3. **Creative Scenario**: Suggest a premium location and setting that fits the product (e.g., luxury bathroom, modern studio, sun-drenched garden).
                        4. **Cast Profile**: Suggest the ideal person for the ad. ALWAYS prioritize diverse and premium profiles: Black and Brown models with glowing skin, elegant presence, and authentic style.
                        5. **Mood & Lighting**: Describe the lighting (e.g., golden hour, studio softbox, dramatic shadows).
                        
                        Output your analysis in English, formatted as a detailed creative brief.`
                    },
                    {
                        role: "user",
                        content: [
                            { type: "text", text: "Analyze this product and provide a full creative vision for a premium video ad. Identify gender/age target, location, and cast profile." },
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
