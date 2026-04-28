import { OpenAI } from 'openai';
import { keyManager } from '../services/KeyManager.js';
import { GPT4O_MINI_PRICING, GPT4O_PRICING } from '../config.js';

export interface OpenAIUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    keyId: number;
}

export interface OpenAIResponse {
    content: string | null;
    usage: OpenAIUsage;
}

/**
 * Standardized helper for Backend agents to execute OpenAI requests.
 * Handles: Working key retrieval, error reporting, and automatic usage logging.
 */
export async function processWithOpenAI(
    systemMsg: string,
    userMsg: string | any[],
    agentName: string,
    model: string = "gpt-4o-mini",
    responseFormat: "json_object" | "text" = "json_object"
): Promise<OpenAIResponse> {
    const apiKeyObj = await keyManager.getWorkingKey('openai');
    if (!apiKeyObj) {
        throw new Error(`[${agentName}] No working OpenAI key available in database.`);
    }

    try {
        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });
        
        const messages: any[] = [
            { role: "system", content: systemMsg }
        ];

        if (Array.isArray(userMsg)) {
            messages.push(...userMsg);
        } else {
            messages.push({ role: "user", content: userMsg });
        }

        const response = await openai.chat.completions.create({
            model: model as any,
            messages: messages,
            response_format: responseFormat === "json_object" ? { type: "json_object" } : undefined
        });

        const content = response.choices[0]?.message?.content || null;
        
        const usage = {
            prompt_tokens: response.usage?.prompt_tokens || 0,
            completion_tokens: response.usage?.completion_tokens || 0,
            total_tokens: response.usage?.total_tokens || 0,
            keyId: apiKeyObj.id
        };

        // Automatic logging for backend agents
        const pricing = model.includes('mini') ? GPT4O_MINI_PRICING : GPT4O_PRICING;
        const totalCost = (usage.prompt_tokens * pricing.input) + (usage.completion_tokens * pricing.output);
        
        await keyManager.logUsage(
            usage.keyId,
            'openai',
            agentName,
            usage.prompt_tokens,
            usage.completion_tokens,
            totalCost
        );

        return { content, usage };
    } catch (err: any) {
        console.error(`[${agentName}] OpenAI API Error:`, err.message || err);
        
        // Report failure if it's a key-related error
        if (err.status === 401 || err.status === 429 || err.message.includes('API key')) {
            await keyManager.reportFailure(apiKeyObj.id, err.message);
        }
        
        throw err;
    }
}
