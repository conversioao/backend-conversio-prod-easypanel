import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { query } from '../../db.js';

// Kie.ai API Key should be passed in or fetched from Config
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
        resolution?: string;
        style?: string;
        title?: string;
        instrumental?: boolean;
    }): Promise<string> {
        const apiKey = params.apiKey;
        if (!apiKey) throw new Error('[KieAiNode] ❌ No API Key provided for KIE.ai task creation.');
        
        console.log(`[KieAiNode] Creating task with model: ${params.model} (Res: ${params.resolution || 'Standard'}, Ratio: ${params.aspectRatio || '1:1'})`);
        
        // Detect if it's a Suno/Music model
        let modelName = params.model;
        const isSuno = modelName.toLowerCase().includes('suno') || 
                       modelName.toLowerCase().includes('music') || 
                       modelName.toUpperCase() === 'V5' ||
                       modelName.toUpperCase() === 'V4';
        
        // Map common model aliases to KIE.ai specific names if needed
        if (modelName === 'google/nano-banana-lite') modelName = 'google/nano-banana-edit';
        if (modelName === 'grok-imagine/text-to-image') {
            modelName = 'grok-imagine/text-to-image';
        }
        if (modelName.toUpperCase() === 'V5' || modelName.toLowerCase().includes('music v5') || modelName === 'suno-v5') modelName = 'suno/v4';
        if (modelName === 'suno-v4') modelName = 'suno/v4';
        if (modelName === 'suno-v3.5' || modelName === 'suno/v3.5') modelName = 'suno/v3.5';
        if (modelName === 'suno-v3' || modelName === 'suno/v3') modelName = 'suno/v3';

        let input: any = {};

        if (isSuno) {
            input = {
                gpt_description_prompt: params.prompt,
                make_instrumental: params.prompt.toLowerCase().includes('instrumental'),
                prompt: params.prompt
            };
        } else if (modelName === 'google/nano-banana-edit') {
            input = {
                prompt: params.prompt,
                image_urls: params.imageUrls || [],
                output_format: 'png',
                aspect_ratio: params.aspectRatio || '1:1',
                image_size: params.aspectRatio || '1:1'
            };
        } else if (modelName === 'nano-banana-pro' || modelName === 'nano-banana-2') {
            input = {
                prompt: params.prompt,
                image_input: params.imageUrls || [],
                aspect_ratio: params.aspectRatio || '1:1',
                resolution: (params.resolution || '1k').toUpperCase(),
                output_format: 'jpg'
            };
        } else if (modelName === 'gpt-image-2-image-to-image') {
            input = {
                prompt: params.prompt,
                input_urls: params.imageUrls || [],
                aspect_ratio: params.aspectRatio || 'auto',
                resolution: (params.resolution || '1k').toUpperCase()
            };
        } else if (modelName.toLowerCase().includes('veo')) {
            // Input object is not used for Veo 3.1 (uses flat payload), 
            // but we define it here just in case of fallback/logging
            input = {
                prompt: params.prompt,
                imageUrls: params.imageUrls || [],
                aspect_ratio: params.aspectRatio || '16:9'
            };
        } else if (modelName === 'bytedance/seedream' || modelName === 'seedream/4.5-edit') {
            input = {
                prompt: params.prompt,
                image_urls: params.imageUrls || [],
                aspect_ratio: params.aspectRatio || '1:1',
                quality: 'basic',
                nsfw_checker: true
            };
        } else {
            // Default payload for other models
            input = {
                prompt: params.prompt,
                image_urls: params.imageUrls || [],
                output_format: 'png',
                image_size: params.aspectRatio || '1:1',
                quality: 'basic'
            };
        }

        const isVeo = modelName.toLowerCase().includes('veo');
        const endpoint = isVeo ? `${BASE_URL}/veo/generate` : (isSuno ? `${BASE_URL}/generate` : `${BASE_URL}/jobs/createTask`);

        let payload: any = {
            model: modelName,
            input: input
        };

        // Specific override for Suno (Dedicated endpoint, flat payload)
        if (isSuno) {
            // Map to valid KIE Suno identifiers
            let sunoModel = 'V4';
            const upperModel = modelName.toUpperCase();
            if (upperModel.includes('V5') || upperModel === 'SUNO/V5') sunoModel = 'V5';
            else if (upperModel.includes('V4') || upperModel === 'SUNO/V4') sunoModel = 'V4';
            else if (upperModel.includes('V3_5') || upperModel.includes('V3.5') || upperModel === 'SUNO/V3.5') sunoModel = 'V3_5';
            else if (upperModel.includes('V3') || upperModel === 'SUNO/V3') sunoModel = 'V3';

            payload = {
                prompt: params.prompt,
                model: sunoModel,
                customMode: true,
                instrumental: params.instrumental !== undefined ? params.instrumental : params.prompt.toLowerCase().includes('instrumental'),
                style: params.style || 'Pop',
                title: params.title || 'Conversio AI Track',
                callBackUrl: `https://webhook.site/dummy-conversio-${Date.now()}` // Required by KIE
            };
        }

        // Specific override for Veo 3.1 (Flat payload, different endpoint)
        if (isVeo) {
            let veoModel = 'veo3_fast';
            if (modelName.toLowerCase().includes('lite')) veoModel = 'veo3_lite';

            const hasImages = params.imageUrls && params.imageUrls.length > 0;
            
            // For veo3_lite, REFERENCE_2_VIDEO is not supported. Force TEXT_2_VIDEO.
            const generationType = (veoModel === 'veo3_lite') ? "TEXT_2_VIDEO" : (hasImages ? "REFERENCE_2_VIDEO" : "TEXT_2_VIDEO");

            payload = {
                prompt: params.prompt,
                imageUrls: params.imageUrls || [],
                model: veoModel,
                watermark: "CONVERSIO.AO",
                callBackUrl: `https://webhook.site/dummy-conversio-${Date.now()}`,
                aspect_ratio: params.aspectRatio || '16:9',
                enableFallback: false,
                enableTranslation: true,
                generationType: generationType
            };
        }

        console.log(`[KieAiNode] 🚀 Sending request to KIE.ai (${modelName}) @ ${endpoint}...`);
        try {
            const response = await axios.post(endpoint, payload, {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                timeout: 60000 // 60 seconds timeout
            });

            // Support both response formats:
            // Old: { success: true, data: { taskId } }
            // New: { code: 200, msg: "success", data: { taskId } }
            const taskId = response.data?.data?.taskId;
            const isSuccess = taskId && (
                response.data?.success === true ||
                response.data?.code === 200 ||
                response.data?.msg === 'success'
            );

            if (isSuccess) {
                console.log(`[KieAiNode] ✅ Task created: ${taskId}`);
                return taskId;
            }

            const apiMessage = response.data?.msg || response.data?.message || 'Falha ao criar tarefa no KIE.ai';
            console.error(`[KieAiNode] ❌ API Returned Failure: ${apiMessage}`);
            console.error('[KieAiNode] Full Response:', JSON.stringify(response.data, null, 2));
            console.error('[KieAiNode] Payload Sent:', JSON.stringify(payload, null, 2));
            
            // Debug file log
            try {
                fs.appendFileSync('kie_error_debug.json', JSON.stringify({
                    timestamp: new Date().toISOString(),
                    type: 'API_FAILURE',
                    model: modelName,
                    apiResponse: response.data,
                    usedKey: apiKey ? `${apiKey.substring(0, 5)}***` : 'NONE'
                }, null, 2) + '\n');
            } catch(e) {}

            // Log persistente para o administrador
            await query(
                `INSERT INTO agent_logs (agent_name, action, result, metadata) 
                 VALUES ($1, $2, $3, $4)`,
                ['KieAiNode', 'TASK_CREATION_FAILED', 'error', JSON.stringify({ 
                    message: apiMessage, 
                    apiResponse: response.data,
                    model: modelName
                })]
            ).catch(() => {});

            throw new Error(apiMessage);
        } catch (error: any) {
            const errorData = error.response?.data;
            const status = error.response?.status;
            
            console.error('[KieAiNode] ❌ HTTP Error in createTask:', {
                status: status,
                data: errorData,
                message: error.message,
                usedKey: apiKey ? `${apiKey.substring(0, 5)}***` : 'NONE'
            });

            // Report failure to KeyManager if it's an auth error or rate limit
            if (status === 401 || status === 403 || status === 429) {
                try {
                    const { keyManager } = await import('../../services/KeyManager.js');
                    // We need the key ID, but we only have the key string here. 
                    // KeyManager should probably handle reporting by key string or we look it up.
                    // For now, we'll log it clearly.
                    console.warn(`[KieAiNode] ⚠️ Critical Auth/Rate Error with key ${apiKey.substring(0, 5)}***`);
                } catch(e) {}
            }

            // Debug file log for HTTP error
            try {
                fs.appendFileSync('kie_error_debug.json', JSON.stringify({
                    timestamp: new Date().toISOString(),
                    type: 'HTTP_ERROR',
                    status: status,
                    errorData,
                    message: error.message,
                    model: modelName
                }, null, 2) + '\n');
            } catch(e) {}
            
            throw new Error(errorData?.message || error.message || 'Erro na comunicação com KIE.ai');
        }
    }

    /**
     * Polls the job status until it's finished or timed out
     */
    static async pollJobStatus(taskId: string, intervalSeconds: number = 10, timeoutMinutes: number = 5, apiKey?: string, isVeo: boolean = false, isSuno: boolean = false): Promise<string> {
        if (!apiKey) throw new Error('[KieAiNode] ❌ No API Key provided for KIE.ai polling.');
        console.log(`[KieAiNode] Starting poll for task: ${taskId} (isVeo: ${isVeo}, isSuno: ${isSuno})`);
        
        const startTime = Date.now();
        const timeoutMs = timeoutMinutes * 60 * 1000;
        const isVeoTask = isVeo || taskId.toLowerCase().startsWith('veo');

        while (Date.now() - startTime < timeoutMs) {
            try {
                let endpoint = isVeoTask ? `${BASE_URL}/veo/record-info` : (isSuno ? `${BASE_URL}/generate/record-info` : `${BASE_URL}/jobs/recordInfo`);
                let queryParams: any = { taskId };
                
                const response = await axios.get(endpoint, {
                    params: queryParams,
                    headers: {
                        'Authorization': `Bearer ${apiKey}`
                    }
                });

                const data = response.data?.data;
                if (!data) {
                    console.warn(`[KieAiNode] ⚠️ No data returned for ${taskId} from ${endpoint}. Full response:`, JSON.stringify(response.data));
                    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
                    continue;
                }

                if (isVeoTask) {
                    // Veo Status (User Format): successFlag=1 means success
                    const successFlag = data.successFlag;
                    const errorCode = data.errorCode;
                    
                    console.log(`[KieAiNode] Veo Task ${taskId} successFlag: ${successFlag}`);

                    if (successFlag === 1) {
                        const videoResponse = data.response;
                        const resultUrls = videoResponse?.resultUrls || videoResponse?.fullResultUrls;
                        
                        if (Array.isArray(resultUrls) && resultUrls.length > 0) {
                            return resultUrls[0];
                        }
                        
                        // Fallback to resultUrls string parsing if needed
                        const info = data.info;
                        const resultUrlsStr = info?.resultUrls;
                        if (resultUrlsStr) {
                            try {
                                const urls = typeof resultUrlsStr === 'string' ? JSON.parse(resultUrlsStr.replace(/'/g, '"')) : resultUrlsStr;
                                if (Array.isArray(urls) && urls.length > 0) return urls[0];
                            } catch (e) {}
                        }
                        throw new Error('Vídeo concluído mas URL não encontrado na estrutura response.resultUrls.');
                    } else if (errorCode && errorCode !== null) {
                        throw new Error(data.errorMessage || `Geração de vídeo Veo falhou com erro: ${errorCode}`);
                    }
                    // If successFlag is not 1 and no errorCode, it's likely still processing
                } else {
                    const rawState = data.state || data.status;
                    const state = rawState ? rawState.toLowerCase() : (data.audio_url ? 'success' : null);
                    console.log(`[KieAiNode] Task ${taskId} status: ${state}`);

                    if (state === 'success' || state === 'completed' || data.audio_url) {
                        // For Suno dedicated endpoint, result is often in data.response.sunoData[0].audioUrl
                        const sunoData = data.response?.sunoData;
                        const audioUrl = (Array.isArray(sunoData) && sunoData.length > 0) ? sunoData[0].audioUrl : (data.audio_url || data.audio_urls?.[0]);
                        
                        if (audioUrl) return audioUrl;

                        // Fallback to resultJson parsing
                        if (data.resultJson) {
                            const resultJson = typeof data.resultJson === 'string' ? JSON.parse(data.resultJson) : data.resultJson;
                            const resultUrl = resultJson.resultUrls?.[0] || resultJson.audioUrls?.[0] || resultJson.audio_url;
                            if (resultUrl) return resultUrl;
                        }
                        
                        throw new Error('Tarefa concluída mas URL do áudio não encontrada.');
                    }

                    if (state === 'failed' || state === 'error') {
                        throw new Error(data.errorMessage || 'Tarefa falhou no KIE.ai');
                    }
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
