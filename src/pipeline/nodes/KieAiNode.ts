import axios from 'axios';

const KIE_AI_API_KEY = process.env.KIE_AI_API_KEY || '56d2b8e5f458d72d9bdf2dd9f204d60a';
const BASE_URL = 'https://api.kie.ai/api/v1';

export interface KieAiJobResult {
    status: 'pending' | 'processing' | 'completed' | 'failed';
    imageUrl?: string;
    error?: string;
}

export class KieAiNode {
    /**
     * Creates a new generation task in KIE.ai
     */
    static async createTask(params: {
        model: string;
        prompt: string;
        imageUrls?: string[];
        aspectRatio?: string;
        apiKey?: string;
    }): Promise<string> {
        const apiKey = params.apiKey || KIE_AI_API_KEY;
        console.log(`[KieAiNode] Creating task with model: ${params.model}`);
        
        // Detect if it's a Suno/Music model
        const isSuno = params.model.toLowerCase().includes('suno') || params.model.toUpperCase() === 'V5';
        
        // Map common model aliases to KIE.ai specific names if needed
        let modelName = params.model;
        if (modelName.toUpperCase() === 'V5') modelName = 'suno-v3.5';
        if (modelName === 'suno/v4') modelName = 'suno-v4';

        const input: any = isSuno ? {
            gpt_description_prompt: params.prompt,
            make_instrumental: params.prompt.toLowerCase().includes('instrumental'),
            prompt: params.prompt
        } : {
            prompt: params.prompt,
            image_urls: params.imageUrls || [],
            output_format: 'png',
            image_size: params.aspectRatio || '1:1',
            quality: 'basic'
        };

        try {
            const response = await axios.post(`${BASE_URL}/jobs/createTask`, {
                model: modelName,
                input: input
            }, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            });

            if (response.data?.success && response.data?.data?.taskId) {
                return response.data.data.taskId;
            }

            throw new Error(response.data?.message || 'Falha ao criar tarefa no KIE.ai');
        } catch (error: any) {
            console.error('[KieAiNode] Error in createTask:', error.response?.data || error.message);
            throw new Error(error.response?.data?.message || error.message || 'Erro na comunicação com KIE.ai');
        }
    }

    /**
     * Polls the job status until it's finished or timed out
     */
    static async pollJobStatus(taskId: string, intervalSeconds: number = 10, timeoutMinutes: number = 5, apiKey?: string): Promise<string> {
        const finalApiKey = apiKey || KIE_AI_API_KEY;
        console.log(`[KieAiNode] Starting poll for task: ${taskId}`);
        
        const startTime = Date.now();
        const timeoutMs = timeoutMinutes * 60 * 1000;

        while (Date.now() - startTime < timeoutMs) {
            try {
                const response = await axios.get(`${BASE_URL}/jobs/recordInfo`, {
                    params: { taskId },
                    headers: {
                        'Authorization': `Bearer ${finalApiKey}`
                    }
                });

                const data = response.data?.data;
                const state = data?.state;

                console.log(`[KieAiNode] Task ${taskId} status: ${state}`);

                if (state === 'success') {
                    const resultJson = JSON.parse(data.resultJson);
                    const resultUrl = resultJson.resultUrls?.[0] || resultJson.audioUrls?.[0] || resultJson.videoUrls?.[0];
                    if (resultUrl) return resultUrl;
                    throw new Error('Tarefa concluída mas URL do ficheiro não encontrada no resultado.');
                }

                if (state === 'failed' || state === 'error') {
                    throw new Error(data.errorMessage || 'Tarefa falhou no KIE.ai');
                }

                // Wait for the next poll
                await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
            } catch (error: any) {
                if (error.message.includes('falhou') || error.message.includes('não encontrada')) {
                   throw error;
                }
                console.warn(`[KieAiNode] Polling error for ${taskId}:`, error.message);
                await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
            }
        }

        throw new Error(`Timeout atingido após ${timeoutMinutes} minutos de espera.`);
    }
}
