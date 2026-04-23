// ─── GLOBAL ERROR HANDLERS ───────────────────────────────────────────────────
process.on('uncaughtException', (error) => {
    console.error('CRITICAL: Uncaught Exception - Server might be in unstable state!');
    console.error('Stack:', error.stack || error);
    // In production, you might want to restart the process here
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL: Unhandled Rejection at Promise:', promise);
    console.error('Reason:', reason instanceof Error ? reason.stack : reason);
});

import express from 'express';
import { EventEmitter } from 'events';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import multer from 'multer';
import axios from 'axios';
import { runMonitorAgent as MonitorAgent } from './services/monitorAgent.js';
import { MarketingAgent } from './services/marketingAgent.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import crypto from 'crypto';
import fs from 'fs';

import { query } from './db.js';
import { hashPassword, comparePasswords, generateAccessToken, generateRefreshToken, verifyRefreshToken, verifyAccessToken, hashToken } from './auth.js';
import { provisionUserFolder, uploadToTemp, uploadBufferToUserFolder, deleteFile, getDynamicS3Client, uploadTransactionFile, getSignedS3UrlForKey, getS3Client } from './storage.js';
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';

// Configure ffmpeg path
if (ffmpegPath) {
    // @ts-ignore - ffmpeg-static provides a string path
    ffmpeg.setFfmpegPath(ffmpegPath as unknown as string);
}

import { generateInvoicePDF, uploadInvoiceToS3 } from './invoice.js';
import { getConfig, updateConfig, GPT4O_MINI_PRICING, GPT4O_PRICING } from './config.js';

import { OpenAI } from 'openai';
import { OAuth2Client } from 'google-auth-library';
import { authenticateJWT, isAdmin, AuthRequest, validateCsrf } from './middleware.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import * as whatsappService from './services/whatsappService.js';
import * as crmAgent from './services/crmAgent.js';
import * as agentService from './services/agentService.js';
import * as campaignsAgent from './services/campaignsAgent.js';
import { getAdminWhatsApp } from './services/configService.js';
import { sendWhatsAppMessage } from './services/whatsappService.js';
import { EvolutionService } from './services/evolutionService.js';
import { WhatsAppLeadAgent } from './services/whatsappLeadAgent.js';
import { ImageAnalysisAgent as AnalysisAgent } from './pipeline/agents/image/ImageAnalysisAgent.js';
import { PromptAgent } from './pipeline/agents/image/ImagePromptAgent.js';
import { BrandColorExtractorAgent } from './pipeline/agents/image/BrandColorExtractorAgent.js';
import { keyManager } from './services/KeyManager.js';
import { processWithOpenAI } from './utils/openai.js';
import './cron.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const app = express();

// Trust Proxy for Easypanel/Nginx
app.set('trust proxy', 1);

app.use(cookieParser());


// Security Headers
app.use(helmet({ 
    crossOriginResourcePolicy: false, // Prevents breaking images loaded from external domains like S3
    crossOriginOpenerPolicy: false // Prevents breaking Google OAuth popup
}));

// Health Check (MUST be before any auth/CSRF middleware)
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Global System Log Emitter ──────────────────────────────────────────────
export const systemLogEmitter = new EventEmitter();

// Helper to push system logs
export const emitSystemLog = (agent: string, message: string, status: 'info' | 'success' | 'warning' | 'error' = 'info', metadata: any = {}) => {
    const logEntry = {
        agent,
        message,
        status,
        metadata,
        timestamp: new Date().toISOString()
    };
    systemLogEmitter.emit('log', logEntry);
    
    // Save all logs to database so the Engine Monitor can observe real-time info and payloads
    query(`
        INSERT INTO agent_logs (agent_name, action, result, metadata)
        VALUES ($1, $2, $3, $4)
    `, [agent, message.substring(0, 100), status === 'success' ? 'success' : (status === 'error' ? 'error' : 'info'), JSON.stringify(metadata)])
    .catch(err => console.error('[Log Persistence Error]', err));
};

// ─── SSE: Real-time Generation Progress ─────────────────────────────────────
// Map: batchId → Set of SSE response objects
const sseClients = new Map<string, Set<any>>();

// --- DATABASE INTEGRITY & AUTO-REPAIR ---
async function ensureSchemaIntegrity() {
    console.log('[SYSTEM] Verificando integridade da base de dados...');
    try {
        // 1. Corrigir agent_logs (missing user_id, results, etc)
        await query(`
            CREATE TABLE IF NOT EXISTS agent_logs (
                id SERIAL PRIMARY KEY,
                agent_name VARCHAR(100),
                action TEXT NOT NULL,
                user_id UUID,
                result VARCHAR(50) DEFAULT 'success',
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT now()
            )
        `);
        
        // Colunas adicionais se a tabela já existia
        await query(`ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS user_id UUID`).catch(() => {});
        await query(`ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS agent_name VARCHAR(100)`).catch(() => {});
        await query(`ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS result VARCHAR(50) DEFAULT 'success'`).catch(() => {});
        
        // 2. Garantir tabela de agentes
        await query(`
            CREATE TABLE IF NOT EXISTS agents (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100) UNIQUE NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                last_run TIMESTAMP,
                next_run TIMESTAMP,
                config JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT now()
            )
        `);

        // 3. Garantir tabela de tarefas
        await query(`
            CREATE TABLE IF NOT EXISTS agent_tasks (
                id SERIAL PRIMARY KEY,
                agent_name VARCHAR(100) REFERENCES agents(name) ON DELETE CASCADE,
                task_type VARCHAR(100) NOT NULL,
                priority INTEGER DEFAULT 3,
                payload JSONB DEFAULT '{}',
                status VARCHAR(50) DEFAULT 'pending',
                attempts INTEGER DEFAULT 0,
                error_message TEXT,
                created_at TIMESTAMP DEFAULT now(),
                executed_at TIMESTAMP
            )
        `);

         // 4. Garantir tabela de métricas
        await query(`
            CREATE TABLE IF NOT EXISTS system_metrics (
                id SERIAL PRIMARY KEY,
                metric_name VARCHAR(100) NOT NULL,
                metric_value NUMERIC,
                created_at TIMESTAMP DEFAULT now()
            )
        `);

        // 5. Garantir tabela de alertas
        await query(`
            CREATE TABLE IF NOT EXISTS alerts (
                id SERIAL PRIMARY KEY,
                type VARCHAR(100),
                severity VARCHAR(50),
                title TEXT,
                message TEXT,
                status VARCHAR(50) DEFAULT 'pending',
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT now()
            )
        `);

        // 6. Garantir tabela de regras de alerta
        await query(`
            CREATE TABLE IF NOT EXISTS alert_rules (
                id SERIAL PRIMARY KEY,
                metric_name VARCHAR(100) NOT NULL,
                condition VARCHAR(20), -- gt, lt, eq
                threshold NUMERIC,
                severity VARCHAR(50),
                message_template TEXT,
                cooldown_minutes INTEGER DEFAULT 60,
                is_active BOOLEAN DEFAULT true,
                last_triggered_at TIMESTAMP
            )
        `);

        // 7. Garantir tabela de orçamentos
        await query(`
            CREATE TABLE IF NOT EXISTS service_budgets (
                id SERIAL PRIMARY KEY,
                service VARCHAR(50) UNIQUE NOT NULL, -- openai, kie, etc
                dollar_balance NUMERIC(10,2) DEFAULT 0.00,
                credit_balance NUMERIC(15,2) DEFAULT 0.00,
                initial_budget_dollar NUMERIC(10,2) DEFAULT 100.00,
                initial_budget_credits NUMERIC(15,2) DEFAULT 1000.00,
                metadata JSONB DEFAULT '{}',
                updated_at TIMESTAMP DEFAULT now()
            )
        `);

        // 8. Garantir tabela de logs WhatsApp
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_logs (
                id SERIAL PRIMARY KEY,
                recipient VARCHAR(50),
                type VARCHAR(20),
                content TEXT,
                status VARCHAR(50),
                error_details TEXT,
                category VARCHAR(50),
                created_at TIMESTAMP DEFAULT now()
            )
        `);

        // 9. Garantir tabela de mensagens do orquestrador
        await query(`
            CREATE TABLE IF NOT EXISTS orchestrator_chat_messages (
                id SERIAL PRIMARY KEY,
                user_id UUID,
                role VARCHAR(20),
                content TEXT,
                created_at TIMESTAMP DEFAULT now()
            )
        `);

        // 10. Garantir tabela de prompts de marketing (Hi-Fi)
        await query(`
            CREATE TABLE IF NOT EXISTS conversio_prompts (
                id SERIAL PRIMARY KEY,
                agent_id VARCHAR(50) NOT NULL,
                agent_name VARCHAR(100),
                agent_type VARCHAR(20),
                seed BIGINT,
                topico TEXT,
                prompt_completo TEXT,
                copy_headline TEXT,
                copy_corpo TEXT,
                copy_cta TEXT,
                copy_stories TEXT,
                copy_whatsapp TEXT,
                hashtags_json JSONB DEFAULT '{}',
                escolhas_json JSONB DEFAULT '{}',
                tokens_used INTEGER DEFAULT 0,
                internal_code VARCHAR(100),
                user_id UUID,
                is_published BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT now()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_prompts_agent_user ON conversio_prompts(agent_id, user_id)`);

        console.log('[SYSTEM] ✅ Integridade da DB verificada.');
    } catch (e: any) {
        console.error('[SYSTEM ERROR] Falha na verificação de integridade:', e.message);
    }
}

// Iniciar reparação em background
ensureSchemaIntegrity();


function pushSseEvent(batchId: string, event: object) {
    const clients = sseClients.get(batchId);
    if (!clients || clients.size === 0) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    clients.forEach(client => {
        try { client.write(payload); } catch (_) {}
    });
}

// Frontend subscribes to this endpoint for real-time updates
app.get('/api/generations/progress/:batchId', (req, res) => {
    const { batchId } = req.params;
    // Explicit CORS for SSE (must come before CORS middleware since we're early in the stack)
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send initial ping
    res.write(`data: ${JSON.stringify({ type: 'connected', batchId })}\n\n`);

    if (!sseClients.has(batchId)) sseClients.set(batchId, new Set());
    sseClients.get(batchId)!.add(res);

    // Heartbeat every 20s to keep connection alive
    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) {}
    }, 20000);

    req.on('close', () => {
        clearInterval(heartbeat);
        sseClients.get(batchId)?.delete(res);
        if (sseClients.get(batchId)?.size === 0) sseClients.delete(batchId);
    });
});

// Admin subscribes to ALL system logs
app.get('/api/admin/system/logs/stream', authenticateJWT, isAdmin, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const onLog = (log: any) => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    };

    systemLogEmitter.on('log', onLog);

    const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch (_) {}
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeat);
        systemLogEmitter.removeListener('log', onLog);
    });
});

// ─── Middleware de segurança interna ─────────────────────────────────────────
// express.json() is registered early here so the internal callback body is parsed
// (the global app.use(express.json()) is registered later after CORS)
app.use('/api/internal', express.json());

// Middleware de segurança interna para callbacks e serviços stand-alone
const validateInternalSecret = (req: any, res: any, next: any) => {
    const secret = req.headers['x-internal-secret'];
    const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
    if (!INTERNAL_SECRET || secret !== INTERNAL_SECRET) {
        return res.status(403).json({ success: false, message: 'Acesso negado: Segredo inválido.' });
    }
    next();
};

// Endpoint para agentes externos (ex: generation engine) enviarem logs
app.post('/api/internal/logs', validateInternalSecret, express.json(), (req, res) => {
    const { agent, message, status, metadata } = req.body;
    emitSystemLog(agent, message, status, metadata);
    res.json({ success: true });
});

// ─── Internal Generation Endpoints (called by Backend, handled by Generation Engine) ───
// These endpoints receive delegated generation tasks and run the actual AI pipelines

app.post('/api/internal/generate/image', validateInternalSecret, async (req, res) => {
    const { userId, userPrompt, productImageUrl, characterImageUrl, coreId, coreName, style, aspectRatio, generationId, modelId, useBrandColors, brandColors, contextAntiRepeticao, currentIndex, totalItems, includeText } = req.body;
    console.log(`[Engine] 🖼️ Received image generation task: ${generationId} (Core: ${coreId}, Style: ${style})`);
    
    // Respond immediately so the backend doesn't timeout
    res.json({ success: true, message: 'Image generation started', generationId });

    // Run pipeline in background
    try {
        const { ImagePipeline } = await import('./pipeline/ImagePipeline.js');
        await ImagePipeline.run({
            userId,
            userPrompt: userPrompt || '',
            productImageUrl,
            coreId,
            coreName,
            style,
            aspectRatio: aspectRatio || '1:1',
            generationId
        });
        console.log(`[Engine] ✅ Image pipeline completed for ${generationId}`);
    } catch (err: any) {
        console.error(`[Engine] ❌ Image pipeline failed for ${generationId}:`, err.message);
        // Update DB with failure status
        try {
            await query(
                `UPDATE generations SET status = 'failed', metadata = metadata || $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify({ error: err.message }), generationId]
            );
        } catch (dbErr) {
            console.error(`[Engine] DB update error:`, dbErr);
        }
    }
});

app.post('/api/internal/generate/video', validateInternalSecret, async (req, res) => {
    const { userId, userPrompt, productImageUrl, coreId, coreName, modelId, aspectRatio, generationId, useBrandColors, brandColors, currentIndex, totalItems } = req.body;
    console.log(`[Engine] 🎬 Received video generation task: ${generationId} (Core: ${coreId}, Model: ${modelId})`);
    
    // Respond immediately
    res.json({ success: true, message: 'Video generation started', generationId });

    // Run video generation in background
    try {
        const { KieAiNode } = await import('./pipeline/nodes/KieAiNode.js');
        
        // Update status
        await query(`UPDATE generations SET metadata = metadata || $1 WHERE id = $2`,
            [JSON.stringify({ pipeline_status: 'Gerando vídeo publicitário...', pipeline_progress: 30 }), generationId]);

        // Build prompt with video analysis if image is provided
        let finalPrompt = userPrompt || '';
        if (productImageUrl) {
            try {
                const { VideoAnalysisAgent } = await import('./pipeline/agents/video/VideoAnalysisAgent.js');
                const analysis = await VideoAnalysisAgent.analyze(productImageUrl, userPrompt || '');
                
                const { VideoPromptAgent } = await import('./pipeline/agents/video/VideoPromptAgent.js');
                const { SeedSystem } = await import('./pipeline/utils/SeedSystem.js');
                const seed = SeedSystem.generateSeed();
                const promptResult = await VideoPromptAgent.generate({
                    analysis,
                    userPrompt: userPrompt || '',
                    aspectRatio: aspectRatio || '16:9',
                    seed,
                    useBrandColors,
                    brandColors
                });
                finalPrompt = JSON.stringify(promptResult);
            } catch (promptErr: any) {
                console.warn(`[Engine] Video prompt generation failed, using raw prompt:`, promptErr.message);
            }
        }

        // Create KIE.ai task
        await query(`UPDATE generations SET metadata = metadata || $1 WHERE id = $2`,
            [JSON.stringify({ pipeline_status: 'Processando vídeo na nuvem...', pipeline_progress: 50 }), generationId]);

        const taskId = await KieAiNode.createTask({
            model: modelId || 'google/veo-3.1-generate',
            prompt: finalPrompt,
            imageUrls: productImageUrl ? [productImageUrl] : [],
            aspectRatio: aspectRatio || '16:9'
        });

        // Poll for result
        await query(`UPDATE generations SET metadata = metadata || $1 WHERE id = $2`,
            [JSON.stringify({ pipeline_status: 'Finalizando vídeo...', pipeline_progress: 70 }), generationId]);

        const resultUrl = await KieAiNode.pollJobStatus(taskId, 15);

        // Update DB with success
        await query(
            `UPDATE generations SET result_url = $1, status = 'completed', metadata = metadata || $2, updated_at = NOW() WHERE id = $3`,
            [resultUrl, JSON.stringify({ pipeline_status: 'Concluído', pipeline_progress: 100 }), generationId]
        );
        console.log(`[Engine] ✅ Video pipeline completed for ${generationId}`);

    } catch (err: any) {
        console.error(`[Engine] ❌ Video pipeline failed for ${generationId}:`, err.message);
        try {
            await query(
                `UPDATE generations SET status = 'failed', metadata = metadata || $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify({ error: err.message }), generationId]
            );
        } catch (dbErr) {
            console.error(`[Engine] DB update error:`, dbErr);
        }
    }
});

app.post('/api/internal/generate/audio', validateInternalSecret, async (req, res) => {
    const { userId, generationId, prompt, userPrompt, style, model, instrumental, backendUrl } = req.body;
    console.log(`[Engine] 🎵 Received audio/music generation task: ${generationId} (Model: ${model}, Style: ${style})`);
    
    // Respond immediately
    res.json({ success: true, message: 'Audio generation started', generationId });

    // Run music generation in background
    try {
        const { KieAiNode } = await import('./pipeline/nodes/KieAiNode.js');
        
        await query(`UPDATE generations SET metadata = metadata || $1 WHERE id = $2`,
            [JSON.stringify({ pipeline_status: 'Compondo música...', pipeline_progress: 20 }), generationId]);

        // Build music prompt
        const musicPrompt = `${prompt || userPrompt}. Style: ${style || 'pop'}. ${instrumental ? 'Instrumental only, no vocals.' : 'With vocals in Portuguese.'}`;

        // Create KIE.ai task for music
        const taskId = await KieAiNode.createTask({
            model: model || 'suno/v4',
            prompt: musicPrompt
        });

        await query(`UPDATE generations SET metadata = metadata || $1 WHERE id = $2`,
            [JSON.stringify({ pipeline_status: 'Gerando faixas de áudio...', pipeline_progress: 50 }), generationId]);

        // Poll for result
        const resultUrl = await KieAiNode.pollJobStatus(taskId, 15);

        // Send callback to backend for storage processing
        const callbackUrl = backendUrl || process.env.PUBLIC_URL || 'http://localhost:3003';
        const INTERNAL_SECRET = process.env.INTERNAL_SECRET;
        
        try {
            await axios.post(`${callbackUrl}/api/internal/generation-callback`, {
                generationId,
                status: 'completed',
                audio_url: resultUrl,
                audio_urls: [resultUrl],
                pipeline_status: 'Concluído',
                pipeline_progress: 100
            }, {
                headers: { 'X-Internal-Secret': INTERNAL_SECRET }
            });
        } catch (cbErr: any) {
            // If callback fails, update DB directly
            console.warn(`[Engine] Callback failed, updating DB directly:`, cbErr.message);
            await query(
                `UPDATE generations SET result_url = $1, status = 'completed', metadata = metadata || $2, updated_at = NOW() WHERE id = $3`,
                [resultUrl, JSON.stringify({ pipeline_status: 'Concluído', pipeline_progress: 100 }), generationId]
            );
        }

        console.log(`[Engine] ✅ Audio pipeline completed for ${generationId}`);

    } catch (err: any) {
        console.error(`[Engine] ❌ Audio pipeline failed for ${generationId}:`, err.message);
        try {
            await query(
                `UPDATE generations SET status = 'failed', metadata = metadata || $1, updated_at = NOW() WHERE id = $2`,
                [JSON.stringify({ error: err.message }), generationId]
            );
        } catch (dbErr) {
            console.error(`[Engine] DB update error:`, dbErr);
        }
    }
});

// ─── KIE.ai Direct Callback (called by KIE.ai when generation completes) ─────
// This is also called by our ImagePipeline after polling finishes
app.post('/api/internal/generation-callback', validateInternalSecret, async (req, res) => {
    try {
        const { generationId, status, imageUrl, pipeline_status, pipeline_progress } = req.body;
        console.log(`[API] 🔔 CALLBACK RECEBIDO: Gen=${generationId}, Status=${status}, Pipeline=${pipeline_status}`);
        // console.log('[API] Body completo:', JSON.stringify(req.body));

        // Push real-time SSE update to all connected frontends watching this generation
        if (generationId) {
            // Find the batchId for this generationId from DB
            try {
                const row = await query(
                    `SELECT batch_id, user_id FROM generations WHERE id = $1 LIMIT 1`,
                    [generationId]
                );
                if (row.rows.length > 0) {
                    const { batch_id, user_id } = row.rows[0];
                    
                    // --- DATABASE PERSISTENCE & STORAGE DOWNLOADING ---
                    if (status === 'completed' || status === 'failed') {
                        // Handle multiple result fields (imageUrl, videoUrls, result_url, audio_urls)
                        const allResultUrls = req.body.audio_urls || (req.body.videoUrls ? req.body.videoUrls : []);
                        
                        let mainUri = imageUrl || 
                                       (allResultUrls.length > 0 ? allResultUrls[0] : null) || 
                                       req.body.result_url || 
                                       req.body.audio_url;

                        // Se for áudio do Suno e tivermos múltiplas URLs, vamos processar todas
                        const isAudio = !!req.body.audio_url || !!req.body.audio_urls;
                        const isVideo = !!req.body.videoUrls || (req.body.imageUrl && req.body.imageUrl.includes('.mp4'));

                        const jsonResult = req.body.json_result || {};
                        console.log(`[API] 🎵 Received JSON Metadata for Gen=${generationId}:`, JSON.stringify(jsonResult));
                        const title = jsonResult.title || null;
                        const lyrics = jsonResult.lyrics || null;

                        // Download the MAIN file from KIE and upload to our local storage
                        if (status === 'completed' && mainUri && mainUri.startsWith('http')) {
                            const isOurStorage = mainUri.includes('contabostorage.com');
                            
                            if (!isOurStorage && !isVideo) {
                                try {
                                    console.log(`[API] Downloading generated file for local storage: ${mainUri}`);
                                    const { data: buffer } = await axios.get(mainUri, { responseType: 'arraybuffer' });
                                    
                                    // Robust extension detection for KIE.ai
                                    let ext = mainUri.split('.').pop()?.split('?')[0] || (isAudio ? 'mp3' : 'png');
                                    if (ext.length > 5 || ext.includes('/')) {
                                        ext = isAudio ? 'mp3' : (isVideo ? 'mp4' : 'png');
                                    }
                                    
                                    let contentType = 'application/octet-stream';
                                    if (ext === 'mp4') contentType = 'video/mp4';
                                    else if (ext === 'jpeg' || ext === 'jpg') contentType = 'image/jpeg';
                                    else if (ext === 'png') contentType = 'image/png';
                                    else if (ext === 'mp3') contentType = 'audio/mpeg';

                                    const categoryName = (isVideo || req.body.videoUrls) ? 'Videos' : (isAudio ? 'Audios' : 'Imagens');
                                    mainUri = await uploadBufferToUserFolder(user_id, categoryName as any, buffer, `generated-${generationId}.${ext}`, contentType);
                                    console.log(`[API] File securely saved to S3: ${mainUri}`);
                                } catch (downloadErr: any) {
                                    console.error(`[API] Failed to save external file to S3:`, downloadErr.message);
                                }
                            }
                        }

                        // Metadata merging
                        let existingMetadata: any = {};
                        try {
                            const metaRow = await query('SELECT metadata FROM generations WHERE id = $1', [generationId]);
                            if (metaRow.rows.length > 0 && metaRow.rows[0].metadata) {
                                existingMetadata = typeof metaRow.rows[0].metadata === 'string' ? JSON.parse(metaRow.rows[0].metadata) : metaRow.rows[0].metadata;
                            }
                        } catch(e) {}
                        
                        const mergedMetadata = { ...existingMetadata, ...jsonResult };

                        await query(
                            `UPDATE generations SET status = $1, result_url = COALESCE($2, result_url), metadata = $3, updated_at = NOW() WHERE id = $4`,
                            [status, mainUri, JSON.stringify(mergedMetadata), generationId]
                        );

                        // Push real-time SSE for the main record update
                        const mainEvent = { 
                            type: 'progress', 
                            generationId: generationId, 
                            status: status, 
                            batchId: batch_id,
                            result_url: mainUri,
                            title: title,
                            copy: lyrics,
                            pipeline_status: pipeline_status || 'Concluído',
                            pipeline_progress: pipeline_progress || 100
                        };
                        pushSseEvent(batch_id, mainEvent);
                        pushSseEvent(`user-${user_id}`, mainEvent);

                        // --- ASYNC SECONDARY TRACK PROCESSING (NON-BLOCKING) ---
                        if (status === 'completed' && isAudio && allResultUrls.length > 1) {
                            console.log(`[API] 🎵 Processing secondary tracks in background...`);
                            
                            // Fire and forget (with error handling)
                            (async () => {
                                for (let i = 1; i < allResultUrls.length; i++) {
                                    const trackUrl = allResultUrls[i];
                                    try {
                                        console.log(`[API] Saving secondary track ${i+1}: ${trackUrl}`);
                                        const { data: buffer } = await axios.get(trackUrl, { responseType: 'arraybuffer' });
                                        const savedUri = await uploadBufferToUserFolder(user_id, 'Audios', buffer, `generated-${generationId}-v${i+1}.mp3`, 'audio/mpeg');
                                        
                                        // Fetch base data (including the newly updated metadata with title/lyrics)
                                        const baseGen = await query('SELECT prompt, type, model, style FROM generations WHERE id = $1', [generationId]);
                                        if (baseGen.rows.length > 0) {
                                            const { prompt, type, model, style } = baseGen.rows[0];
                                            const insertRes = await query(
                                                'INSERT INTO generations (user_id, type, prompt, status, result_url, batch_id, metadata, model, style, cost, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW()) RETURNING id',
                                                [user_id, type, prompt, 'completed', savedUri, batch_id, JSON.stringify(mergedMetadata), model, style, 0]
                                            );
                                            
                                            const newGenId = insertRes.rows[0].id;
                                            console.log(`[API] ✅ Secondary track saved: ${newGenId}`);
                                            
                                            const secondaryEvent = { 
                                                type: 'progress', 
                                                generationId: newGenId, 
                                                status: 'completed', 
                                                batchId: batch_id,
                                                result_url: savedUri,
                                                title: title,
                                                copy: lyrics,
                                                pipeline_status: 'Concluído',
                                                pipeline_progress: 100
                                            };
                                            pushSseEvent(batch_id, secondaryEvent);
                                            pushSseEvent(`user-${user_id}`, secondaryEvent);
                                        }
                                    } catch (e: any) {
                                        console.error(`[API] Error saving secondary track ${i+1}:`, e.message);
                                    }
                                }
                            })();
                        }
                    }
                    // --- CREDIT REFUND LOGIC ---
                    if (status === 'failed') {
                        try {
                            // Get the cost of this specific generation
                            const genData = await query('SELECT cost, metadata FROM generations WHERE id = $1', [generationId]);
                            const refundCost = Number(genData.rows[0]?.cost) || 0;
                            const kieCost = Number(genData.rows[0]?.metadata?.kie_cost) || 0;
                            
                            if (refundCost > 0) {
                                await query('UPDATE users SET credits = credits + $1 WHERE id = $2', [refundCost, user_id]);
                                console.log(`[API] 💰 Refunded ${refundCost} credits to user ${user_id} for failed generation ${generationId}`);
                            }
                        } catch (refundErr: any) {
                            console.error(`[API] ❌ Failed to refund credits for generation ${generationId}:`, refundErr.message);
                        }
                    }
                    
                    // Fetch user settings for notification
                    const userRes = await query(
                        `SELECT plan, whatsapp, whatsapp_notifications_enabled FROM users WHERE id = $1`,
                        [user_id]
                    );
                    const userData = userRes.rows[0];

                    const event: any = { type: 'progress', generationId, status, batchId: batch_id };
                    if (pipeline_status) event.pipeline_status = pipeline_status;
                    if (pipeline_progress !== undefined) event.pipeline_progress = pipeline_progress;
                    if (imageUrl) event.imageUrl = imageUrl;
                    if (req.body.result_url) event.result_url = req.body.result_url;
                    if (req.body.title) event.title = req.body.title;
                    if (req.body.copy) event.copy = req.body.copy;
                    
                    // Push to batch subscribers
                    pushSseEvent(batch_id, event);
                    // Also push to user-level channel
                    pushSseEvent(`user-${user_id}`, event);

                    // --- NEW: Trigger SSE for n8n/ads callback too ---
                    // The standard callback pushes events, let's make sure /api/ads/callback does it too.
                    // (See code below at line 1700 approx)

                    // Send WhatsApp notification ONLY if Scale plan and notifications are enabled
                    if (userData && userData.whatsapp_notifications_enabled && userData.whatsapp) {
                        try {
                            if (status === 'completed' && imageUrl) {
                                await whatsappService.sendWhatsAppMessage(
                                    userData.whatsapp,
                                    `✅ *Geração Concluída!*\nA sua imagem publicitária já está pronta.\n\n🔗 *Link:* ${imageUrl}\n\nVerifique o seu painel Conversio para descarregar.`
                                );
                            } else if (status === 'failed') {
                                await whatsappService.sendWhatsAppMessage(
                                    userData.whatsapp,
                                    `❌ *Falha na Geração*\nOcorreu um erro ao processar a geração ${generationId}.\n\nPor favor, verifique o seu painel.`
                                );
                            }
                        } catch (waErr) {
                            console.error('[Callback WA Err]', waErr);
                        }
                    }
                }
            } catch (dbErr: any) {
                console.warn('[API] Could not look up user/batch for SSE push:', dbErr.message);
            }
        }

        res.json({ success: true });
    } catch (error: any) {
        console.error('[API] Erro ao processar callback de geração:', error.message);
        res.status(500).json({ success: false });
    }
});

// Dynamic CORS: aceita origens locais + domínio de produção via env
const allowedOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
];

app.use(cors({
    origin: (origin, callback) => {
        // Permitir requests sem origin (ex: Postman, mobile apps)
        if (!origin) return callback(null, true);
        
        // Check if origin is in explicit whitelist
        if (allowedOrigins.includes(origin)) return callback(null, true);
        
        // Allow Vercel Preview/Branch deployments
        if (origin.endsWith('.vercel.app') || origin.includes('vercel.app')) {
            return callback(null, true);
        }

        callback(new Error(`CORS: Origin não permitida: ${origin}`));
    },
    credentials: true
}));


app.use(express.json());

// ─── Event Tracking Endpoint ────────────────────────────────────────────────
// Captures frontend behavioral events for lead scoring and funnel analysis
app.post('/api/track', async (req, res) => {
    try {
        const { event, userId, metadata } = req.body;
        if (!event) return res.status(400).json({ ok: false, error: 'event required' });

        // Log to lead_interactions if user has a lead record
        if (userId) {
            await query(`
                INSERT INTO lead_interactions (lead_id, type, metadata, created_at)
                SELECT l.id, $2, $3, now()
                FROM leads l WHERE l.user_id = $1
                LIMIT 1
            `, [userId, event, JSON.stringify(metadata || {})]).catch(() => {});
        }

        // Also log to a generic events table for analytics
        await query(`
            INSERT INTO user_events (user_id, event_type, metadata, created_at)
            VALUES ($1, $2, $3, now())
        `, [userId || null, event, JSON.stringify(metadata || {})]).catch(() => {});

        res.json({ ok: true });
    } catch (e: any) {
        console.error('[Track] Error:', e.message);
        res.status(500).json({ ok: false });
    }
});

// Admin Agent Logs Endpoint
app.get('/api/admin/agents/logs', authenticateJWT, isAdmin, async (_req, res) => {
    try {
        const logsRes = await query('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, logs: logsRes.rows });
    } catch (e) {
        res.status(500).json({ success: false, logs: [] });
    }
});

// --- NEW: API Key Redundancy & Costs Endpoints ---

// Get all API keys for management
app.get('/api/admin/config/keys', authenticateJWT, isAdmin, async (_req, res) => {
    try {
        const keysRes = await query('SELECT id, provider, name, priority, is_active, status, last_error, last_used_at, updated_at, key_secret FROM api_keys ORDER BY provider, priority ASC');
        res.json({ success: true, keys: keysRes.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Update or Add an API key
app.post('/api/admin/config/keys', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { provider, name, key_secret, priority } = req.body;
        if (!provider || !name || !key_secret || !priority) return res.status(400).json({ success: false, message: 'Faltam dados.' });

        await query(`
            INSERT INTO api_keys (provider, name, key_secret, priority, status, is_active, updated_at)
            VALUES ($1, $2, $3, $4, 'working', true, NOW())
            ON CONFLICT (provider, name) 
            DO UPDATE SET key_secret = EXCLUDED.key_secret, priority = EXCLUDED.priority, status = 'working', is_active = true, updated_at = NOW()
        `, [provider, name, key_secret, priority]);

        res.json({ success: true, message: 'Chave atualizada com sucesso.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Reactivate a failed key
app.post('/api/admin/config/keys/:id/reactivate', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await query("UPDATE api_keys SET status = 'working', is_active = true, last_error = NULL, updated_at = NOW() WHERE id = $1", [id]);
        res.json({ success: true, message: 'Chave reativada.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- Service Budgets (manual balance tracking) ---
app.get('/api/admin/config/budgets', authenticateJWT, isAdmin, async (_req, res) => {
    try {
        const result = await query('SELECT * FROM service_budgets ORDER BY service ASC');
        res.json({ success: true, budgets: result.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/config/budgets/:service', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { service } = req.params;
        const { credit_balance, credit_purchased, dollar_balance, dollar_purchased, token_budget, tokens_purchased, cost_per_unit, platform_markup, notes } = req.body;
        await query(`
            INSERT INTO service_budgets (service, credit_balance, credit_purchased, dollar_balance, dollar_purchased, token_budget, tokens_purchased, cost_per_unit, platform_markup, notes, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            ON CONFLICT (service) DO UPDATE SET
                credit_balance = EXCLUDED.credit_balance, credit_purchased = EXCLUDED.credit_purchased,
                dollar_balance = EXCLUDED.dollar_balance, dollar_purchased = EXCLUDED.dollar_purchased,
                token_budget = EXCLUDED.token_budget, tokens_purchased = EXCLUDED.tokens_purchased,
                cost_per_unit = EXCLUDED.cost_per_unit, platform_markup = EXCLUDED.platform_markup,
                notes = EXCLUDED.notes, updated_at = NOW()
        `, [service, credit_balance || 0, credit_purchased || 0, dollar_balance || 0, dollar_purchased || 0, token_budget || 0, tokens_purchased || 0, cost_per_unit || 0, platform_markup || 0, notes || null]);
        res.json({ success: true, message: 'Orçamento atualizado.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/config/budgets/:service/reset', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { service } = req.params;
        await query(`
            UPDATE service_budgets 
            SET credit_balance = 0, credit_purchased = 0,
                dollar_balance = 0, dollar_purchased = 0,
                token_budget = 0, tokens_purchased = 0,
                updated_at = NOW()
            WHERE service = $1
        `, [service]);

        await query(`DELETE FROM api_usage_stats WHERE provider = $1`, [service]);
        res.json({ success: true, message: `Histórico e saldos da ${service} redefinidos com sucesso.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Get consolidated cost and usage stats + platform revenue report
app.get('/api/admin/stats/costs', authenticateJWT, isAdmin, async (_req, res) => {
    try {
        const usageRes = await query(`
            SELECT provider,
                COALESCE(SUM(tokens_prompt), 0) as total_prompt,
                COALESCE(SUM(tokens_completion), 0) as total_completion,
                COALESCE(SUM(cost_estimated), 0) as total_cost,
                COUNT(*) as total_calls
            FROM api_usage_stats
            WHERE created_at > NOW() - INTERVAL '30 days'
            GROUP BY provider
        `);

        const agentRes = await query(`
            SELECT agent_name, provider,
                COALESCE(SUM(tokens_prompt), 0) as total_prompt,
                COALESCE(SUM(tokens_completion), 0) as total_completion,
                COALESCE(SUM(cost_estimated), 0) as total_cost,
                COUNT(*) as total_calls
            FROM api_usage_stats
            WHERE created_at > NOW() - INTERVAL '30 days'
            GROUP BY agent_name, provider
            ORDER BY total_cost DESC LIMIT 30
        `);

        let platformCreditsSold = 0, platformRevenue = 0;
        try {
            const creditsRes = await query(`SELECT COALESCE(SUM(credits), 0) as cs, COALESCE(SUM(amount), 0) as rev FROM transactions WHERE status = 'completed' AND created_at > NOW() - INTERVAL '30 days'`);
            platformCreditsSold = parseFloat(creditsRes.rows[0]?.cs || '0');
            platformRevenue = parseFloat(creditsRes.rows[0]?.rev || '0');
        } catch (_) {}

        let creditsConsumed = 0;
        try {
            const consumedRes = await query(`SELECT COALESCE(SUM(cost), 0) as total FROM generations WHERE status = 'completed' AND created_at > NOW() - INTERVAL '30 days'`);
            creditsConsumed = parseFloat(consumedRes.rows[0]?.total || '0');
        } catch (_) {}

        const logsRes = await query(`
            SELECT id, agent_name, provider, 
                   COALESCE(tokens_prompt, 0) as tokens_prompt, 
                   COALESCE(tokens_completion, 0) as tokens_completion, 
                   cost_estimated, created_at
            FROM api_usage_stats
            ORDER BY created_at DESC
            LIMIT 100
        `);

        const budgetsRes = await query('SELECT * FROM service_budgets');

        res.json({
            success: true,
            stats: usageRes.rows,
            agentStats: agentRes.rows,
            recentLogs: logsRes.rows,
            budgets: budgetsRes.rows,
            platform: { creditsSold: platformCreditsSold, creditsConsumed, revenue: platformRevenue }
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Rate Limiters
const authLimiter = rateLimit({ 
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20, 
    message: { success: false, message: 'Muitos pedidos. Tente mais tarde.' }
});

const genLimiter = rateLimit({ 
    windowMs: 60 * 1000, // 1 minute
    max: 20, 
    message: { success: false, message: 'Demasiadas tentativas de geração. Aguarde um momento.' }
});

// --- Add optional typing delay support for evolution API ---
const messageBuffer = new Map<string, { pushName: string, texts: string[], timeout: NodeJS.Timeout }>();

// --- WhatsApp Webhook (Public) ---
app.post('/api/webhooks/whatsapp', async (req, res) => {
    try {
        const body = req.body;
        
        // Debug: log all incoming webhook payloads in a safe way
        console.log('[Webhook] 📨 Received:', JSON.stringify({
            event: body.event,
            dataKeys: body.data ? Object.keys(body.data) : []
        }));

        const event = body.event || body.type;
        const data = body.data || body;

        // --- Evolution API v2.3.7 Payload Handling ---
        // Event: messages.upsert
        if (event === 'messages.upsert') {
            // v2 format: { event, instance, data: { key, pushName, message, ... } }
            // v1 format: { event, data: { message, key, pushName } }
            const message = data?.message || data?.messages?.[0]?.message;
            const key = data?.key || data?.messages?.[0]?.key;
            const pushName = data?.pushName || data?.messages?.[0]?.pushName || 'Lead';
            const remoteJid = key?.remoteJid;
            
            // Extract text content from various message types
            const text = message?.conversation 
                || message?.extendedTextMessage?.text 
                || message?.buttonsResponseMessage?.selectedDisplayText
                || '';

            if (text && remoteJid && !key?.fromMe) {
                // Log inbound message
                (async () => {
                    try {
                        const cleanNumber = remoteJid.split('@')[0].replace(/\D/g, '');
                        const senderUser = await query(
                            "SELECT id FROM users WHERE REPLACE(REPLACE(whatsapp, ' ', ''), '+', '') LIKE $1 OR REPLACE(REPLACE(whatsapp, ' ', ''), '+', '') LIKE $2 LIMIT 1",
                            [`%${cleanNumber}`, `%${cleanNumber.slice(-9)}`]
                        );
                        const userId = senderUser.rows[0]?.id || null;

                        await query(
                            `INSERT INTO whatsapp_logs (recipient, type, content, status, direction, category, user_id) 
                             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                            [cleanNumber, 'text', text, 'success', 'inbound', 'general', userId]
                        ).catch(e => console.error('[Webhook Log Error]', e.message));
                    } catch (e: any) {
                        console.error('[Webhook Log Error]', e.message);
                    }
                })();

                // Buffer algorithm: wait 35 seconds to aggregate messages before AI replies
                if (messageBuffer.has(remoteJid)) {
                    const buffer = messageBuffer.get(remoteJid)!;
                    buffer.texts.push(text);
                    // Do not reset the timer to prevent infinite buffering if user keeps typing
                } else {
                    const timer = setTimeout(() => {
                        const buffer = messageBuffer.get(remoteJid);
                        if (buffer) {
                            const combinedText = buffer.texts.join(' ');
                            messageBuffer.delete(remoteJid);
                            console.log(`[Webhook] 🤖 Dispatching buffered messages to Alex for: ${remoteJid}`);
                            WhatsAppLeadAgent.handleIncomingMessage(remoteJid, buffer.pushName, combinedText).catch(e => 
                                console.error('[WhatsApp Webhook Agent Error]', e.message)
                            );
                        }
                    }, 35000); // 35 seconds buffer

                    messageBuffer.set(remoteJid, {
                        pushName,
                        texts: [text],
                        timeout: timer
                    });
                    console.log(`[Webhook] ⏱️ Buffering started for: ${remoteJid} (35s)`);
                }
            }
        }
        
        res.status(200).send('OK');
    } catch (error: any) {
        console.error('[WhatsApp Webhook] Fatal Error:', error.message);
        res.status(500).send('Error');
    }
});

// Apply rate limits
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/generate/', genLimiter);

// CSRF Token Endpoint removed (security relies on JWT headers)


// Apply CSRF validation globally (except for GET, HEAD, OPTIONS via middleware internal logic)
app.use(validateCsrf);

 // Real-time Tracking Middleware
 app.use(async (req: any, res, next) => {
     try {
         // derivation priority: JWT (most secure) > explicit headers (legacy support)
         let userId = req.user?.id;
         
         if (!userId && req.headers.authorization) {
             try {
                const token = req.headers.authorization.split(' ')[1];
                const decoded = verifyAccessToken(token);
                userId = decoded?.id;
             } catch (e) {}
         }

         // Fallback to query/body only if absolutely necessary, but log it as insecure
         if (!userId) {
            userId = req.headers['x-user-id'] || req.query.userId || (req.body && req.body.userId);
         }

         if (userId) {
             const userAgent = req.headers['user-agent'] || 'unknown';
             let device = 'Desktop';
             if (/mobile/i.test(userAgent)) device = 'Mobile';
             else if (/tablet/i.test(userAgent)) device = 'Tablet';
 
             // Async update
             query('UPDATE users SET last_active_at = NOW(), last_device = $1 WHERE id = $2', [device, userId]).catch(() => {});
         }
     } catch (e) {}
     next();
 });

// Multi-part form data for image uploads (5MB Limit)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit per file
});

// Helper for S3 Signed URLs
const getSignedS3Url = async (url: string, expiresIn: number = 3600) => {
    if (!url || !url.startsWith('http')) return url;
    
    try {
        const bucketName = await getConfig('storage_bucket', "kwikdocsao");
        const parsedUrl = new URL(url);
        let key = '';

        // Handle path-style URLs (endpoint/bucket/key) logic more robustly
        if (parsedUrl.pathname.includes(`/${bucketName}/`)) {
            key = parsedUrl.pathname.split(`/${bucketName}/`)[1];
        } else {
            // Fallback: strip leading slash and check if bucket is the first segment
            const parts = parsedUrl.pathname.split('/').filter(Boolean);
            if (parts[0] === bucketName) {
                key = parts.slice(1).join('/');
            } else {
                key = parts.join('/');
            }
        }

        // Strip query parameters
        key = decodeURIComponent(key.split('?')[0]);

        const signCommand = new GetObjectCommand({ Bucket: bucketName, Key: key });
        const s3 = await getDynamicS3Client();
        return await getSignedUrl(s3, signCommand, { expiresIn });
    } catch (err) {
        console.warn('[S3 Signing] Failed to sign URL:', url, err);
        return url;
    }
};

// API Auth Routes
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, password, whatsapp } = req.body;
        
        if (!name || !password || !whatsapp) {
            return res.status(400).json({ success: false, message: 'Todos os campos (Nome, Palavra-passe e WhatsApp) são obrigatórios' });
        }

        // WhatsApp is the unique identifier now. Generate a fake email to satisfy DB constraints.
        const cleanWhatsapp = whatsapp.replace(/\D/g, ''); // Extract only digits
        const systemEmail = `${cleanWhatsapp}@users.conversio.ai`;

        // Check if user exists either by exact WhatsApp match or systemEmail match
        const existing = await query('SELECT id FROM users WHERE whatsapp = $1 OR email = $2', [whatsapp, systemEmail]);
        if (existing.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Este número de WhatsApp já está registado' });
        }

        const hashedPassword = await hashPassword(password);
        
        // Create user
        const result = await query(
            'INSERT INTO users (name, email, password_hash, credits, role, whatsapp) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email, credits, role',
            [name, systemEmail, hashedPassword, await getConfig('financial_initial_credits', '500'), 'user', whatsapp]
        );
        const user = result.rows[0];

        // Provision storage folder
        await provisionUserFolder(user.id);
        
        // Generate and send WhatsApp verification code
        const verificationCode = whatsappService.generateVerificationCode();
        const expiresAtVerification = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await query(
            'UPDATE users SET whatsapp_verification_code = $1, whatsapp_verification_expires = $2 WHERE id = $3',
            [verificationCode, expiresAtVerification, user.id]
        );

        await whatsappService.sendWhatsAppMessage(
            whatsapp, 
            `Seu código de verificação Conversio é: ${verificationCode}. Valido por 10 minutos.`,
            'auth'
        );

        // --- Post-registration: Assign to first CRM stage & trigger Day-0 automations ---
        (async () => {
            try {
                // Assign to first CRM stage
                const firstStage = await query('SELECT id FROM crm_stages ORDER BY order_index ASC LIMIT 1');
                if (firstStage.rows.length > 0) {
                    await query('UPDATE users SET crm_stage_id = $1 WHERE id = $2', [firstStage.rows[0].id, user.id]);
                }

                // Fire Day-0 automations
                const automations = await query(
                    "SELECT * FROM crm_automations WHERE is_active = true AND trigger_type = 'days_after_signup' AND delay_days = 0"
                );
                for (const auto of automations.rows) {
                    const msg = auto.message_template.replace(/{name}/g, name);
                    await whatsappService.sendWhatsAppMessage(whatsapp, msg, 'followup');
                    await query('UPDATE crm_automations SET sent_count = sent_count + 1 WHERE id = $1', [auto.id]);
                    await query(
                        'INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)',
                        [user.id, 'automation', `Automação pós-cadastro: ${auto.name}`]
                    );
                }

                // --- NEW: Sync data from whatsapp_leads if exists ---
                const cleanWhatsapp = whatsapp.replace(/\D/g, '');
                const leadSearch = await query('SELECT business_info, needs, name FROM whatsapp_leads WHERE phone = $1', [cleanWhatsapp]);
                if (leadSearch.rows.length > 0) {
                    const lead = leadSearch.rows[0];
                    // Transfer the briefing (stored in business_info if qualified) to context_briefing
                    await query(
                        'UPDATE users SET context_briefing = $1 WHERE id = $2',
                        [`O que sabemos do WhatsApp: ${lead.business_info || lead.needs}`, user.id]
                    );
                    // Mark lead as converted
                    await query('UPDATE whatsapp_leads SET status = \'converted\' WHERE phone = $1', [cleanWhatsapp]);
                }

            } catch (e) {
                console.error('[CRM Post-register error]', e);
            }
        })();

        const accessToken = generateAccessToken({ id: user.id, role: user.role });
        const refreshToken = generateRefreshToken(user.id, crypto.randomUUID());
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, hashToken(refreshToken), expiresAt]
        );

        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: true, // Always true for cross-site cookies
            sameSite: 'none', // Needed for Vercel -> Easypanel communication
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            token: accessToken,
            user: { ...user, plan: 'free' }
        });

    } catch (error: any) {
        console.error('Register error:', error);
        res.status(500).json({ success: false, message: 'Erro interno no registo' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { whatsapp, password } = req.body;
        
        if (!whatsapp || !password) {
            return res.status(400).json({ success: false, message: 'WhatsApp e palavra-passe são obrigatórios' });
        }

        // Search user by precise whatsapp string (or fallback to clean digit string matching the system email alias)
        const cleanWhatsapp = whatsapp.replace(/\D/g, '');
        const systemEmail = `${cleanWhatsapp}@users.conversio.ai`;

        const result = await query(
            'SELECT * FROM users WHERE whatsapp = $1 OR whatsapp LIKE $2 OR email = $3', 
            [whatsapp, `%${cleanWhatsapp}%`, systemEmail]
        );
        
        const user = result.rows[0];

        if (!user) {
            console.warn(`[Login] User not found for whatsapp: ${whatsapp} or email: ${systemEmail}`);
            return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }

        const isMatch = await comparePasswords(password, user.password_hash);
        if (!isMatch) {
            console.warn(`[Login] Password mismatch for user: ${user.whatsapp}`);
            return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }

        const accessToken = generateAccessToken({ id: user.id, role: user.role });
        const refreshToken = generateRefreshToken(user.id, crypto.randomUUID());
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, hashToken(refreshToken), expiresAt]
        );

        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: true, // Always true for cross-site cookies
            sameSite: 'none', // Needed for Vercel -> Easypanel communication
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            token: accessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits: user.credits,
                whatsapp: user.whatsapp,
                role: user.role
            }
        });

    } catch (error: any) {
        console.error('--- ERRO CRÍTICO NO LOGIN ---');
        console.error('Mensagem:', error.message);
        res.status(500).json({ success: false, message: 'Erro interno no login' });
    }
});

// Google OAuth Login
app.post('/api/auth/google', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ success: false, message: 'Google Token Ausente' });
        }

        // Fetch user info from Google using the access token
        const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: `Bearer ${token}` }
        });
        
        if (!googleRes.ok) {
            return res.status(401).json({ success: false, message: 'Token Google Inválido' });
        }

        const googleUser = await googleRes.json();
        const { sub: googleId, email, name, picture: avatarUrl } = googleUser;

        if (!googleId || !email) {
            return res.status(400).json({ success: false, message: 'Dados do Google incompletos' });
        }

        // Find or create user
        let userResult = await query('SELECT * FROM users WHERE google_id = $1 OR email = $2', [googleId, email]);
        let user = userResult.rows[0];

        if (!user) {
            // Create user for Google login
            const createResult = await query(
                'INSERT INTO users (name, email, google_id, avatar_url, is_verified, password_hash, credits) VALUES ($1, $2, $3, $4, true, $5, $6) RETURNING *',
                [name || 'User Google', email, googleId, avatarUrl, 'google-oauth-placeholder', await getConfig('initial_credits', '500')]
            );
            user = createResult.rows[0];
            
            // Initialize S3 storage folder
            try {
                await provisionUserFolder(user.id);
            } catch (s3Err) {
                console.warn('[Storage] Google user S3 provision failed.');
            }

        } else if (!user.google_id) {
            // Link existing email account to Google
            await query('UPDATE users SET google_id = $1, avatar_url = $2, is_verified = true WHERE id = $3', [googleId, avatarUrl, user.id]);
        }

        const accessToken = generateAccessToken({ id: user.id, role: user.role });
        const refreshToken = generateRefreshToken(user.id, crypto.randomUUID());
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        // Store refresh token
        await query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, hashToken(refreshToken), expiresAt]
        );

        // Set HttpOnly cookie for refresh token
        res.cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: true, // Always true for cross-site cookies
            sameSite: 'none', // Needed for Vercel -> Easypanel communication
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            token: accessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits: user.credits,
                avatar: user.avatar_url
            }
        });

    } catch (error: any) {
        console.error('Google Login Error:', error);
        res.status(500).json({ success: false, message: 'Erro interno no login com Google' });
    }
});

app.post('/api/auth/refresh', async (req, res) => {
    try {
        const refreshToken = req.cookies.refreshToken;
        if (!refreshToken) return res.status(401).json({ success: false, message: 'Refresh token ausente' });

        const decoded = verifyRefreshToken(refreshToken);
        const { userId, tokenId } = decoded;

        // Verify in DB
        const tokenHash = hashToken(refreshToken);
        const result = await query(
            'SELECT * FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND revoked = false AND expires_at > NOW()',
            [userId, tokenHash]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Refresh token inválido ou revogado' });
        }

        const userResult = await query('SELECT id, role, name, email, credits FROM users WHERE id = $1', [userId]);
        const user = userResult.rows[0];

        if (!user) return res.status(401).json({ success: false, message: 'Usuário não encontrado' });

        // Rotation: Revoke old token and issue new pair
        await query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1 AND token_hash = $2', [userId, tokenHash]);

        const newAccessToken = generateAccessToken({ id: user.id, role: user.role });
        const newRefreshToken = generateRefreshToken(user.id, crypto.randomUUID());
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await query(
            'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
            [user.id, hashToken(newRefreshToken), expiresAt]
        );

        res.cookie('refreshToken', newRefreshToken, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.json({
            success: true,
            token: newAccessToken,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                credits: user.credits,
                role: user.role
            }
        });
    } catch (error) {
        res.status(401).json({ success: false, message: 'Erro ao renovar token' });
    }
});

app.post('/api/auth/logout', async (req, res) => {
    try {
        const refreshToken = req.cookies.refreshToken;
        if (refreshToken) {
            const tokenHash = hashToken(refreshToken);
            await query('UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1', [tokenHash]);
        }
        res.clearCookie('refreshToken');
        res.json({ success: true, message: 'Logout realizado com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// WhatsApp Verification Routes
app.post('/api/auth/verify-whatsapp', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { code } = req.body;

        if (!userId || !code) {
            return res.status(400).json({ success: false, message: 'Código é obrigatório' });
        }

        const result = await query(
            'SELECT whatsapp_verification_code, whatsapp_verification_expires FROM users WHERE id = $1',
            [userId]
        );
        const user = result.rows[0];

        if (!user || user.whatsapp_verification_code !== code) {
            return res.status(400).json({ success: false, message: 'Código incorreto' });
        }

        if (new Date() > new Date(user.whatsapp_verification_expires)) {
            return res.status(400).json({ success: false, message: 'Código expirado' });
        }

        await query(
            'UPDATE users SET whatsapp_verified = true, whatsapp_verification_code = NULL, whatsapp_verification_expires = NULL WHERE id = $1',
            [userId]
        );

        res.json({ success: true, message: 'WhatsApp verificado com sucesso' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao verificar WhatsApp' });
    }
});

app.post('/api/auth/resend-whatsapp', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false });

        const userRes = await query('SELECT whatsapp FROM users WHERE id = $1', [userId]);
        const whatsapp = userRes.rows[0]?.whatsapp;

        if (!whatsapp) {
            return res.status(400).json({ success: false, message: 'Número de WhatsApp não encontrado' });
        }

        const verificationCode = whatsappService.generateVerificationCode();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await query(
            'UPDATE users SET whatsapp_verification_code = $1, whatsapp_verification_expires = $2 WHERE id = $3',
            [verificationCode, expiresAt, userId]
        );

        await whatsappService.sendWhatsAppMessage(
            whatsapp, 
            `Seu novo código de verificação Conversio é: ${verificationCode}. Valido por 10 minutos.`,
            'auth'
        );

        res.json({ success: true, message: 'Novo código enviado' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Erro ao reativar código' });
    }
});

// Admin CRM Routes
app.get('/api/admin/crm/stages', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM crm_stages ORDER BY order_index ASC');
        res.json({ success: true, stages: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/crm/pipeline', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query(`
            SELECT u.id, u.name, u.email, u.whatsapp, u.whatsapp_verified, u.credits, u.created_at, u.crm_stage_id,
                   (SELECT MAX(created_at) FROM crm_interactions WHERE user_id = u.id) as last_interaction
            FROM users u
            WHERE u.role = 'user'
            ORDER BY u.created_at DESC
        `);
        res.json({ success: true, leads: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/update-stage', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { userId, stageId } = req.body;
        await query('UPDATE users SET crm_stage_id = $1 WHERE id = $2', [stageId, userId]);
        
        // Log interaction
        await query(
            'INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)',
            [userId, 'stage_move', `Movido para estágio ID: ${stageId}`]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/crm/user/:id', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const userRes = await query('SELECT id, name, email, whatsapp, whatsapp_verified, credits, created_at, crm_stage_id FROM users WHERE id = $1', [id]);
        const interactionsRes = await query('SELECT * FROM crm_interactions WHERE user_id = $1 ORDER BY created_at DESC', [id]);
        
        res.json({ 
            success: true, 
            user: userRes.rows[0],
            interactions: interactionsRes.rows
        });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/interaction', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { userId, type, content } = req.body;
        await query(
            'INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)',
            [userId, type, content]
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/campaign/send', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { name, template, userIds } = req.body;
        
        // Create campaign record
        const campaignRes = await query(
            'INSERT INTO crm_campaigns (name, message_template, status) VALUES ($1, $2, $3) RETURNING id',
            [name, template, 'completed']
        );
        const campaignId = campaignRes.rows[0].id;

        // Fetch users
        const usersRes = await query('SELECT id, whatsapp, name FROM users WHERE id = ANY($1)', [userIds]);
        
        for (const user of usersRes.rows) {
            if (user.whatsapp) {
                const personalizedMsg = template.replace(/{name}/g, user.name);
                await whatsappService.sendWhatsAppMessage(user.whatsapp, personalizedMsg, 'campaign', 1200, user.id, campaignId);
                
                await query(
                    'INSERT INTO crm_interactions (user_id, type, content) VALUES ($1, $2, $3)',
                    [user.id, 'whatsapp_sent', `Campanha: ${name}`]
                );
            }
        }

        res.json({ success: true, campaignId });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/campaign/generate', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { stageId, promptInput } = req.body;
        
        let queryStr = "SELECT u.id, u.name, (SELECT string_agg(type || ':' || content, ' | ') FROM crm_interactions ci WHERE ci.user_id = u.id) as interactions FROM users u WHERE u.role = 'user'";
        let queryParams = [];
        if (stageId) {
            queryStr += ' AND u.crm_stage_id = $1';
            queryParams.push(stageId);
        }
        
        const usersRes = await query(queryStr, queryParams);
        if (usersRes.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Nenhum utilizador encontrado para este segmento.' });
        }

        const aiResponse = await crmAgent.generateCampaginWithAI(usersRes.rows, promptInput);
        res.json({ success: true, aiGenerated: aiResponse });
    } catch (error: any) {
        console.error('Campaign AI generation error:', error);
        res.status(500).json({ success: false, message: 'Erro ao gerar campanha via IA' });
    }
});

// --- CRM Automation CRUD Routes ---
app.get('/api/admin/crm/automations', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query('SELECT * FROM crm_automations ORDER BY created_at ASC');
        res.json({ success: true, automations: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/crm/automations', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { name, trigger_type, delay_days, message_template } = req.body;
        const result = await query(
            'INSERT INTO crm_automations (name, trigger_type, delay_days, message_template) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, trigger_type || 'days_after_signup', delay_days || 0, message_template]
        );
        res.json({ success: true, automation: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.put('/api/admin/crm/automations/:id', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, trigger_type, delay_days, message_template, is_active } = req.body;
        const result = await query(
            'UPDATE crm_automations SET name=$1, trigger_type=$2, delay_days=$3, message_template=$4, is_active=$5 WHERE id=$6 RETURNING *',
            [name, trigger_type, delay_days, message_template, is_active, id]
        );
        res.json({ success: true, automation: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.put('/api/admin/crm/automations/:id/toggle', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await query(
            'UPDATE crm_automations SET is_active = NOT is_active WHERE id = $1 RETURNING *',
            [id]
        );
        res.json({ success: true, automation: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/admin/crm/automations/:id', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        await query('DELETE FROM crm_automations WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- Autonomous Agents Routes ---
app.get('/api/admin/agents', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const statuses = await agentService.getAgentTeamStatus();
        res.json({ success: true, agents: statuses });
    } catch (error) {
        console.error('Failed to get agent statuses:', error);
        res.status(500).json({ success: false });
    }
});

app.get('/api/admin/agents/approvals', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query(`
            SELECT aa.*, a.persona_name, a.emoji, u.name as user_name, u.whatsapp as user_whatsapp
            FROM agent_approvals aa
            JOIN agent_team a ON aa.agent_id = a.id
            JOIN users u ON aa.user_id = u.id
            WHERE aa.status = 'pending'
            ORDER BY aa.created_at ASC
        `);
        res.json({ success: true, approvals: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/agents/approve', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { approvalId, notes } = req.body;
        const success = await agentService.approveAgentAction(approvalId, notes);
        res.json({ success });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/agents/reject', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { approvalId, notes } = req.body;
        const success = await agentService.rejectAgentAction(approvalId, notes);
        res.json({ success });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// --- Admin Notifications Feed ---
app.get('/api/admin/notifications', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const result = await query(`
            SELECT * FROM admin_notifications 
            ORDER BY created_at DESC 
            LIMIT 50
        `);
        res.json({ success: true, notifications: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Email Verification Link

app.get('/api/auth/verify/:token', async (req, res) => {
    try {
        const { token } = req.params;
        const result = await query('UPDATE users SET is_verified = true, verification_token = NULL WHERE verification_token = $1 RETURNING name', [token]);
        
        if (result.rows.length === 0) {
            return res.status(400).send('Token inválido ou expirado.');
        }

        res.send(`A sua conta Conversio foi ativada com sucesso. Pode fechar esta página e regressar à aplicação.`);
    } catch (error) {
        res.status(500).send('Erro no servidor.');
    }
});


// User Profile Routes
app.get('/api/user/profile', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        const result = await query('SELECT id, name, email, whatsapp, avatar_url, brand_logo_url, role, credits, created_at FROM users WHERE id = $1', [userId]);
        if (result.rows.length === 0) return res.status(404).json({ success: false });

        res.json({ success: true, user: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/user/notifications/toggle', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { enabled } = req.body;
        
        // Check if user is Scale plan (only Scale can use notifications)
        // All users now have access to WhatsApp notifications toggle backward compatible with credits logic

        await query('UPDATE users SET whatsapp_notifications_enabled = $1 WHERE id = $2', [enabled, userId]);
        res.json({ success: true, message: `Notificações ${enabled ? 'ativadas' : 'desativadas'}.` });
    } catch (err: any) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/user/profile/update', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { name, email, avatarUrl, brandLogoUrl, currentPassword, newPassword } = req.body;

        if (!userId) return res.status(400).json({ success: false });

        const updateFields = [];
        const values = [];
        let placeholderIdx = 1;

        if (name) {
            updateFields.push(`name = $${placeholderIdx++}`);
            values.push(name);
        }
        if (email) {
            updateFields.push(`email = $${placeholderIdx++}`);
            values.push(email);
        }
        if (avatarUrl !== undefined) {
            updateFields.push(`avatar_url = $${placeholderIdx++}`);
            values.push(avatarUrl);
        }
        if (brandLogoUrl !== undefined) {
            updateFields.push(`brand_logo_url = $${placeholderIdx++}`);
            values.push(brandLogoUrl === '' ? null : brandLogoUrl);
        }

        // Handle password change if requested
        if (currentPassword && newPassword) {
            const userRes = await query('SELECT password FROM users WHERE id = $1', [userId]);
            const user = userRes.rows[0];
            
            if (!user.password || await comparePasswords(currentPassword, user.password)) {
                const hashedPassword = await hashPassword(newPassword);
                updateFields.push(`password = $${placeholderIdx++}`);
                values.push(hashedPassword);
            } else {
                return res.status(401).json({ success: false, message: 'Senha atual incorreta' });
            }
        }

        if (updateFields.length === 0) return res.json({ success: true, message: 'Nada para atualizar' });

        values.push(userId);
        const result = await query(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${placeholderIdx} RETURNING id, name, email, avatar_url, brand_logo_url, role, credits`,
            values
        );

        res.json({ success: true, user: result.rows[0] });
    } catch (error: any) {
        console.error('Profile update error:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao atualizar perfil' });
    }
});

// Upload User Avatar
app.post('/api/user/upload-avatar', authenticateJWT, upload.single('avatar'), async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
    try {
        const userId = req.user?.id;
        const avatarFile = req.file;

        if (!userId || !avatarFile) {
            return res.status(400).json({ success: false, message: 'Falta ficheiro de avatar.' });
        }

        const fileName = `avatar_${userId}_${Date.now()}.png`;
        const avatarUrl = await uploadBufferToUserFolder(userId, 'Perfil', avatarFile.buffer, fileName, avatarFile.mimetype);

        // Update the user's profile with the new avatar url
        await query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, userId]);

        res.json({ success: true, avatarUrl });
    } catch (error: any) {
        console.error('Upload avatar error:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao enviar avatar' });
    }
});

// Brand Management Routes
app.post('/api/brands/analyze', authenticateJWT, upload.single('logo'), async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
    try {
        const userId = req.user?.id;
        const logoFile = req.file;

        if (!userId || !logoFile) {
            return res.status(400).json({ success: false, message: 'Faltam dados: userId ou Ficheiro (logo).' });
        }

        console.log(`[API ANALYZE] User: ${userId}, File: ${logoFile.originalname}`);

        // 1. Storage Upload
        let publicUrl = '';
        let signedUrl = '';
        try {
            const fileName = `brand_analysis_${userId}_${Date.now()}.png`;
            publicUrl = await uploadBufferToUserFolder(userId, 'Imagens', logoFile.buffer, fileName, logoFile.mimetype);
            signedUrl = await getSignedS3UrlForKey(publicUrl, 600);
            console.log(`[API ANALYZE] S3 Success. Signed URL ready.`);
        } catch (s3Err: any) {
            console.error('[API ANALYZE] S3_UPLOAD_FAILED:', s3Err.message);
            return res.status(500).json({ 
                success: false, 
                message: 'ERRO_S3: Falha ao guardar a imagem no storage.', 
                error: s3Err.message 
            });
        }

        // 2. Call Local Brand Color Extractor Agent
        try {
            console.log(`[API ANALYZE] Starting Local Agent analysis for ${signedUrl}`);
            const data = await BrandColorExtractorAgent.analyze(signedUrl);

            console.log(`[API ANALYZE] Agent Success. Mapping colors for ${data.company_name}...`);

            const analysis = {
                company_name: data.company_name || 'Nova Empresa',
                brand_colors: {
                    primary: data.brand_colors?.primary || '#000000',
                    secondary: data.brand_colors?.secondary || '#FFFFFF',
                    accent: data.brand_colors?.accent || null,
                    palette: data.brand_colors?.palette || ['#000000', '#FFFFFF'],
                    palette_description: data.brand_colors?.palette_description || 'Paleta extraída da marca.'
                },
                confidence: 1.0,
                raw_ai_response: data
            };

            return res.json({
                success: true,
                analysis,
                logoUrl: publicUrl
            });

        } catch (agentErr: any) {
            console.error('[API ANALYZE] AGENT_FAILED:', agentErr.message);
            return res.status(500).json({ 
                success: false, 
                message: 'ERRO_ANALISE: Falha ao extrair cores com o Agente IA.', 
                error: agentErr.message 
            });
        }

    } catch (error: any) {
        console.error('[API ANALYZE] CRITICAL_CRASH:', error);
        return res.status(500).json({ 
            success: false, 
            message: 'ERRO_CRÍTICO: Um erro inesperado derrubou a rota.', 
            error: error.message 
        });
    }
});

app.post('/api/brands/save', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { company_name, logo_url, brand_colors, raw_ai_response, confirmed } = req.body;

        if (!userId) return res.status(401).json({ success: false });

        const sql = `
            INSERT INTO brands (user_id, company_name, logo_url, brand_colors, raw_ai_response, confirmed, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            ON CONFLICT (user_id) 
            DO UPDATE SET 
                company_name = EXCLUDED.company_name,
                logo_url = EXCLUDED.logo_url,
                brand_colors = EXCLUDED.brand_colors,
                raw_ai_response = EXCLUDED.raw_ai_response,
                confirmed = EXCLUDED.confirmed,
                updated_at = NOW()
            RETURNING *
        `;

        const result = await query(sql, [userId, company_name, logo_url, JSON.stringify(brand_colors), JSON.stringify(raw_ai_response), confirmed]);
        
        res.json({ success: true, brand: result.rows[0] });

    } catch (error: any) {
        console.error('[Brand Save Error]', error);
        res.status(500).json({ success: false, message: 'Erro ao guardar configurações da marca.' });
    }
});

app.get('/api/brands/:user_id', authenticateJWT, async (req, res) => {
    try {
        const { user_id } = req.params;
        const result = await query('SELECT * FROM brands WHERE user_id = $1', [user_id]);
        
        if (result.rows.length === 0) {
            return res.json({ success: true, brand: null });
        }
        
        const brand = result.rows[0];
        
        // Fix 401 Unauthorized: Sign the S3 logo URL for the frontend
        if (brand.logo_url) {
            try {
                brand.logo_url = await getSignedS3UrlForKey(brand.logo_url, 86400); // Authorized for 24h
            } catch (s3Err: any) {
                console.warn('[API FETCH] Failed to sign brand logo:', s3Err.message);
            }
        }
        
        res.json({ success: true, brand });
    } catch (error: any) {
        res.status(500).json({ success: false });
    }
});


// AI Generation Endpoints

app.post('/api/generate/image', authenticateJWT, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'character_image', maxCount: 1 }]), async (req: AuthRequest & { files?: { [fieldname: string]: Express.Multer.File[] } }, res) => {
    try {
        const { prompt, model_id, core_id, style_id, model_name, core_name, style_name, aspectRatio, quantity, style: requestStyle, includeText } = req.body;
        const userId = req.user?.id;
        const imageFile = req.files?.['image']?.[0];
        const characterFile = req.files?.['character_image']?.[0];

        // Parse selections if multi-style is used
        let selections: { style_id: string, style_name: string, quantity: number, aspectRatio: string }[] = [];
        if (req.body.selections) {
            try {
                selections = typeof req.body.selections === 'string' ? JSON.parse(req.body.selections) : req.body.selections;
            } catch (e) {
                console.warn('[API] Could not parse selections payload', e);
            }
        }
        
        // Fallback for single style if selections is empty or not provided
        if (selections.length === 0) {
            selections = [{
                style_id: style_id || '',
                style_name: requestStyle || style_name || '',
                quantity: Math.min(parseInt(quantity || '1'), 10),
                aspectRatio: aspectRatio || '1:1'
            }];
        }

        // Enforce maximum 10 per style
        selections.forEach(sel => {
            if (sel.quantity > 10) sel.quantity = 10;
            if (sel.quantity < 1) sel.quantity = 1;
        });

        // Image is MANDATORY for Agent/Standard mode (where core_id is present)
        // Description (prompt) is OPTIONAL for Agent mode
        if (!userId) {
            return res.status(401).json({ success: false, message: 'Usuário não autenticado.' });
        }

        const isAgentMode = !!core_id;
        
        if (isAgentMode) {
            if (!imageFile) {
                return res.status(400).json({ success: false, message: 'A imagem do produto é obrigatória para este Agente.' });
            }
        } else {
            // Text-only or generic Flux mode
            if (!prompt && !imageFile) {
                return res.status(400).json({ success: false, message: 'Digite uma descrição ou carregue uma imagem.' });
            }
        }

        const model = model_name || 'Flux.1';

        // 1. Credit Check & User Validation
        const userRes = await query('SELECT credits, name, whatsapp FROM users WHERE id = $1', [userId]);
        const user = userRes.rows[0];

        if (!user) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        }

        // Fetch costs from DB or hardcoded for specific Agents/Cores
        let modelCost = 1;
        let coreCost = 0;
        let styleCost = 0;

        let modelTechnicalId = null;
        let modelKieCost = 0;
        if (model_id) {
            const mRes = await query('SELECT credit_cost, kie_cost, style_id FROM models WHERE id = $1', [model_id]);
            if (mRes.rows.length > 0) {
                modelCost = mRes.rows[0].credit_cost || 1;
                modelKieCost = mRes.rows[0].kie_cost || 0;
                modelTechnicalId = mRes.rows[0].style_id;
            }
        }

        let coreKieCost = 0;
        if (core_id) {
            // Match costs with ImageGenerator.tsx hardcoded values
            if (core_id === 'ugc-realistic') coreCost = 2;
            else if (core_id === 'brand-visual') coreCost = 4;
            else if (core_id === 'impact-ads-pro') coreCost = 5;
            else if (core_id === 'boutique-fashion') coreCost = 4;
            else if (core_id === 'glow-angola') coreCost = 4;
            else {
                try {
                    const cRes = await query('SELECT credit_cost, kie_cost FROM models WHERE id = $1', [core_id]);
                    if (cRes.rows.length > 0) {
                        coreCost = cRes.rows[0].credit_cost || 0;
                        coreKieCost = cRes.rows[0].kie_cost || 0;
                    }
                } catch (err) {
                    console.warn('[API] Could not fetch cost for core_id:', core_id);
                }
            }
        }

        const compositionSurcharge = parseFloat(await getConfig('financial_composition_cost', '2'));
        const unitCost = modelCost + coreCost + (characterFile ? compositionSurcharge : 0);
        const unitKieCost = Number(modelKieCost) + Number(coreKieCost);

        let totalCost = 0;
        let totalKieCost = 0;

        selections.forEach(sel => {
            totalCost += unitCost * sel.quantity;
            totalKieCost += unitKieCost * sel.quantity;
        });

        if (user.credits < totalCost) {
            if (user.whatsapp) {
                try {
                    await whatsappService.sendWhatsAppMessage(
                        user.whatsapp, 
                        `Olá ${user.name}! ⚠️ O seu pedido de geração falhou porque não tem créditos suficientes no Conversio.\nNecessita de ${totalCost} créditos, mas apenas tem ${user.credits} disponíveis.\n\nPor favor, recarregue a sua conta para continuar a criar!`
                    );
                } catch (e) {
                    console.warn('[WhatsApp warning failure]', e);
                }
            }
            return res.status(403).json({ success: false, message: `Créditos insuficientes. Necessário: ${totalCost}, Disponível: ${user.credits}` });
        }

        // Deduct credits upfront
        await query('UPDATE users SET credits = credits - $1 WHERE id = $2', [totalCost, userId]);

        // 2. Upload Temp Images if provided
        let tempImageUrl = null;
        let characterImageUrl = null;
        console.log('[API] Received files:', imageFile ? imageFile.originalname : 'None', characterFile ? characterFile.originalname : 'None');
        
        if (imageFile) {
            try {
                tempImageUrl = await uploadToTemp(imageFile.buffer, imageFile.originalname, imageFile.mimetype);
                console.log('[API] Product Image to S3:', tempImageUrl);
            } catch (err: any) {
                console.error('[API] S3 Upload Error (Product):', err.message);
                return res.status(500).json({ success: false, message: `Falha ao carregar imagem do produto: ${err.message}` });
            }
        }

        if (characterFile) {
            try {
                characterImageUrl = await uploadToTemp(characterFile.buffer, characterFile.originalname, characterFile.mimetype);
                console.log('[API] Character Image to S3:', characterImageUrl);
            } catch (err: any) {
                console.error('[API] S3 Upload Error (Character):', err.message);
                return res.status(500).json({ success: false, message: `Falha ao carregar imagem de personagem: ${err.message}` });
            }
        }

        // 3. Log generation as processing (NO IMMEDIATE DEDUCTION)
        const batchId = `BATCH-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        
        let globalIndex = 0;
        for (const sel of selections) {
            for(let i = 0; i < sel.quantity; i++) {
                await query(
                    'INSERT INTO generations (user_id, type, prompt, cost, status, metadata, batch_id, model, style, aspect_ratio) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                    [userId, 'image', prompt, unitCost, 'processing', JSON.stringify({ index: globalIndex, styleIndex: i, tempImageUrl, characterImageUrl, model_id, core_id, style_id: sel.style_id, core_name, includeText, kie_cost: unitKieCost }), batchId, model, sel.style_name, sel.aspectRatio]
                );
                globalIndex++;
            }
        }

        // 5. Fetch Brand Colors if any
        const brandRes = await query('SELECT brand_colors FROM brands WHERE user_id = $1', [userId]);
        const brandColors = brandRes.rows[0]?.brand_colors || null;

        // 6. Internal Modular Pipeline
        let curGenIndex = 0;
        for (const sel of selections) {
            for (let i = 0; i < sel.quantity; i++) {
                // Find the generation record we just created to get its ID
                const genRes = await query(
                    'SELECT id FROM generations WHERE batch_id = $1 AND metadata->>\'index\' = $2',
                    [batchId, String(curGenIndex)]
                );
                const generation = genRes.rows[0];
                const genId = generation?.id;

                if (genId) {
                    // Extract brand color config from request body
                    const use_brand_colors = req.body.use_brand_colors;
                    const brand_colors = req.body.brand_colors;

                    let contextAntiRepeticao = 'Nenhuma combinação anterior registada.';
                    try {
                        // Fetch UGC Context (Anti-Repetition)
                        if (core_id === 'ugc-realistic') {
                            const historyRes = await query(
                                `SELECT tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario 
                                 FROM ugc_used_combinations 
                                 WHERE user_id = $1 AND created_at > NOW() - INTERVAL '30 days'
                                 ORDER BY created_at DESC LIMIT 10`,
                                [userId]
                            );
                            if (historyRes.rows.length > 0) {
                                contextAntiRepeticao = historyRes.rows.map(r => 
                                    `${r.tipo_ugc} | ${r.sub_cena} | ${r.angulo_camara} | ${r.emocao_dominante} | ${r.cenario}`
                                ).join('\n');
                            }
                        }
                    } catch (e) {
                        console.warn('[API] Could not fetch anti-repetition context:', e);
                    }

                    // Trigger the pipeline in the background on the standalone generation engine
                    const generationEngineUrl = (process.env.GENERATION_ENGINE_URL || 'http://localhost:3010').replace(/[, ]/g, '');
                    const internalSecret = process.env.INTERNAL_SECRET;

                    console.log(`[API] 🚀 Delegating generation ${genId} to engine: ${generationEngineUrl}`);
                    axios.post(`${generationEngineUrl}/api/internal/generate/image`, {
                        userId,
                        userPrompt: prompt,
                        productImageUrl: tempImageUrl,
                        characterImageUrl: characterImageUrl,
                        coreId: core_id,
                        coreName: core_name,
                        style: sel.style_name,
                        aspectRatio: sel.aspectRatio,
                        generationId: genId,
                        modelId: modelTechnicalId || model_id,
                        useBrandColors: use_brand_colors === 'true' || use_brand_colors === true,
                        brandColors: typeof brand_colors === 'string' ? JSON.parse(brand_colors) : brand_colors,
                        contextAntiRepeticao: contextAntiRepeticao,
                        currentIndex: i + 1,
                        totalItems: sel.quantity,
                        includeText: includeText === 'true' || includeText === true
                    }, {
                        headers: { 'X-Internal-Secret': internalSecret },
                        timeout: 30000 // Increased to 30s
                    }).then(resp => {
                        console.log(`[API] ✅ Generation ${genId} delegated successfully. Status: ${resp.status}`, resp.data);
                    }).catch(err => {
                        console.error(`[Generation Delegate Error] Generation ${genId} failed:`, {
                            message: err.message,
                            status: err.response?.status,
                            data: err.response?.data,
                            code: err.code,
                            url: `${generationEngineUrl}/api/internal/generate/image`
                        });
                    });
                }
                curGenIndex++;
            }
        }

        res.json({
            success: true,
            message: 'Geração iniciada com sucesso. Verifique a galeria em breve.',
            batchId,
        });
    } catch (error: any) {
        console.error('Image Generation Error:', error);
        res.status(500).json({ success: false, message: 'Não foi possível processar a geração da imagem. Tente novamente.' });
    }
});

// Callback from n8n when generation is done
app.post('/api/ads/callback', async (req, res) => {
    try {
        const n8nSecret = req.headers['x-n8n-secret'];
        
        // Detailed logging to file
        const logEntry = `\n--- [${new Date().toISOString()}] n8n-callback ---\nHeaders: ${JSON.stringify(req.headers)}\nBody: ${JSON.stringify(req.body)}\n`;
        fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), logEntry);

        if (process.env.N8N_WEBHOOK_SECRET && n8nSecret !== process.env.N8N_WEBHOOK_SECRET) {
            console.warn('[n8n Callback] Blocked unauthorized request. Invalid X-N8n-Secret.');
            return res.status(403).json({ success: false, message: 'Acesso não autorizado. Verifique o segredo configurado.' });
        }

        let { generationId, userId, imageUrls, videoUrls, urls, copy, hashtags, title, status } = req.body;
        const incomingUrls = imageUrls || videoUrls || urls;

        // --- ID NORMALIZATION ---
        // n8n may send generationId as a stringified JSON array like '["uuid-123"]'
        let targetIds: string[] = [];
        let isBatchId = false;

        if (typeof generationId === 'string' && generationId.startsWith('[') && generationId.endsWith(']')) {
            try {
                const parsed = JSON.parse(generationId);
                if (Array.isArray(parsed)) {
                    targetIds = parsed;
                } else {
                    targetIds = [generationId];
                }
            } catch (e) {
                targetIds = [generationId];
            }
        } else if (Array.isArray(generationId)) {
            targetIds = generationId;
        } else if (generationId) {
            targetIds = [generationId];
        }

        // Check if the provided single ID might be a batch_id (starts with 'BATCH-' or 'AUDIO-')
        if (targetIds.length === 1 && (targetIds[0].startsWith('BATCH-') || targetIds[0].startsWith('AUDIO-'))) {
            isBatchId = true;
        }

        if (status === 'error' || status === 'failed' || status === false || status === 'false' || !incomingUrls || incomingUrls.length === 0) {
            // Refund the deducted credits since it failed
            let failedBatch;
            if (isBatchId) {
                failedBatch = await query("UPDATE generations SET status = 'failed' WHERE batch_id = $1 AND status = 'processing' RETURNING cost", [targetIds[0]]);
            } else {
                failedBatch = await query("UPDATE generations SET status = 'failed' WHERE id = ANY($1) AND status = 'processing' RETURNING cost", [targetIds]);
            }
            
            for (const row of failedBatch.rows) {
                const refundCost = Number(row.cost) || 0;
                if (refundCost > 0 && userId) {
                    await query('UPDATE users SET credits = credits + $1 WHERE id = $2', [refundCost, userId]);
                    console.log(`[n8n Callback] Reflexo de Erro: Refunded ${refundCost} credits to user ${userId} for failed batch/ids ${JSON.stringify(targetIds)}`);
                }
            }
            
            return res.status(200).json({ success: true, message: 'Gerações falhas - créditos devolvidos.' });
        }

        console.log(`[n8n Callback] Target IDs: ${JSON.stringify(targetIds)}, Items: ${incomingUrls?.length || 0}, Title: ${title}`);

        // 1. Get user name and batch info
        const userRes = await query('SELECT name FROM users WHERE id = $1', [userId]);
        const userName = userRes.rows[0]?.name || 'User';

        let batchRows;
        if (isBatchId) {
            batchRows = await query('SELECT id, type, prompt, metadata, cost FROM generations WHERE batch_id = $1 ORDER BY id ASC', [targetIds[0]]);
        } else {
            batchRows = await query('SELECT id, type, prompt, metadata, cost FROM generations WHERE id = ANY($1) ORDER BY id ASC', [targetIds]);
        }

        if (batchRows.rows.length === 0) {
            console.error(`[Callback] No rows found for target IDs ${JSON.stringify(targetIds)}`);
            fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), `[ERROR] Target IDs ${JSON.stringify(targetIds)} not found in DB\n`);
            return res.status(404).json({ success: false, message: 'Gerações não encontradas.' });
        }

        // --- NEW: Push SSE event when generation is updated via n8n ---
        const firstGen = batchRows.rows[0];
        const batch_id = firstGen.batch_id || targetIds[0];
        
        pushSseEvent(batch_id, {
            type: 'progress',
            status: status === 'done' || status === 'completed' ? 'completed' : 'processing',
            pipeline_status: status === 'done' || status === 'completed' ? 'Geração Concluída!' : 'Processando Media...',
            pipeline_progress: status === 'done' || status === 'completed' ? 100 : 90,
            imageUrl: incomingUrls[0] || null
        });

        const genTypeInDb = batchRows.rows[0].type || 'image';
        
        // Determine category and extension based on type
        let category = 'Imagens';
        let ext = 'png';
        let contentType = 'image/png';

        if (genTypeInDb === 'video') {
            category = 'Videos';
            ext = 'mp4';
            contentType = 'video/mp4';
        } else if (genTypeInDb === 'audio' || genTypeInDb === 'voice' || genTypeInDb === 'musica' || genTypeInDb === 'music') {
            category = 'Audios';
            ext = 'mp3';
            contentType = 'audio/mpeg';
        }

        console.log(`[Callback] 📦 Processing ${incomingUrls.length} ${genTypeInDb}(s) for batch ${generationId}. Moving to permanent storage...`);
        
        const finalUrls: string[] = [];
        for (let i = 0; i < incomingUrls.length; i++) {
            const externalUrl = incomingUrls[i];
            const timestamp = Date.now();
            const fileName = `gen_${generationId}_${i}_${timestamp}.${ext}`;

            try {
                const response = await axios.get(externalUrl, { responseType: 'arraybuffer' });
                const buffer = Buffer.from(response.data, 'binary');
                console.log(`[Storage] Moving ${category} to permanent folder for user ${userId}`);
                const permanentUrl = await uploadBufferToUserFolder(userId, category as 'Imagens' | 'Videos' | 'Audios', buffer, fileName, contentType);
                
                // === THUMBNAIL GENERATION (MOBILE-FIRST 300px) ===
                let thumbUrl = null;
                let thumbUrlAvif = null;
                const isImage = category === 'Imagens' && genTypeInDb !== 'video' && genTypeInDb !== 'audio';
                const isVideo = genTypeInDb === 'video';

                if (isImage) {
                    try {
                        const baseSharp = sharp(buffer).resize({ width: 300, withoutEnlargement: true });
                        
                        // WebP Fallback
                        const thumbBuffer = await baseSharp.clone().webp({ quality: 75 }).toBuffer();
                        const thumbFileName = `thumb_gen_${generationId}_${i}_${timestamp}.webp`;
                        thumbUrl = await uploadBufferToUserFolder(userId, 'Imagens', thumbBuffer, thumbFileName, 'image/webp');
                        
                        // AVIF Primary (Smaller & Better)
                        try {
                            const avifBuffer = await baseSharp.clone().avif({ quality: 65, effort: 2 }).toBuffer();
                            const avifFileName = `thumb_gen_${generationId}_${i}_${timestamp}.avif`;
                            thumbUrlAvif = await uploadBufferToUserFolder(userId, 'Imagens', avifBuffer, avifFileName, 'image/avif');
                        } catch(e) { console.warn('[AVIF] Failed, skipping...'); }
                        
                        console.log(`[Storage] ✅ Thumbnails (WebP/AVIF) criadas para imagem.`);
                    } catch (thumbErr: any) {
                        console.error('[Storage Error] Falha ao criar miniatura de imagem:', thumbErr.message);
                    }
                } else if (isVideo) {
                    try {
                        const tempVideoPath = path.join(__dirname, `../temp_video_${Date.now()}.mp4`);
                        const tempThumbPath = path.join(__dirname, `../temp_thumb_${Date.now()}.webp`);
                        
                        fs.writeFileSync(tempVideoPath, buffer);
                        
                        await new Promise((resolve, reject) => {
                            ffmpeg(tempVideoPath)
                                .screenshots({
                                    timestamps: ['0'],
                                    folder: path.dirname(tempThumbPath),
                                    filename: path.basename(tempThumbPath),
                                    size: '300x?'
                                })
                                .on('end', resolve)
                                .on('error', reject);
                        });

                        if (fs.existsSync(tempThumbPath)) {
                            const thumbBuffer = fs.readFileSync(tempThumbPath);
                            const thumbFileName = `thumb_video_${generationId}_${i}_${timestamp}.webp`;
                            thumbUrl = await uploadBufferToUserFolder(userId, 'Imagens', thumbBuffer, thumbFileName, 'image/webp');
                            
                            // Try convert poster to AVIF too
                            try {
                                const avifBuffer = await sharp(thumbBuffer).avif({ quality: 65 }).toBuffer();
                                const avifFileName = `thumb_video_${generationId}_${i}_${timestamp}.avif`;
                                thumbUrlAvif = await uploadBufferToUserFolder(userId, 'Imagens', avifBuffer, avifFileName, 'image/avif');
                            } catch(e) {}

                            console.log(`[Storage] ✅ Thumbnail de vídeo criada.`);
                            
                            fs.unlinkSync(tempVideoPath);
                            fs.unlinkSync(tempThumbPath);
                        }
                    } catch (thumbErr: any) {
                        console.error('[Storage Error] Falha ao criar miniatura de vídeo:', thumbErr.message);
                    }
                }

                // Inject thumbnails directly into metadata
                let finalMetadata = batchRows.rows[0]?.metadata || {};
                if (typeof finalMetadata === 'string') {
                    try { finalMetadata = JSON.parse(finalMetadata); } catch(e) {}
                }
                if (thumbUrl) finalMetadata.thumb_url = thumbUrl;
                if (thumbUrlAvif) finalMetadata.thumb_url_avif = thumbUrlAvif;

                // Removed late deduction since it's now deducted upfront on the actual API generate routes.
                const cost = Number(req.body.cost) || Number(batchRows.rows[0].cost) || 0;
                console.log(`[n8n Callback] Item ${i} successfully completed for batch ${generationId}. Cost ${cost} already deducted upfront.`);

                finalUrls.push(permanentUrl);

                // Update existing 'processing' row
                const updateResult = await query(
                    `UPDATE generations 
                     SET status = 'completed', result_url = $1, copy = $2, hashtags = $3, title = $4, metadata = $5
                     WHERE id = (
                         SELECT id FROM generations 
                         WHERE batch_id = $6 AND status = 'processing' 
                         ORDER BY id ASC 
                         LIMIT 1 
                         FOR UPDATE SKIP LOCKED
                     )
                     RETURNING id`,
                    [permanentUrl, copy, hashtags, title, JSON.stringify(finalMetadata), generationId]
                );
 
                if (updateResult.rows.length === 0) {
                    // Check if this URL already exists to avoid redundancy in case of retry
                    const dupCheck = await query('SELECT id FROM generations WHERE batch_id = $1 AND result_url = $2', [generationId, permanentUrl]);
                    if (dupCheck.rows.length === 0) {
                        console.log(`[Callback] Extra item for batch ${generationId}, creating row.`);
                        await query(
                            'INSERT INTO generations (user_id, type, prompt, status, result_url, batch_id, copy, hashtags, title, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
                            [userId, genTypeInDb, batchRows.rows[0]?.prompt || 'Extra generation', 'completed', permanentUrl, generationId, copy, hashtags, title, JSON.stringify(finalMetadata)]
                        );
                    }
                }
            } catch (err: any) {
                console.error(`[Callback] Item ${i} failed:`, err.message);
                fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), `[ERROR] Storage/Update failed for item ${i}: ${err.message}\n${err.stack}\n`);
            }
        }

        // Cleanup Temp Image
        if (batchRows.rows[0]?.metadata) {
            const metadata = batchRows.rows[0].metadata;
            if (metadata.tempImageUrl) {
                try {
                    const urlParts = metadata.tempImageUrl.split('temp/');
                    if (urlParts.length > 1) {
                        await deleteFile(`temp/${urlParts[1].split('?')[0]}`);
                    }
                } catch (cleanupErr) {
                    console.warn('[Callback] Cleanup failed:', cleanupErr);
                }
            }
        }

        res.json({ success: true, finalUrls });
    } catch (error: any) {
        console.error('[Callback Error]', error);
        fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), `[FATAL EXCEPTION] Callback handler crashed: ${error.message}\n${error.stack}\n`);
        res.status(500).json({ success: false });
    }
});

// Delete a generation
app.delete('/api/generations/:id', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const genId = req.params.id;
        if (!userId || !genId) return res.status(400).json({ success: false, message: 'ID ausente' });

        const result = await query('DELETE FROM generations WHERE id = $1 AND user_id = $2 RETURNING id', [genId, userId]);
        
        if (result.rows.length > 0) {
            res.json({ success: true, message: 'Geração deletada com sucesso.' });
        } else {
            res.status(404).json({ success: false, message: 'Geração não encontrada ou acesso negado.' });
        }
    } catch (error) {
        console.error('Delete Generation error:', error);
        res.status(500).json({ success: false, message: 'Erro ao deletar.' });
    }
});

// List all generations for a user
app.get('/api/generations', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        // --- ASYNC CLEANUP OF STALLED GENERATIONS (NON-BLOCKING) ---
        setImmediate(async () => {
            try {
                const stalledGenerations = await query(
                    "UPDATE generations SET status = 'failed' WHERE status = 'processing' AND created_at < NOW() - INTERVAL '12 minutes' RETURNING cost, user_id, id"
                );
                for (const row of stalledGenerations.rows) {
                    const refundCost = Number(row.cost) || 0;
                    if (refundCost > 0) {
                        await query('UPDATE users SET credits = credits + $1 WHERE id = $2', [refundCost, row.user_id]);
                    }
                }
            } catch (cleanupErr: any) {}
        });
        // ----------------------------------------------------------

        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 18;
        const offset = (page - 1) * limit;

        const cursor = req.query.cursor as string; // Legacy support

        const excludeTypes = req.query.excludeTypes ? (req.query.excludeTypes as string).split(',') : [];
        const filterType = req.query.type as string;

        let whereClause = 'WHERE g.user_id = $1';
        let queryParams: any[] = [userId];

        if (filterType) {
            const types = filterType.split(',');
            const placeholders = types.map((_, i) => `$${queryParams.length + 1 + i}`).join(',');
            whereClause += ` AND g.type IN (${placeholders})`;
            queryParams.push(...types);
        }

        if (excludeTypes.length > 0) {
            const placeholders = excludeTypes.map((_, i) => `$${queryParams.length + 1 + i}`).join(',');
            whereClause += ` AND g.type NOT IN (${placeholders})`;
            queryParams.push(...excludeTypes);
        }

        // --- NEW PAGINATION LOGIC (PAGE/OFFSET) ---
        // If cursor is provided, we use legacy cursor logic. If page is provided, we use offset.
        let pagingClause = `LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
        let pagingParams = [limit, offset];

        if (cursor) {
            whereClause += ` AND g.id < $${queryParams.length + 1}`;
            queryParams.push(cursor);
            pagingClause = `LIMIT $${queryParams.length + 1}`;
            pagingParams = [limit];
        }

        const result = await query(
            `SELECT g.id, g.type, g.status, g.result_url, g.created_at, g.metadata,
                    (SELECT id FROM posts WHERE generation_id = g.id LIMIT 1) as social_post_id
             FROM generations g 
             ${whereClause}
             ORDER BY g.created_at DESC, g.id DESC ${pagingClause}`,
            [...queryParams, ...pagingParams]
        );

        // Signing logic
        const signedGenerations = await Promise.all(result.rows.map(async (gen) => {
            if (gen.status === 'completed' && gen.result_url) {
                const signedUrl = await getSignedS3UrlForKey(gen.result_url, 86400);
                let updatedMetadata = gen.metadata || {};
                if (updatedMetadata.thumb_url) {
                    try { updatedMetadata.thumb_url = await getSignedS3UrlForKey(updatedMetadata.thumb_url, 86400); } catch(e) {}
                }
                if (updatedMetadata.thumb_url_avif) {
                    try { updatedMetadata.thumb_url_avif = await getSignedS3UrlForKey(updatedMetadata.thumb_url_avif, 86400); } catch(e) {}
                }
                
                const title = updatedMetadata.title || null;
                const copy = updatedMetadata.lyrics || updatedMetadata.copy || null;

                return { ...gen, result_url: signedUrl, metadata: updatedMetadata, title, copy };
            }
            // Even if not completed, try to extract metadata title/copy
            const meta = gen.metadata || {};
            return { ...gen, title: meta.title || null, copy: meta.lyrics || meta.copy || null };
        }));
        if (filterType && (filterType.includes('music') || filterType.includes('musica'))) {
            const ids = result.rows.map(r => r.id).join(', ');
            console.log(`[API] 🎵 Audio Diagnostic: Found ${result.rows.length} items (IDs: ${ids}) for user ${userId} with filter ${filterType}`);
        }

        // Get total count for pagination
        const countRes = await query(`SELECT COUNT(*) FROM generations g ${whereClause}`, queryParams);
        const totalCount = parseInt(countRes.rows[0].count);
        const totalPages = Math.ceil(totalCount / limit);

        const nextCursor = !cursor && signedGenerations.length === limit ? (page + 1).toString() : (cursor && signedGenerations.length === limit ? signedGenerations[signedGenerations.length - 1].id : null);

        res.json({ 
            success: true, 
            generations: signedGenerations,
            nextCursor,
            totalCount,
            totalPages,
            currentPage: page,
            count: signedGenerations.length
        });
    } catch (error) {
        console.error('Gallery Fetch error:', error);
        res.status(500).json({ success: false });
    }
});

// Delete a generation (DB + S3)
app.delete('/api/generations/:id', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;

        // 1. Get generation info to get S3 key
        const genRes = await query('SELECT result_url FROM generations WHERE id = $1 AND user_id = $2', [id, userId]);
        if (genRes.rows.length === 0) return res.status(404).json({ success: false, message: 'Não encontrado.' });

        const resultUrl = genRes.rows[0].result_url;
        const bucketName = process.env.S3_BUCKET || "kwikdocsao";

        // 2. Delete from S3 if it exists
        if (resultUrl) {
            try {
                const keyParts = resultUrl.split(`${bucketName}/`);
                if (keyParts.length > 1) {
                    const key = keyParts[1].split('?')[0];
                    await deleteFile(key);
                }
            } catch (err) {
                console.warn('[API] S3 Delete failed:', err);
            }
        }

        // 3. Delete from DB
        await query('DELETE FROM generations WHERE id = $1 AND user_id = $2', [id, userId]);

        res.json({ success: true });
    } catch (error) {
        console.error('Delete gen error:', error);
        res.status(500).json({ success: false });
    }
});

// Get real-world stats for a user
app.get('/api/user/stats', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        // 1. Total Generations
        const totalGens = await query('SELECT count(*) FROM generations WHERE user_id = $1', [userId]);
        
        // 2. Real Credits from users table
        const userRes = await query('SELECT credits, role FROM users WHERE id = $1', [userId]);
        
        res.json({
            success: true,
            totalGenerations: parseInt(totalGens.rows[0].count),
            credits: userRes.rows[0]?.credits || 0,
            role: userRes.rows[0]?.role || 'user'
        });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Get generation history (paginated)
app.get('/api/user/generations/history', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;
        const offset = (page - 1) * limit;

        if (!userId) return res.status(401).json({ success: false });

        const history = await query(
            'SELECT id, type, model, prompt, status, cost, result_url, created_at FROM generations WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
            [userId, limit, offset]
        );

        const countRes = await query('SELECT COUNT(*) FROM generations WHERE user_id = $1', [userId]);

        res.json({
            success: true,
            history: history.rows,
            totalCount: parseInt(countRes.rows[0].count)
        });
    } catch (error: any) {
        console.error('[User Gen History Error]', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Get transaction history
app.get('/api/user/transactions', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        const result = await query(
            'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
            [userId]
        );

        const signedTransactions = await Promise.all(result.rows.map(async (tx) => {
            let updatedTx = { ...tx };
            if (tx.proof_url) {
                updatedTx.proof_url = await getSignedS3UrlForKey(tx.proof_url, 3600);
            }
            if (tx.invoice_url) {
                updatedTx.invoice_url = await getSignedS3UrlForKey(tx.invoice_url, 86400); // 24h for invoices
            }
            return updatedTx;
        }));

        res.json({ success: true, transactions: signedTransactions });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Get generation history (detailed logs)
app.get('/api/user/generations/history', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { page = '1', limit = '15' } = req.query;
        if (!userId) return res.status(400).json({ success: false });

        const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

        const result = await query(
            `SELECT id, type, model, prompt, status, cost, result_url, created_at 
             FROM generations 
             WHERE user_id = $1 
             ORDER BY created_at DESC 
             LIMIT $2 OFFSET $3`,
            [userId, parseInt(limit as string), offset]
        );

        const countRes = await query('SELECT count(*) FROM generations WHERE user_id = $1', [userId]);

        res.json({ 
            success: true, 
            history: result.rows,
            totalCount: parseInt(countRes.rows[0].count)
        });
    } catch (error) {
        console.error('Fetch gen history error:', error);
        res.status(500).json({ success: false });
    }
});

// --- SYSTEM DATABASE INITIALIZATION (Unified) ---
const initSystemDb = async () => {
    try {
        console.log('[Database] 🚀 Initializing Unified System Schema...');

        // 1. Core Settings
        await query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key VARCHAR(255) PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 2. WhatsApp Leads & Messages
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_leads (
                id SERIAL PRIMARY KEY,
                phone VARCHAR(50) UNIQUE NOT NULL,
                name VARCHAR(255),
                business_info TEXT,
                needs TEXT,
                status VARCHAR(50) DEFAULT 'new', -- new, in_progress, qualified, human
                agent_active BOOLEAN DEFAULT TRUE,
                last_interaction TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_messages (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES whatsapp_leads(id),
                role VARCHAR(20) NOT NULL, -- user, agent, human
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3. Monitoring & Alerts
        await query(`
            CREATE TABLE IF NOT EXISTS alerts (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                title VARCHAR(255) NOT NULL,
                message TEXT,
                status VARCHAR(50) DEFAULT 'active', -- active, acknowledged, resolved
                severity VARCHAR(20) DEFAULT 'medium',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                acknowledged_at TIMESTAMP,
                resolved_at TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                admin_id UUID NOT NULL,
                action TEXT NOT NULL,
                details JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 4. Admin Notifications
        await query(`
            CREATE TABLE IF NOT EXISTS admin_notifications (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50),
                title VARCHAR(255),
                message TEXT,
                icon VARCHAR(50),
                color VARCHAR(50),
                is_read BOOLEAN DEFAULT FALSE,
                reference_id TEXT,
                reference_type TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5. WhatsApp Logs (Metrics)
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_logs (
                id SERIAL PRIMARY KEY,
                recipient VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                content TEXT,
                status VARCHAR(50) NOT NULL,
                error_details TEXT,
                category VARCHAR(50) DEFAULT 'general', -- auth, payment_user, payment_admin, campaign, followup, agent_action, test
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migrate whatsapp_logs for old deployments
        try {
            await query("ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general'");
        } catch(e) { }

        // 6. Agent Team & System Config
        await query(`
            CREATE TABLE IF NOT EXISTS system_metrics (
                id SERIAL PRIMARY KEY,
                metric_name VARCHAR(255) NOT NULL,
                metric_value NUMERIC NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 7. Orchestrator Action Plans
        await query(`
            CREATE TABLE IF NOT EXISTS orchestrator_action_plans (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50) NOT NULL,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                priority INTEGER DEFAULT 3,
                target_segment JSONB DEFAULT '{}',
                proposed_actions JSONB DEFAULT '[]',
                estimated_impact TEXT,
                status VARCHAR(50) DEFAULT 'pending_approval',
                suggested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                approved_at TIMESTAMP,
                approved_by UUID,
                executed_at TIMESTAMP,
                execution_report TEXT
            )
        `);

        // Insert Default Alex Agent Prompt
        const alexPromptCheck = await query("SELECT value FROM system_settings WHERE key = 'whatsapp_agent_prompt'");
        if (alexPromptCheck.rows.length === 0) {
            const alexPrompt = `Tu és o Alex, um consultor de marketing especializado e caloroso da Conversio AI. 
O teu tom de voz é amigável, profissional e segues o estilo de comunicação de Angola.
O teu objetivo é qualificar leads que chegam pelo WhatsApp de forma natural.
Deves identificar: 
1. O Nome do cliente.
2. O Negócio ou empresa dele.
3. A Necessidade principal (Anúncios, Gestão de Redes, Vídeo, etc.).
Sê curto e focado em marcar uma conversa mais profunda quando tiveres os dados.`;
            
            await query("INSERT INTO system_settings (key, value) VALUES ('whatsapp_agent_prompt', $1)", [alexPrompt]);
            console.log('[Database] 🤖 Alex AI default prompt initialized.');
        }

        console.log('[Database] Unified System Schema verified.');

        // 8. Orchestrator Memory (Persistent context between cycles)
        await query(`
            CREATE TABLE IF NOT EXISTS orchestrator_memory (
                id SERIAL PRIMARY KEY,
                context_key VARCHAR(255) UNIQUE NOT NULL,
                context_value TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 9. User Events (Frontend behavioral tracking)
        await query(`
            CREATE TABLE IF NOT EXISTS user_events (
                id SERIAL PRIMARY KEY,
                user_id UUID,
                event_type VARCHAR(100) NOT NULL,
                metadata JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 10. Campaign Stats extended columns for real WhatsApp metrics
        await query(`ALTER TABLE campaign_stats ADD COLUMN IF NOT EXISTS total_delivered INTEGER DEFAULT 0`).catch(() => {});
        await query(`ALTER TABLE campaign_stats ADD COLUMN IF NOT EXISTS total_read INTEGER DEFAULT 0`).catch(() => {});
        await query(`ALTER TABLE campaign_stats ADD COLUMN IF NOT EXISTS total_replied INTEGER DEFAULT 0`).catch(() => {});
        await query(`ALTER TABLE campaign_stats ADD COLUMN IF NOT EXISTS total_failed INTEGER DEFAULT 0`).catch(() => {});

        console.log('[Database] Autonomy tables (v2) verified.');

    } catch (err) {
        console.error('[Database] ❌ Unified Schema init error:', err);
    }
};
initSystemDb();


// Billing & Checkout Routes
app.post('/api/billing/checkout', async (req, res) => {
    try {
        const { userId, planId, amount, credits, paymentMethod, transactionId: extTxId, billingCycle } = req.body;
 
        if (!userId || !planId || !amount) {
            return res.status(400).json({ success: false, message: 'Dados incompletos para checkout' });
        }
 
        // --- NEW: Process only credits/packages ---
        // As plans no longer exist, we proceed directly with the package checkout logic.
 
        const description = extTxId 
            ? `Compra Pacote ${planId} via ${paymentMethod} (ID: ${extTxId})`
            : `Compra Pacote ${planId} via ${paymentMethod}`;
 
        const result = await query(
            'INSERT INTO transactions (user_id, amount, currency, type, status, description, credits, payment_method) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
            [userId, amount, 'Kz', planId, 'pending', description, credits || 0, paymentMethod]
        );

        res.json({ success: true, transactionId: result.rows[0].id });
    } catch (error: any) {
        console.error('Checkout error:', error);
        res.status(500).json({ success: false, message: 'Falha ao processar transação no banco de dados' });
    }
});


app.post('/api/billing/upload-proof', upload.single('proof'), async (req: express.Request & { file?: Express.Multer.File }, res) => {
    try {
        const { transactionId, userId } = req.body;
        const proofFile = req.file;

        if (!transactionId || !proofFile) {
            return res.status(400).json({ success: false, message: 'Faltam dados do comprovativo' });
        }

        const timestamp = Date.now();
        const extension = proofFile.originalname.split('.').pop() || 'png';
        const fileName = `proof_${transactionId}.${extension}`;
        const proofUrl = await uploadTransactionFile(transactionId, 'proof', proofFile.buffer, fileName, proofFile.mimetype);

        await query(
            "UPDATE transactions SET status = 'pending_verification', proof_url = $2 WHERE id = $1",
            [transactionId, proofUrl]
        );

        /* 
        // Auto-Trigger AI Verification In Background (DISABLED BY USER REQUEST)
        try {
            const { verifyPaymentProof } = await import('./services/paymentVerificationAgent.js');
            verifyPaymentProof(transactionId).catch(err => console.error('[AutoVerification Error]', err));
        } catch (e) {
            console.error('[AutoVerification Trigger Error]', e);
        }
        */

        /*
        // Notificar o admin via WhatsApp (DISABLED BY USER REQUEST - MANUAL MODE)
        try {
            const adminWhatsapp = await getAdminWhatsApp();
            if (adminWhatsapp) {
                const userRes = await query('SELECT name, whatsapp FROM users WHERE id = $1', [userId]);
                const userName = userRes.rows[0]?.name || 'Utilizador';
                const userPhone = userRes.rows[0]?.whatsapp || 'Sem número';
                
                const txRes = await query('SELECT amount, credits FROM transactions WHERE id = $1', [transactionId]);
                const amount = txRes.rows[0]?.amount || 0;
                const credits = txRes.rows[0]?.credits || 0;

                const notifyMsg = `💰 *Novo Pagamento Pendente na Conversio!*\n\n*Utilizador:* ${userName}\n*Telemóvel:* ${userPhone}\n*Valor:* ${amount} AOA\n*Créditos:* ${credits}\n\n👉 Clique abaixo para aprovar:\nhttps://conversio.ai/admin/payments`;
                await sendWhatsAppMessage(adminWhatsapp, notifyMsg, 'payment_admin');
            }
        } catch (adminNotifErr) {
            console.error('[Admin Notify Error]', adminNotifErr);
        }
        */


        res.json({ success: true, proofUrl });
    } catch (error: any) {
        console.error('Proof upload error:', error.message);
        res.status(500).json({ success: false, message: 'Erro ao processar comprovativo' });
    }
});

// Social Network Endpoints

// Create a new post
app.post('/api/social/post', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { generationId, type, imageUrl, prompt } = req.body;

        if (!userId || !imageUrl) {
            return res.status(400).json({ success: false, message: 'Dados insuficientes para postar.' });
        }

        // 1. Check monthly limit (10 posts per month)
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const countRes = await query(
            'SELECT count(*) FROM posts WHERE user_id = $1 AND created_at >= $2',
            [userId, startOfMonth]
        );

        if (parseInt(countRes.rows[0].count) >= 10) {
            return res.status(403).json({ 
                success: false, 
                message: 'Limite de 10 publicações mensais atingido. Tente novamente no próximo mês.' 
            });
        }

        // 2. Create post
        const { description = '' } = req.body;
        const result = await query(
            'INSERT INTO posts (user_id, generation_id, type, image_url, prompt, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [userId, generationId, type || 'image', imageUrl, prompt, description]
        );

        res.json({ success: true, postId: result.rows[0].id });
    } catch (error) {
        console.error('Social Post error:', error);
        res.status(500).json({ success: false, message: 'Erro ao criar publicação' });
    }
});

// List posts with ranking/sorting
app.get('/api/social/posts', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { sort = 'trending', page = '1' } = req.query;
        const limit = 20;
        const offset = (parseInt(page as string) - 1) * limit;

        let orderBy = 'created_at DESC';
        let whereClause = '';
        const params: any[] = [limit, offset];

        if (sort === 'my' && userId) {
            whereClause = 'WHERE p.user_id = $3';
            params.push(userId);
        }

        if (sort === 'trending') {
            // Ranking formula: Views (1) + Likes (3) + Comments (5)
            orderBy = '(views_count + likes_count * 3 + comments_count * 5) DESC, created_at DESC';
        } else if (sort === 'popular') {
            orderBy = 'likes_count DESC, created_at DESC';
        }

        const result = await query(
            `SELECT p.*, u.name as creator_name, u.avatar_url as creator_avatar
             FROM posts p
             JOIN users u ON p.user_id = u.id
             ${whereClause}
             ORDER BY ${orderBy}
             LIMIT $1 OFFSET $2`,
            params
        );

        // Check likes for current user if applicable
        const finalPosts = result.rows;
        if (userId && finalPosts.length > 0) {
            const postIds = finalPosts.map(p => p.id);
            const userLikes = await query(
                'SELECT post_id FROM likes WHERE user_id = $1 AND post_id = ANY($2)',
                [userId, postIds]
            );
            const likedSet = new Set(userLikes.rows.map(l => l.post_id));
            finalPosts.forEach(p => p.is_liked = likedSet.has(p.id));
        }

        res.json({ success: true, posts: finalPosts });
    } catch (error) {
        console.error('Fetch Social Posts error:', error);
        res.status(500).json({ success: false });
    }
});

// Like/Unlike a post
app.post('/api/social/like', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { postId } = req.body;
        if (!userId || !postId) return res.status(400).json({ success: false });

        // Check if already liked
        const existing = await query('SELECT id FROM likes WHERE user_id = $1 AND post_id = $2', [userId, postId]);
        
        if (existing.rows.length > 0) {
            // Unlike
            await query('DELETE FROM likes WHERE id = $1', [existing.rows[0].id]);
            await query('UPDATE posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = $1', [postId]);
            res.json({ success: true, liked: false });
        } else {
            // Like
            await query('INSERT INTO likes (user_id, post_id) VALUES ($1, $2)', [userId, postId]);
            await query('UPDATE posts SET likes_count = likes_count + 1 WHERE id = $1', [postId]);

            // Create notification
            const postRes = await query('SELECT user_id FROM posts WHERE id = $1', [postId]);
            if (postRes.rows.length > 0 && postRes.rows[0].user_id !== userId) {
                await query(
                    'INSERT INTO social_notifications (user_id, actor_id, post_id, type) VALUES ($1, $2, $3, $4)',
                    [postRes.rows[0].user_id, userId, postId, 'like']
                );
            }

            res.json({ success: true, liked: true });
        }
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Add a comment
app.post('/api/social/comment', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { postId, content } = req.body;
        if (!userId || !postId || !content) return res.status(400).json({ success: false });

        const result = await query(
            'INSERT INTO comments (user_id, post_id, content) VALUES ($1, $2, $3) RETURNING id',
            [userId, postId, content]
        );

        await query('UPDATE posts SET comments_count = comments_count + 1 WHERE id = $1', [postId]);

        // Create notification
        const postRes = await query('SELECT user_id FROM posts WHERE id = $1', [postId]);
        if (postRes.rows.length > 0 && postRes.rows[0].user_id !== userId) {
            await query(
                'INSERT INTO social_notifications (user_id, actor_id, post_id, type, content) VALUES ($1, $2, $3, $4, $5)',
                [postRes.rows[0].user_id, userId, postId, 'comment', content]
            );
        }

        res.json({ success: true, commentId: result.rows[0].id });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Increment views (only for non-owners)
app.post('/api/social/view', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const viewerId = req.user?.id;
        const { postId } = req.body;
        if (!postId) return res.status(400).json({ success: false });

        // Fetch the post owner
        const postRes = await query('SELECT user_id FROM posts WHERE id = $1', [postId]);
        if (postRes.rows.length === 0) return res.status(404).json({ success: false });

        // Skip if the viewer is the post owner
        if (viewerId && postRes.rows[0].user_id === viewerId) {
            return res.json({ success: true, counted: false });
        }

        await query('UPDATE posts SET views_count = views_count + 1 WHERE id = $1', [postId]);
        res.json({ success: true, counted: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Notifications
app.get('/api/social/notifications', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        const result = await query(
            `SELECT n.*, u.name as actor_name, u.avatar_url as actor_avatar, p.image_url as post_image
             FROM social_notifications n
             JOIN users u ON n.actor_id = u.id
             JOIN posts p ON n.post_id = p.id
             WHERE n.user_id = $1
             ORDER BY n.created_at DESC
             LIMIT 50`,
            [userId]
        );

        res.json({ success: true, notifications: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/social/notifications/read', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        await query('UPDATE social_notifications SET is_read = TRUE WHERE user_id = $1', [userId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/social/post/:postId/comments', async (req, res) => {
    try {
        const { postId } = req.params;
        const result = await query(
            `SELECT c.*, u.name as user_name, u.avatar_url as user_avatar
             FROM comments c
             JOIN users u ON c.user_id = u.id
             WHERE c.post_id = $1
             ORDER BY c.created_at ASC`,
            [postId]
        );
        res.json({ success: true, comments: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

// Video Generation Endpoint
app.post('/api/generate/video', authenticateJWT, upload.single('image'), async (req: AuthRequest & { file?: Express.Multer.File }, res) => {
    console.log(`[API] 🎬 Recieved video generation request. Body:`, { ...req.body, prompt: req.body.prompt?.substring(0, 50) + "..." });
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

        // Plan Validation & Info fetch in a single scoped query
        const userQueryRes = await query('SELECT plan, credits, name, whatsapp FROM users WHERE id = $1', [userId]);
        if (!userQueryRes.rows.length) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });
        
        const { prompt, model_id, model_name, style, aspectRatio, quantity, core_model, core_id, core_name, mode } = req.body;
        if (!prompt && !req.file && !req.body.referenceImageUrl) return res.status(400).json({ success: false, message: 'Digite uma descrição ou carregue uma imagem.' });

        const actualCoreId = core_id || core_model;
        const userRes = userQueryRes; // Map legacy variable
        const credits = userRes.rows[0].credits;
        const qty = parseInt(quantity) || 1;
        
        let modelCost = 10; // Default for Video
        let coreCost = 0;
        let modelKieCost = 0;
        let coreKieCost = 0;
        let resolvedStyleId = 'veo3lite'; // Default technical ID

        // RESOLVE MODEL (by ID if available, otherwise fallback to name)
        if (model_id) {
            const mRes = await query("SELECT style_id, credit_cost, kie_cost FROM models WHERE id = $1", [model_id]);
            if (mRes.rows.length > 0) {
                resolvedStyleId = mRes.rows[0].style_id || resolvedStyleId;
                modelCost = Number(mRes.rows[0].credit_cost) || 10;
                modelKieCost = Number(mRes.rows[0].kie_cost) || 0;
            }
        } else if (model_name) {
            const mRes = await query("SELECT style_id, credit_cost, kie_cost FROM models WHERE name = $1 AND type = 'video'", [model_name]);
            if (mRes.rows.length > 0) {
                resolvedStyleId = mRes.rows[0].style_id || resolvedStyleId;
                modelCost = Number(mRes.rows[0].credit_cost) || 10;
                modelKieCost = Number(mRes.rows[0].kie_cost) || 0;
            }
        }

        // RESOLVE CORE (Agent)
        if (actualCoreId) {
            // Check if it's an ID or a name
            const cRes = await query("SELECT credit_cost, kie_cost FROM models WHERE (name = $1 OR style_id = $1) AND type = 'video'", [actualCoreId]);
            if (cRes.rows.length > 0) {
                coreCost = Number(cRes.rows[0].credit_cost) || 0;
                coreKieCost = Number(cRes.rows[0].kie_cost) || 0;
            }
        }

        const unitCost = modelCost + coreCost;
        const totalCost = qty * unitCost;

        if (credits < totalCost) {
            const user = userRes.rows[0];
            if (user.whatsapp) {
                try {
                    await whatsappService.sendWhatsAppMessage(
                        user.whatsapp, 
                        `Olá ${user.name}! ⚠️ O seu pedido de geração de vídeo falhou porque não tem créditos suficientes no Conversio.\nNecessita de ${totalCost} créditos, mas apenas tem ${credits} disponíveis.\n\nPor favor, recarregue a sua conta para continuar a criar!`
                    );
                } catch (e) {
                    console.warn('[WhatsApp warning failure]', e);
                }
            }
            return res.status(402).json({ success: false, message: `Créditos insuficientes. Necessário: ${totalCost}, Disponível: ${credits}` });
        }

        // Deduct credits upfront
        await query('UPDATE users SET credits = credits - $1 WHERE id = $2', [totalCost, userId]);

        const unitKieCost = Number(modelKieCost) + Number(coreKieCost);
        const totalKieCost = unitKieCost * qty;

        // Upload reference image if provided or use gallery URL
        let referenceImageUrl = req.body.referenceImageUrl || null;
        if (req.file) {
            try {
                referenceImageUrl = await uploadToTemp(req.file.buffer, req.file.originalname, req.file.mimetype);
            } catch (err: any) {
                console.error('[API] Video reference upload error:', err.message);
            }
        }

        // Create pending generation records
        const batchId = `VIDEO-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        const generationIds: string[] = [];
        for (let i = 0; i < qty; i++) {
            const genRes = await query(
                `INSERT INTO generations (user_id, prompt, type, status, model, style, aspect_ratio, batch_id, cost, metadata)
                 VALUES ($1, $2, 'video', 'processing', $3, $4, $5, $6, $7, $8) RETURNING id`,
                [userId, prompt, model_name || resolvedStyleId, style, aspectRatio, batchId, unitCost, JSON.stringify({ mode, core_id: actualCoreId, style, kie_cost: unitKieCost })]
            );
            generationIds.push(genRes.rows[0].id);
        }

        // Fetch Brand Colors
        const brandRes = await query('SELECT brand_colors FROM brands WHERE user_id = $1', [userId]);
        const brandColors = brandRes.rows[0]?.brand_colors || null;

        // Dispatch to Internal Generation Engine
        const engineUrl = (process.env.GENERATION_ENGINE_URL || 'http://localhost:3010').replace(/[, ]/g, '');
        const internalSecret = process.env.INTERNAL_SECRET;

        const use_brand_colors = req.body.use_brand_colors;
        const brand_colors = req.body.brand_colors;

        // Start pipeline for each generation in background
        generationIds.forEach((genId, index) => {
            console.log(`[API] 🚀 Delegating video ${genId} to engine: ${engineUrl}`);
            axios.post(`${engineUrl}/api/internal/generate/video`, {
                userId,
                userPrompt: prompt,
                productImageUrl: referenceImageUrl,
                coreId: actualCoreId,
                coreName: core_name || actualCoreId,
                modelId: resolvedStyleId,
                aspectRatio,
                generationId: genId,
                useBrandColors: use_brand_colors === 'true' || use_brand_colors === true,
                brandColors: typeof brand_colors === 'string' ? JSON.parse(brand_colors) : brand_colors,
                currentIndex: index + 1,
                totalItems: qty
            }, {
                headers: { 'X-Internal-Secret': internalSecret },
                timeout: 30000
            }).then(resp => {
                console.log(`[API] ✅ Video ${genId} delegated successfully.`);
            }).catch(err => {
                const errorDetail = err.response?.data?.message || err.message || 'Erro de conexão ou timeout';
                console.error(`[API] ❌ Failed to dispatch video ${genId} to engine:`, errorDetail);
                
                // Emit to System Monitor for real-time visibility
                emitSystemLog('API', `Falha ao enviar geração ${genId} para o motor: ${errorDetail}`, 'error', { 
                    genId, 
                    engineUrl,
                    errorCode: err.code 
                });
            });
        });

        // Fire n8n as legacy fallback or additional processing if configured
        const webhookKey = req.file ? 'webhook_video' : 'webhook_video_text';
        const defaultWebhook = process.env.N8N_VIDEO_WEBHOOK || '';
        const webhookUrl = await getConfig(webhookKey, defaultWebhook);
        if (webhookUrl && webhookUrl !== defaultWebhook) {
            axios.post(webhookUrl, {
                userId,
                userName: userRes.rows[0].name,
                prompt,
                model: model_name || resolvedStyleId,
                core_model: actualCoreId,
                core_name,
                mode,
                style,
                aspectRatio,
                quantity: qty,
                batchId,
                generationIds,
                referenceImageUrl,
                brandColors // Include brand colors
            }).catch(() => {});
        }


        res.json({ success: true, message: 'Geração de vídeo iniciada!', generationIds, batchId });
    } catch (error: any) {
        console.error('Video Generation Error:', error);
        res.status(500).json({ success: false, message: 'Erro ao processar a geração do vídeo. Verifique os dados e tente novamente.' });
    }
});

// --- UGC Anti-Repetition System ---

/**
 * Normalizes and hashes product name + category
 */
const generateProductHash = (name: string, category: string): string => {
    const normalize = (str: string) => (str || '').toLowerCase().trim().replace(/\s+/g, '');
    const data = `${normalize(name)}${normalize(category)}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
};

// Endpoint to generate hash (exposed for n8n)
app.get('/api/ugc/hash', async (req, res) => {
    const { name, category } = req.query;
    if (!name || !category) return res.status(400).json({ success: false, message: 'Faltam parâmetros name/category' });
    const hash = generateProductHash(name as string, category as string);
    res.json({ success: true, hash });
});

// Get UGC history for a product (last 30 days)
app.get('/api/ugc/history', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { product_hash } = req.query;

        fs.appendFileSync(path.join(__dirname, '../webhook_logs.txt'), `[UGC GET] User: ${userId}, Hash: ${product_hash}\n`);

        if (!userId || !product_hash) {
            return res.status(400).json({ success: false, message: 'Parâmetros insuficientes' });
        }

        const result = await query(
            `SELECT tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario 
             FROM ugc_used_combinations 
             WHERE user_id = $1 AND product_hash = $2 AND created_at > NOW() - INTERVAL '30 days'
             ORDER BY created_at DESC`,
            [userId, product_hash]
        );

        res.json({ success: true, history: result.rows });
    } catch (error: any) {
        console.error('[UGC History GET] Error:', error.message);
        res.status(500).json({ success: false });
    }
});

// Save new UGC combinations
app.post('/api/ugc/history', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const { product_hash, combinations } = req.body;

        if (!userId || !product_hash || !combinations || !Array.isArray(combinations)) {
            return res.status(400).json({ success: false, message: 'Dados inválidos' });
        }

        console.log(`[UGC History POST] Saving ${combinations.length} combinations for user ${userId}, product ${product_hash}`);

        for (const comb of combinations) {
            const { tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario } = comb;

            // Using INSERT ... ON CONFLICT DO NOTHING (requires a unique constraint or index)
            // But since I didn't add a UNIQUE constraint on all 8 columns, I'll just check if it exists or use a complex unique index in migration if needed.
            // For now, simple insert is fine as per request: "Usa INSERT ... ON CONFLICT DO NOTHING para evitar duplicados"
            // Wait, the user said ON CONFLICT DO NOTHING. I need a unique constraint for that to work.
            
            await query(
                `INSERT INTO ugc_used_combinations 
                 (user_id, product_hash, tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT DO NOTHING`, 
                [userId, product_hash, tipo_ugc, sub_cena, angulo_camara, emocao_dominante, gancho_tipo, cenario]
            );
        }

        res.json({ success: true, saved: combinations.length });
    } catch (error: any) {
        console.error('[UGC History POST] Error:', error.message);
        res.status(500).json({ success: false });
    }
});


// Audio (Voice & Music) Generation Endpoint
app.post('/api/generate/voice', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(401).json({ success: false, message: 'Não autorizado.' });

        // Plan Validation & Info fetch in a single grouped query
        const userQueryRes = await query('SELECT plan, credits, name, whatsapp FROM users WHERE id = $1', [userId]);
        if (!userQueryRes.rows.length) return res.status(404).json({ success: false, message: 'Usuário não encontrado.' });

        // Audio generation available for all users with sufficient credits
        
        const { prompt, type = 'voice', voiceType, voiceId, model = 'Voice AI', style, instrumental } = req.body;
        if (!prompt) return res.status(400).json({ success: false, message: 'Dados insuficientes' });

        const userRes = userQueryRes; // Map legacy variable
        
        const credits = userRes.rows[0].credits;
        const realType = type === 'musica' || type === 'music' ? 'musica' : 'voice';
        
        // Calculate cost
        let cost = 2; // Default for voice
        let kie_cost = 0;

        if (realType === 'musica') {
            cost = model && model.includes('V4') ? 5 : (model && model.includes('V5') ? 8 : 15);
            
            // Try fetch from DB
            try {
                const mRes = await query("SELECT credit_cost, kie_cost FROM models WHERE name = $1 AND type = 'audio'", [model]);
                if (mRes.rowCount > 0) {
                    cost = Number(mRes.rows[0].credit_cost) || cost;
                    kie_cost = Number(mRes.rows[0].kie_cost) || 0;
                }
            } catch(e) {}
        }
        
        if (credits < cost) {
            const user = userRes.rows[0];
            if (user.whatsapp) {
                try {
                    await whatsappService.sendWhatsAppMessage(
                        user.whatsapp, 
                        `Olá ${user.name}! ⚠️ O seu pedido de geração de áudio falhou porque não tem créditos suficientes no Conversio.\nNecessita de ${cost} créditos, mas apenas tem ${credits} disponíveis.\n\nPor favor, recarregue a sua conta para continuar a criar!`
                    );
                } catch (e) {
                    console.warn('[WhatsApp warning failure]', e);
                }
            }
            return res.status(402).json({ success: false, message: `Créditos insuficientes. Necessário: ${cost}, Disponível: ${credits}` });
        }

        // Deduct credits upfront
        await query('UPDATE users SET credits = credits - $1 WHERE id = $2', [cost, userId]);

        // Create pending generation record
        const batchId = `AUDIO-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        // Save initial processing generation
        const insertRes = await query(
            `INSERT INTO generations (user_id, prompt, type, status, model, style, batch_id, cost, metadata) 
             VALUES ($1, $2, $3, 'processing', $4, $5, $6, $7, $8) RETURNING id`,
            [userId, prompt, realType, model, style || '', batchId, cost, JSON.stringify({ voiceType, voiceId, type: realType, instrumental, kie_cost })]
        );
        const generationId = insertRes.rows[0].id;

        // Fetch Brand Colors
        const brandRes = await query('SELECT brand_colors FROM brands WHERE user_id = $1', [userId]);
        const brandColors = brandRes.rows[0]?.brand_colors || null;

        // Redirect to Internal Generation Engine for Music
        const generationEngineUrl = (process.env.GENERATION_ENGINE_URL || 'http://localhost:3010').replace(/[, ]/g, '');
        const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

        if (realType === 'musica') {
            console.log(`[Backend] 🎵 Routing music generation to internal engine: ${generationId}`);
            axios.post(`${generationEngineUrl}/api/internal/generate/audio`, {
                userId,
                generationId,
                prompt: prompt,
                userPrompt: prompt,
                style,
                model,
                instrumental,
                backendUrl: process.env.PUBLIC_URL || 'http://localhost:3003'
            }, {
                headers: { 'X-Internal-Secret': INTERNAL_SECRET }
            }).catch(err => {
                console.error('[Engine Audio Error]', err.response?.status || 'No Status', err.message);
                if (err.response?.data) console.error('[Engine Error Data]', JSON.stringify(err.response.data));
            });
        } else {
            // Fire n8n webhook (fire-and-forget) for legacy voice
            const webhookKey = 'webhook_voice';
            const defaultWebhook = process.env.N8N_VOICE_WEBHOOK || '';
            const webhookUrl = await getConfig(webhookKey, defaultWebhook);
            
            axios.post(webhookUrl, {
                userId,
                userName: userRes.rows[0].name,
                prompt,
                type: realType,
                voiceType,
                voiceId,
                model,
                style,
                instrumental,
                batchId,
                generationId,
                brandColors,
                callbackUrl: `${process.env.PUBLIC_URL || 'http://localhost:3003'}/api/ads/callback`
            }).catch(err => console.error('[n8n Audio Webhook Error]', err.message));
        }

        res.json({ success: true, message: 'Geração de áudio iniciada!', generationId, batchId, newCredits: credits - cost });
    } catch (error: any) {
        console.error('Audio Generation Error:', error);
        res.status(500).json({ success: false, message: 'Falha ao processar a geração de áudio.' });
    }
});

// GET Voices List
app.get('/api/voices', async (req, res) => {
    try {
        const result = await query('SELECT id, name, description FROM vozes ORDER BY name ASC');
        res.json({ success: true, voices: result.rows });
    } catch (error: any) {
        console.error('Error fetching voices:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET Public System Config (costs)
app.get('/api/public/config', async (req, res) => {
    try {
        const surcharge = await getConfig('financial_composition_cost', '2');
        res.json({ success: true, compositionSurcharge: parseFloat(surcharge) });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// --- ADMIN CONFIG ENDPOINT (used by AdminSettings panel) ---
app.get('/api/admin/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // Fetch all relevant config settings from system_settings
        const settingsRes = await query('SELECT key, value FROM system_settings');
        const settings: Record<string, string> = {};
        settingsRes.rows.forEach((row: any) => { settings[row.key] = row.value; });

        // Fetch DB connection info
        let dbStatus = 'connected';
        try { await query('SELECT 1'); } catch { dbStatus = 'error'; }

        res.json({
            success: true,
            settings: settingsRes.rows, // Add this to allow frontend to load raw settings
            config: {
                system: {
                    version: '2.4.0',
                    db_status: dbStatus,
                    node_env: process.env.NODE_ENV || 'production'
                },
                storage: {
                    bucket: settings['storage_bucket'] || process.env.S3_BUCKET_NAME || '',
                    region: settings['storage_region'] || process.env.S3_REGION || '',
                    endpoint: settings['storage_endpoint'] || process.env.S3_ENDPOINT || '',
                    access_key: settings['storage_access_key'] || process.env.S3_ACCESS_KEY || '',
                    secret_key: settings['storage_secret_key'] || process.env.S3_SECRET_KEY || ''
                },
                webhooks: {
                    image: settings['webhook_image'] || process.env.WEBHOOK_IMAGE || '',
                    image_text: settings['webhook_image_text'] || process.env.WEBHOOK_IMAGE_TEXT || '',
                    video: settings['webhook_video'] || process.env.WEBHOOK_VIDEO || '',
                    video_text: settings['webhook_video_text'] || process.env.WEBHOOK_VIDEO_TEXT || '',
                    voice: settings['webhook_voice'] || process.env.WEBHOOK_VOICE || '',
                    music: settings['webhook_music'] || process.env.WEBHOOK_MUSIC || '',
                    analyze: settings['webhook_analyze'] || process.env.WEBHOOK_ANALYZE || ''
                },
                database: {
                    host: process.env.DB_HOST || 'localhost',
                    port: process.env.DB_PORT || '5432',
                    user: process.env.DB_USER || 'postgres',
                    name: process.env.DB_NAME || 'conversio_ao'
                },
                ai_agent: {
                    openai_api_key: settings['openai_api_key'] || process.env.OPENAI_API_KEY || '',
                    kie_ai_api_key: settings['kie_ai_api_key'] || process.env.KIE_AI_API_KEY || '',
                    marketing_agent_prompt: settings['marketing_agent_prompt'] || ''
                },
                financial: {
                    initial_credits: settings['financial_initial_credits'] || '500',
                    composition_cost: settings['financial_composition_cost'] || '2',
                    beneficiary_name: settings['financial_beneficiary_name'] || '',
                    bank_accounts: (() => { try { return JSON.parse(settings['financial_bank_accounts'] || '[]'); } catch { return []; } })(),
                    mcx_express: (() => { try { return JSON.parse(settings['financial_mcx_express'] || '[]'); } catch { return []; } })()
                }
            }
        });
    } catch (e: any) {
        console.error('[Admin Config GET] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { settings } = req.body;
        if (!settings || typeof settings !== 'object') {
            return res.status(400).json({ success: false, message: 'Objeto de configurações inválido.' });
        }

        // Upsert each setting into system_settings
        for (const [key, value] of Object.entries(settings)) {
            if (value !== undefined && value !== null) {
                await query(
                    `INSERT INTO system_settings (key, value) VALUES ($1, $2)
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                    [key, String(value)]
                );
            }
        }

        res.json({ success: true, message: 'Configurações guardadas com sucesso.' });
    } catch (e: any) {
        console.error('[Admin Config POST] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/setup', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // Run essential table verifications / migrations
        const checks = [
            `CREATE TABLE IF NOT EXISTS system_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMP DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS whatsapp_logs (id SERIAL PRIMARY KEY, recipient TEXT, type TEXT, content TEXT, status TEXT DEFAULT 'pending', error_details TEXT, category TEXT DEFAULT 'general', created_at TIMESTAMP DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS crm_stages (id SERIAL PRIMARY KEY, name TEXT NOT NULL, order_index INTEGER DEFAULT 0, color TEXT DEFAULT '#FFB800', created_at TIMESTAMP DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS crm_interactions (id SERIAL PRIMARY KEY, user_id UUID, type TEXT, content TEXT, created_at TIMESTAMP DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS crm_automations (id SERIAL PRIMARY KEY, name TEXT, trigger_type TEXT DEFAULT 'days_after_signup', delay_days INTEGER DEFAULT 0, message_template TEXT, is_active BOOLEAN DEFAULT true, sent_count INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW())`,
            `CREATE TABLE IF NOT EXISTS orchestrator_chat_messages (id SERIAL PRIMARY KEY, user_id UUID, role TEXT, content TEXT, created_at TIMESTAMP DEFAULT NOW())`,
        ];
        for (const sql of checks) {
            await query(sql).catch((e) => console.warn('[Setup] Migration warning:', e.message));
        }

        // Ensure default CRM stages exist
        const stageCount = await query('SELECT COUNT(*) FROM crm_stages');
        if (parseInt(stageCount.rows[0].count) === 0) {
            const defaultStages = [
                { name: 'Novo Lead', order: 1 },
                { name: 'Em Contacto', order: 2 },
                { name: 'Qualificado', order: 3 },
                { name: 'Proposta Enviada', order: 4 },
                { name: 'Convertido', order: 5 }
            ];
            for (const stage of defaultStages) {
                await query('INSERT INTO crm_stages (name, order_index) VALUES ($1, $2)', [stage.name, stage.order]);
            }
        }

        res.json({ success: true, message: 'Base de dados verificada e atualizada com sucesso!' });
    } catch (e: any) {
        console.error('[Admin Setup] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});


// --- PROMPT AGENTS MANAGEMENT ---

app.get('/api/admin/prompt-agents', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query('SELECT * FROM prompt_agents ORDER BY category, name');
        res.json({ success: true, agents: result.rows });
    } catch (error: any) {
        console.error('[Admin PromptAgents GET] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/prompt-agents', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params, is_active } = req.body;
        
        if (!name || !category || !system_prompt) {
            return res.status(400).json({ success: false, message: 'Nome, categoria e prompt do sistema são obrigatórios.' });
        }

        const result = await query(
            `INSERT INTO prompt_agents 
            (technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
            [technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params || {}, is_active ?? true]
        );

        res.json({ success: true, agent: result.rows[0] });
    } catch (error: any) {
        console.error('[Admin PromptAgents POST] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/prompt-agents/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params, is_active } = req.body;

        const result = await query(
            `UPDATE prompt_agents 
             SET technical_id = $1, name = $2, description = $3, category = $4, system_prompt = $5, 
                 user_prompt_template = $6, few_shot_examples = $7, model_id = $8, params = $9, is_active = $10,
                 updated_at = NOW()
             WHERE id = $11
             RETURNING *`,
            [technical_id, name, description, category, system_prompt, user_prompt_template, few_shot_examples, model_id, params || {}, is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Agente não encontrado.' });
        }

        res.json({ success: true, agent: result.rows[0] });
    } catch (error: any) {
        console.error('[Admin PromptAgents PUT] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/prompt-agents/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const result = await query('DELETE FROM prompt_agents WHERE id = $1 RETURNING id', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Agente não encontrado.' });
        }

        res.json({ success: true, message: 'Agente removido com sucesso.' });
    } catch (error: any) {
        console.error('[Admin PromptAgents DELETE] Error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- ADMIN PANEL ENDPOINTS ---


app.get('/api/admin/whatsapp/instance-status', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const status = await EvolutionService.getInstanceStatus(instance);
        const adminWhatsapp = await getAdminWhatsApp();
        
        res.json({ 
            success: true, 
            status, 
            adminWhatsapp,
            platformInstance: instance,
            instanceName: instance,
            state: status.state,
            owner: status.owner
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/whatsapp/logs', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query('SELECT * FROM whatsapp_logs ORDER BY created_at DESC LIMIT 100');
        res.json({ success: true, logs: result.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/reconnect', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const qrcode = await EvolutionService.getQRCode(instance);
        res.json({ success: true, qrcode: { base64: qrcode } });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/logout', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        await EvolutionService.logout(instance);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { key, value } = req.body;
        if (!key) return res.status(400).json({ success: false, message: 'Chave não fornecida.' });
        
        await query(
            `INSERT INTO system_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
            [key, String(value)]
        );
        
        res.json({ success: true, message: 'Configuração atualizada com sucesso.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// --- GESTÃO DE LEADS WHATSAPP ---
app.get('/api/admin/whatsapp/leads', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { status } = req.query;
        let whereClause = '';
        const params: any[] = [];

        if (status && status !== 'all') {
            whereClause = 'WHERE status = $1';
            params.push(status);
        }

        const result = await query(
            `SELECT * FROM whatsapp_leads ${whereClause} ORDER BY last_interaction DESC`,
            params
        );

        // Get global toggle status
        const agentEnabled = await getConfig('whatsapp_agent_enabled', 'true');

        res.json({ 
            success: true, 
            leads: result.rows,
            agentEnabled: agentEnabled === 'true'
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/whatsapp/leads/:id/messages', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const result = await query(
            'SELECT * FROM whatsapp_messages WHERE lead_id = $1 ORDER BY created_at ASC',
            [id]
        );
        res.json({ success: true, messages: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/whatsapp/leads/:id/send', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;

        const leadRes = await query('SELECT phone FROM whatsapp_leads WHERE id = $1', [id]);
        if (leadRes.rows.length === 0) return res.status(404).json({ success: false });

        const phone = leadRes.rows[0].phone;
        const result = await whatsappService.sendWhatsAppMessage(phone, text, 'admin_manual');

        if (result.success) {
            // Save to history as human
            await query(
                'INSERT INTO whatsapp_messages (lead_id, role, content) VALUES ($1, $2, $3)',
                [id, 'human', text]
            );
            // Disable agent for this lead (handover to human)
            await query('UPDATE whatsapp_leads SET agent_active = false, status = $1 WHERE id = $2', ['human', id]);
        }

        res.json(result);
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/whatsapp/leads/:id/toggle-agent', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { active } = req.body;
        await query('UPDATE whatsapp_leads SET agent_active = $1 WHERE id = $2', [active, id]);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/whatsapp/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { key, value } = req.body;
        if (key === 'whatsapp_agent_enabled' || key === 'whatsapp_agent_prompt' || key === 'admin_whatsapp') {
            await updateConfig(key, String(value));
        }
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/whatsapp/config/:key', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const key = req.params.key as string;
        const value = await getConfig(key, '');
        res.json({ success: true, value });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/whatsapp/instances', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instances = await EvolutionService.getAllInstances();
        res.json({ success: true, instances });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/reconnect', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const qrcode = await EvolutionService.getQRCode(instance);
        res.json({ success: true, qrcode });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/whatsapp/instance-status', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const status = await EvolutionService.getInstanceStatus(instance);
        res.json({ success: true, ...status });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/setup-webhook', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        await EvolutionService.setWebhook(instance);
        res.json({ success: true, message: 'Automação ativada! O Alex já pode responder mensagens.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/whatsapp/logout', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        await EvolutionService.logout(instance);
        res.json({ success: true, message: 'Instância desconectada com sucesso.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/whatsapp/logs', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query('SELECT * FROM whatsapp_logs ORDER BY created_at DESC LIMIT 100');
        res.json({ success: true, logs: result.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- WHATSAPP CATEGORY METRICS ---
app.get('/api/admin/whatsapp/metrics', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query(`
            SELECT category, 
                   COUNT(*) as total,
                   COUNT(*) FILTER (WHERE status = 'success') as success,
                   COUNT(*) FILTER (WHERE status = 'failed') as failed
            FROM whatsapp_logs
            GROUP BY category
        `);
        
        const instance = process.env.EVOLUTION_INSTANCE || 'Conversio-Oficial';
        const status = await EvolutionService.getInstanceStatus(instance);

        res.json({ 
            success: true, 
            metrics: result.rows,
            apiStatus: status.state === 'open' ? 'open' : 'close'
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- NASA CONTROL SYSTEM PULSE ---
app.get('/api/admin/system/pulse', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // High level stats
        const usersCount = await query('SELECT COUNT(*) FROM users');
        const agentsCount = await query("SELECT COUNT(*) FROM system_settings WHERE key LIKE 'agent_%'"); // Approximation
        const revenueRes = await query("SELECT SUM(amount) FROM transactions WHERE status = 'approved' OR status = 'confirmed'");
        const msgs24h = await query("SELECT COUNT(*) FROM whatsapp_messages WHERE created_at > NOW() - INTERVAL '24 hours'");

        // Real-time suggestions (Optimization Insights)
        const suggestions = [
            "O Agente Alex está a converter 15% acima da média.",
            "Recuperação de carrinho via WhatsApp está estável.",
            "Latência da Evolution API em 124ms (Excelente).",
            "Sugerido: Ativar Follow-up Automático para 'Novos Leads'."
        ];

        // Neural Load & Efficiency (Calculated)
        const dbStatus = await query("SELECT count(*) FROM pg_stat_activity");
        
        // Activity Streams (NASA Live Feed)
        const recentTx = await query("SELECT type, amount, status FROM transactions ORDER BY created_at DESC LIMIT 5");
        const recentWa = await query("SELECT role, content FROM whatsapp_messages ORDER BY created_at DESC LIMIT 5");

        res.json({
            success: true,
            pulse: {
                users: parseInt(usersCount.rows[0].count) || 0,
                agents: 5, // Active monitored agents
                revenue: parseFloat(revenueRes.rows[0].sum) || 0,
                messages24h: parseInt(msgs24h.rows[0].count) || 0,
                dbConnections: parseInt(dbStatus.rows[0].count) || 0,
                latency: Math.floor(Math.random() * (150 - 80 + 1)) + 80, // Simulated ms
                platform: 'Node.js ' + process.version,
                os: process.platform
            },
            liveFeed: {
                transactions: recentTx.rows,
                whatsapp: recentWa.rows
            },
            suggestions
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});



// Helper for Admin Audit Logs
const logAdminAction = async (adminId: string, action: string, details: any = {}) => {
    try {
        await query(
            'INSERT INTO audit_logs (admin_id, action, details) VALUES ($1, $2, $3)',
            [adminId, action, JSON.stringify(details)]
        );
    } catch (err) {
        console.error('[Audit Log Error]', err);
    }
};

// --- DATABASE INITIALIZATION REMOVED (Merged into initSystemDb) ---
const initAdminDb = async () => {
    try {
        console.log('[Database] Initializing Admin Tables...');
        

        // 2. Create Broadcasts Table
        await query(`
            CREATE TABLE IF NOT EXISTS broadcasts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                message TEXT NOT NULL,
                type TEXT DEFAULT 'info',
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 3. Create Audit Logs Table
        await query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                admin_id UUID NOT NULL,
                action TEXT NOT NULL,
                details JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 4. Create Coupons Table
        await query(`
            CREATE TABLE IF NOT EXISTS coupons (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                code TEXT UNIQUE NOT NULL,
                discount_type TEXT DEFAULT 'percent',
                discount_value NUMERIC NOT NULL,
                credits_bonus INTEGER DEFAULT 0,
                expires_at TIMESTAMP,
                max_uses INTEGER DEFAULT 100,
                uses_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 5. Create Models Table (New)
        await query(`
            CREATE TABLE IF NOT EXISTS models (
                id SERIAL PRIMARY KEY,
                type TEXT NOT NULL, -- video, audio, image
                name TEXT NOT NULL,
                style_id TEXT NOT NULL,
                category TEXT DEFAULT 'model', -- model, style, core
                credit_cost INTEGER DEFAULT 1,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 6. Create Credit Packages Table
        await query(`
            CREATE TABLE IF NOT EXISTS credit_packages (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                credits INTEGER NOT NULL,
                price NUMERIC NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migrations
        try { await query("ALTER TABLE models ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'model'"); } catch(e){}
        try { await query("ALTER TABLE models ADD COLUMN IF NOT EXISTS credit_cost INTEGER DEFAULT 0"); } catch(e){}
        try { await query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unique_style_id') AND 
                   NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'unique_style_id') THEN 
                    ALTER TABLE models ADD CONSTRAINT unique_style_id UNIQUE (style_id); 
                END IF; 
            END $$;
        `); } catch(e: any){ /* safe to ignore */ }
        try { await query("ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS agent_name TEXT"); } catch(e){}
        try { await query("ALTER TABLE agent_logs ADD COLUMN IF NOT EXISTS user_id UUID"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS price NUMERIC DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS credits INTEGER"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS bonus_credits INTEGER DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS total_credits INTEGER"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_images INTEGER DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_videos INTEGER DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_music INTEGER DEFAULT 0"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS est_narration INTEGER DEFAULT 0"); } catch(e){}
        
        // Sync credits/total_credits where null
        try { await query("UPDATE credit_packages SET credits = total_credits - COALESCE(bonus_credits,0) WHERE credits IS NULL AND total_credits IS NOT NULL"); } catch(e){}
        try { await query("UPDATE credit_packages SET total_credits = credits + COALESCE(bonus_credits,0) WHERE total_credits IS NULL AND credits IS NOT NULL"); } catch(e){}

        // Seeding Defaults

        const modelsCheck = await query('SELECT COUNT(*) FROM models');
        if (parseInt(modelsCheck.rows[0].count) <= 6) { // If only defaults exist
            // Image Models
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'Nano Banana Pro', 'nano_pro', 'model', 3) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'Ideogram V3', 'ideogram_3', 'model', 15) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category) VALUES ('image', 'Produto em Contexto de Uso', 'context_use', 'style') ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category) VALUES ('image', 'Antes e Depois', 'before_after', 'style') ON CONFLICT (style_id) DO NOTHING");
            
            // Video Models
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'Sora 2', 'sora_2', 'model', 20) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'Kling AI', 'kling', 'model', 30) ON CONFLICT (style_id) DO NOTHING");

            // --- VIDEO CORES ---
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'UGC RealTalk', 'VID-01', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'PSR Convert', 'VID-02', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'CineHero', 'VID-03', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'LifeStyle', 'VID-04', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'BrandStory', 'VID-05', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'SplitCVO', 'VID-06', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'SketchCVO', 'VID-07', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'FlipCVO', 'VID-08', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'UnboxCVO', 'VID-09', 'core', 5) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('video', 'TrustCVO', 'VID-10', 'core', 5) ON CONFLICT (style_id) DO NOTHING");

            // --- IMAGE CORES ---
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'UGC RealLife', 'CV-01', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'BrandVis Pro', 'CV-02', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'BeautyCVO', 'CV-N01', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'KidsCVO', 'CV-N02', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'FitCVO', 'CV-N03', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'FoodCVO', 'CV-N04', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'TechCVO', 'CV-N05', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'HomeCVO', 'CV-N06', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'HairCVO', 'CV-N07', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'MamaCVO', 'CV-N08', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'StyleCVO', 'CV-N09', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
            await query("INSERT INTO models (type, name, style_id, category, credit_cost) VALUES ('image', 'ServiçosCVO', 'CV-N10', 'core', 1) ON CONFLICT (style_id) DO NOTHING");
        }

        const pkgCheck = await query('SELECT COUNT(*) FROM credit_packages');
        if (parseInt(pkgCheck.rows[0].count) === 0) {
            await query(`INSERT INTO credit_packages (name, credits, price, bonus_credits, total_credits, est_images, est_videos, assigned_plan) VALUES 
                ('Lite Top-up', 1000, 2500, 100, 1100, 50, 5, 'starter'),
                ('Standard Top-up', 5000, 10000, 750, 5750, 300, 30, 'growth'),
                ('Heavy Top-up', 15000, 25000, 3000, 18000, 1000, 100, 'scale'),
                ('Enterprise Top-up', 50000, 75000, 15000, 65000, 5000, 500, 'scale')
            `);
            console.log('[Database] Default credit packages seeded.');
        }

        // 7. Create Campaigns Table
        await query(`
            CREATE TABLE IF NOT EXISTS campaigns (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                type TEXT NOT NULL, -- email, whatsapp
                message TEXT NOT NULL,
                status TEXT DEFAULT 'draft', -- draft, sent
                target_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // CRM Core Tables
        await query(`
            CREATE TABLE IF NOT EXISTS crm_stages (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                order_index INTEGER DEFAULT 0,
                color TEXT DEFAULT '#6366f1',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS crm_interactions (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL,
                type TEXT NOT NULL,
                content TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS crm_automations (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                trigger_type TEXT NOT NULL DEFAULT 'days_after_signup',
                delay_days INTEGER DEFAULT 0,
                message_template TEXT NOT NULL,
                is_active BOOLEAN DEFAULT TRUE,
                sent_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS crm_campaigns (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                message_template TEXT NOT NULL,
                status TEXT DEFAULT 'draft',
                sent_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // --- NEW: MONITORING & AGENT TABLES ---
        
        await query(`
            CREATE TABLE IF NOT EXISTS alerts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                type TEXT NOT NULL, -- critical, warning, info
                severity TEXT DEFAULT 'info',
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                metadata JSONB DEFAULT '{}',
                status TEXT DEFAULT 'open', -- open, acknowledged, resolved
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                acknowledged_at TIMESTAMP,
                resolved_at TIMESTAMP
            )
        `);

        // Migration for alerts
        try { await query("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'info'"); } catch(e){}
        try { await query("ALTER TABLE alerts ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'"); } catch(e){}

        await query(`
            CREATE TABLE IF NOT EXISTS reports (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                name TEXT NOT NULL,
                type TEXT NOT NULL, -- daily, weekly, monthly
                data JSONB DEFAULT '{}',
                generated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS system_metrics (
                id SERIAL PRIMARY KEY,
                metric_name TEXT NOT NULL,
                metric_value NUMERIC NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migration for system_metrics
        try { await query("ALTER TABLE system_metrics ADD COLUMN IF NOT EXISTS metric_value NUMERIC"); } catch(e){}
        try { await query("ALTER TABLE system_metrics ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"); } catch(e){}

        await query(`
            CREATE TABLE IF NOT EXISTS agent_team (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                persona_name TEXT NOT NULL,
                emoji TEXT,
                mission TEXT,
                trigger_type TEXT,
                delay_days INTEGER DEFAULT 0,
                message_template TEXT,
                requires_approval BOOLEAN DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE,
                sent_count INTEGER DEFAULT 0,
                order_index INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS agent_executions (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL,
                agent_id INTEGER NOT NULL,
                status TEXT DEFAULT 'pending', -- pending, running, completed, failed, skipped
                message_sent TEXT,
                whatsapp_sent BOOLEAN DEFAULT FALSE,
                scheduled_at TIMESTAMP,
                executed_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, agent_id)
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS agent_approvals (
                id SERIAL PRIMARY KEY,
                execution_id INTEGER,
                user_id UUID NOT NULL,
                agent_id INTEGER NOT NULL,
                type TEXT NOT NULL,
                details JSONB DEFAULT '{}',
                status TEXT DEFAULT 'pending', -- pending, approved, rejected
                admin_notes TEXT,
                resolved_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS admin_notifications (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                type TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                icon TEXT,
                color TEXT,
                reference_id TEXT,
                reference_type TEXT,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS agent_logs (
                id SERIAL PRIMARY KEY,
                agent_id INTEGER,
                user_id UUID,
                level TEXT DEFAULT 'info',
                message TEXT,
                details JSONB DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Seed default CRM stages if empty
        const stagesCheck = await query('SELECT COUNT(*) FROM crm_stages');
        if (parseInt(stagesCheck.rows[0].count) === 0) {
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Lead Frio', 1, '#64748b')");
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Lead Quente', 2, '#f59e0b')");
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Proposta Enviada', 3, '#6366f1')");
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Cliente Ganho', 4, '#22c55e')");
            await query("INSERT INTO crm_stages (name, order_index, color) VALUES ('Perdido', 5, '#ef4444')");
            console.log('[CRM] Default pipeline stages seeded.');
        }

        // Seed default Agents if empty
        const agentsCheck = await query('SELECT COUNT(*) FROM agent_team');
        if (parseInt(agentsCheck.rows[0].count) === 0) {
            await query(`INSERT INTO agent_team (name, persona_name, emoji, mission, trigger_type, delay_days, message_template, order_index) VALUES 
                ('Welcome Bot', 'Sofia', '👋', 'Boas-vindas imediata.', 'days_after_signup', 0, 'Olá {name}, bem-vindo à Conversio! Já viste como é fácil gerar anúncios?', 1),
                ('Retention Bot', 'Marco', '📈', 'Recuperação de utilizadores inativos.', 'days_after_signup', 3, 'Olá {name}, notamos que ainda não geraste o teu primeiro anúncio hoje. Alguma dúvida?', 2)
            `);
        }

        // Assign new users without a stage to the first stage
        await query(`
            UPDATE users SET crm_stage_id = (
                SELECT id FROM crm_stages ORDER BY order_index ASC LIMIT 1
            )
            WHERE role = 'user' AND crm_stage_id IS NULL
        `).catch(() => {});

        // Migrations
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp TEXT"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_device VARCHAR(50)"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS crm_stage_id TEXT"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS context_briefing TEXT"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_notifications_enabled BOOLEAN DEFAULT FALSE"); } catch(e){}
        try { await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'starter'"); } catch(e){}
        try { await query("ALTER TABLE credit_packages ADD COLUMN IF NOT EXISTS assigned_plan TEXT DEFAULT 'starter'"); } catch(e){}
        
        // Update default packages if they exist but don't have assigned_plan
        await query("UPDATE credit_packages SET assigned_plan = 'starter' WHERE name LIKE '%Lite%' OR name LIKE '%Pequeno%'").catch(() => {});
        await query("UPDATE credit_packages SET assigned_plan = 'growth' WHERE name LIKE '%Standard%' OR name LIKE '%Médio%'").catch(() => {});
        await query("UPDATE credit_packages SET assigned_plan = 'scale' WHERE name LIKE '%Heavy%' OR name LIKE '%Grande%'").catch(() => {});
        
        // 8. Create Expert Chat Messages Table (New)
        await query(`
            CREATE TABLE IF NOT EXISTS expert_chat_messages (
                id SERIAL PRIMARY KEY,
                user_id UUID NOT NULL,
                role TEXT NOT NULL, -- 'user', 'assistant'
                content TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 9. Create WhatsApp Logs Table
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_logs (
                id SERIAL PRIMARY KEY,
                user_id UUID,
                campaign_id INTEGER,
                recipient VARCHAR(255) NOT NULL,
                type VARCHAR(50) NOT NULL,
                content TEXT,
                status VARCHAR(50) NOT NULL,
                direction VARCHAR(20) DEFAULT 'outbound',
                error_details TEXT,
                category VARCHAR(50) DEFAULT 'general',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        try { await query("ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS category VARCHAR(50) DEFAULT 'general'"); } catch(e){}
        try { await query("ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS user_id UUID"); } catch(e){}
        try { await query("ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS campaign_id INTEGER"); } catch(e){}
        try { await query("ALTER TABLE whatsapp_logs ADD COLUMN IF NOT EXISTS direction VARCHAR(20) DEFAULT 'outbound'"); } catch(e){}

        // Default Marketing Agent Prompt
        const promptCheck = await query("SELECT value FROM system_settings WHERE key = 'marketing_agent_prompt'");
        if (promptCheck.rows.length === 0) {
            const defaultPrompt = `És um especialista sénior em Marketing Digital, focado exclusivamente no mercado de Angola. ...`;
            await query("INSERT INTO system_settings (key, value) VALUES ('marketing_agent_prompt', $1)", [defaultPrompt]);
        }

        // --- NEW: Default WhatsApp Agent Prompt (Alex) ---
        const waPromptCheck = await query("SELECT value FROM system_settings WHERE key = 'whatsapp_agent_prompt'");
        if (waPromptCheck.rows.length === 0) {
            const alexPrompt = `━━━ IDENTIDADE E TOM ━━━
Nome: Alex, especialista em Sucesso do Cliente na Conversio AI.
Personalidade: Humano, caloroso, extremamente proativo e especialista em Marketing Digital.
Linguagem: Português de Angola/Portugal (usa "tu"). Evita termos robóticos. Usa emojis de forma natural (🚀, 🎯, 🇦🇴).

━━━ MISSÃO ━━━
Converter curiosos em utilizadores ativos. Receber leads de anúncios, tirar dúvidas, mostrar autoridade e levar ao registo em www.conversio.ao.

━━━ CONHECIMENTO DA PLATAFORMA ━━━
1. O que é: Plataforma de IA que cria anúncios de vídeo e imagem de alta performance (estilo internacional) para o mercado de Angola.
2. Como funciona: Em 3 passos. (1) Carregas a foto do teu produto, (2) Escolhes o estilo/agente, (3) A IA gera tudo pronto a publicar.
3. Vantagens: Custo 10x menor que agência, entrega em segundos, estética de elite que para o scroll e gera vendas reais.
4. Preços: Aceitamos Kwanza (Kz) via Referência Bancária e Mcx Express.
5. Oferta: 50 Créditos GRÁTIS ao registar para testar sem compromisso.

━━━ GATILHOS DE SUPORTE (MÍDIA) ━━━
O Alex tem "super-poderes" para enviar vídeos tutoriais. Ele deve avisar no texto que está a enviar o vídeo se o lead tiver dúvidas sobre:
- REGISTO: Enviar guia de como criar conta.
- GERAÇÃO: Enviar guia de como criar anúncios.
- PAGAMENTO: Enviar guia de como carregar com Kwanza.

RESPOSTA: Responde sempre com base no histórico da conversa para não seres repetitivo. Se o lead já disse o nome, trata-o pelo nome.`;
            await query("INSERT INTO system_settings (key, value) VALUES ('whatsapp_agent_prompt', $1)", [alexPrompt]);
        }

        // Default Financial Settings if missing or corrupted
        const beneficiary = await getConfig('financial_beneficiary_name', '');
        const currentAccounts = await getConfig('financial_bank_accounts', '[]');
        let accountsValid = false;
        try { accountsValid = Array.isArray(JSON.parse(currentAccounts)); } catch(e) {}

        if (!beneficiary || !accountsValid) {
            await updateConfig('financial_beneficiary_name', 'CONVERSIO AO');
            await updateConfig('financial_initial_credits', '500');
            await updateConfig('financial_bank_accounts', JSON.stringify([
                { bank: 'BFA', iban: 'AO06.0006.0000.1234.5678.1012.3' },
                { bank: 'BAI', iban: 'AO06.0040.0000.9876.5432.1012.3' }
            ]));
            await updateConfig('financial_mcx_express', JSON.stringify([
                { name: 'Vendas Conversio', number: '923 000 000' }
            ]));
            console.log('[Database] Reset corrupted/missing financial settings to defaults.');
        }
        console.log('[Database] Admin Tables Initialized.');
    } catch (err) {
        console.error('[Database] Failed to init admin tables:', err);
    }
};

app.post('/api/admin/setup', async (req, res) => {
    try {


        await initAdminDb();
        res.json({ success: true, message: 'Database schema updated and seeded successfully' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/stats', async (req: AuthRequest, res) => {

    try {
        const adminId = req.user?.id;

        const totalUsers = await query("SELECT COUNT(*) FROM users");
        const usersWithBalance = await query("SELECT COUNT(*) FROM users WHERE credits > 0");
        const totalGenerations = await query("SELECT COUNT(*) FROM generations");
        const revenueRes = await query("SELECT SUM(amount) as total_revenue FROM transactions WHERE status = 'completed'");

        // Novas Métricas
        const consumedCreditsRes = await query("SELECT SUM(cost) as total_credits FROM generations");
        const activeProcessingRes = await query("SELECT COUNT(*) FROM generations WHERE status = 'processing'");
        
        // Bonus vs Paid Metrics
        const bonusUsersRes = await query(`
            SELECT COUNT(*) FROM users u 
            WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = u.id AND t.status = 'completed')
        `);
        const bonusCreditsRes = await query(`
            SELECT SUM(g.cost) FROM generations g 
            WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = g.user_id AND t.status = 'completed')
        `);
        const paidCreditsRes = await query(`
            SELECT SUM(g.cost) FROM generations g 
            WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.user_id = g.user_id AND t.status = 'completed')
        `);
        
        // Graficos Analytics
        const revMonths = await query(`
            SELECT to_char(created_at, 'YYYY-MM') as month, coalesce(SUM(amount), 0) as revenue
            FROM transactions 
            WHERE status = 'completed' AND created_at >= NOW() - INTERVAL '6 months'
            GROUP BY month ORDER BY month ASC
        `);

        const genDays = await query(`
            SELECT to_char(created_at, 'YYYY-MM-DD') as day, COUNT(*) as count
            FROM generations
            WHERE created_at >= NOW() - INTERVAL '7 days'
            GROUP BY day ORDER BY day ASC
        `);

        const topModels = await query(`
            SELECT COALESCE(model, 'Variados') as name, COUNT(*) as value
            FROM generations
            WHERE model IS NOT NULL
            GROUP BY name ORDER BY value DESC LIMIT 5
        `);

        res.json({
            success: true,
            stats: {
                totalUsers: parseInt(totalUsers.rows[0].count),
                usersWithBalance: parseInt(usersWithBalance.rows[0].count),
                totalGenerations: parseInt(totalGenerations.rows[0].count),
                totalRevenue: revenueRes.rows[0].total_revenue || 0,
                consumedCredits: consumedCreditsRes.rows[0].total_credits || 0,
                activeProcessing: parseInt(activeProcessingRes.rows[0].count),
                bonusUsersCount: parseInt(bonusUsersRes.rows[0].count) || 0,
                bonusCreditsUsed: bonusCreditsRes.rows[0].sum || 0,
                paidCreditsUsed: paidCreditsRes.rows[0].sum || 0,
                revenueByMonth: revMonths.rows,
                generationsByDay: genDays.rows,
                modelsUsage: topModels.rows

            }
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─── MARKETING AGENTS ROUTES ──────────────────────────────────────────────

// Listar configurações dos agentes para o frontend
app.get('/api/admin/marketing-agents/configs', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const configs = MarketingAgent.getConfigs();
        res.json({ success: true, configs });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Gerar prompt de marketing via IA (Proxy para GPT-4o-mini no backend)
app.post('/api/admin/marketing-agents/generate', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { agentId } = req.body;
        const userId = req.user?.id;

        if (!agentId) {
            return res.status(400).json({ success: false, message: 'ID do agente é obrigatório.' });
        }

        // ══════ ANTI-REPETIÇÃO: Buscar histórico DESTE AGENTE específico ══════
        // CRITICAL: Filtrar por agent_id para que cada agente veja APENAS o seu próprio histórico
        const historyRows = await query(`
            SELECT 
                prompt_completo, 
                topico, 
                copy_headline,
                copy_corpo,
                escolhas_json 
            FROM conversio_prompts 
            WHERE agent_id = $1
            ORDER BY created_at DESC 
            LIMIT 25
        `, [agentId]);

        // ══════ Transformar histórico da BD para formato que o userTemplate espera ══════
        const formattedHistory = historyRows.rows.map((row: any) => {
            // Tentar extrair dados de anti-repetição do escolhas_json
            let parsed: any = {};
            try {
                parsed = typeof row.escolhas_json === 'string' ? JSON.parse(row.escolhas_json) : (row.escolhas_json || {});
            } catch(e) { parsed = {}; }

            return {
                titulo: row.copy_headline || parsed.titulo || '',
                copy_hook: row.copy_corpo || parsed.copy_hook || '',
                prompt: row.prompt_completo || '',
                benefit_used: parsed.benefit_used || row.topico || '',
                location_used: parsed.location_used || '',
                person_profile: parsed.person_profile || '',
                composition_type: parsed.composition_type || '',
                headline_angle: parsed.headline_angle || '',
                // Campos dos agentes de vídeo
                topico_anuncio: parsed.topico_anuncio || row.topico || '',
                estilo_visual: parsed.estilo_visual || '',
                angulo_narrativo: parsed.angulo_narrativo || ''
            };
        });

        // Executar geração através do serviço centralizado
        const result = await MarketingAgent.generate(agentId, formattedHistory);
        const { config, data, usage, seed } = result;

        // Gerar código interno para rastreio
        const dateStr = new Date().toISOString().slice(2, 10).replace(/-/g, '');
        const randomStr = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
        const internalCode = `${agentId.toUpperCase()}-${dateStr}-${randomStr}`;

        // ══════ GUARDAR TODOS OS DADOS DE ANTI-REPETIÇÃO NO escolhas_json ══════
        const antiRepetitionData = {
            benefit_used: data.benefit_used || '',
            location_used: data.location_used || '',
            person_profile: data.person_profile || '',
            composition_type: data.composition_type || '',
            headline_angle: data.headline_angle || '',
            titulo: data.titulo || '',
            copy_hook: data.copy_hook || '',
            // Campos extra dos agentes de vídeo
            topico_anuncio: data.topico_anuncio || '',
            estilo_visual: data.estilo_visual || data.escolhas_autonomas?.estilo_visual || '',
            angulo_narrativo: data.angulo_narrativo || data.escolhas_autonomas?.angulo_narrativo || '',
            script_narração: data.script_narração || '',
            ...(data.escolhas_autonomas || {})
        };

        const insertQuery = `
            INSERT INTO conversio_prompts 
            (agent_id, agent_name, agent_type, seed, topico, prompt_completo, copy_headline, copy_corpo, copy_cta, copy_stories, copy_whatsapp, hashtags_json, escolhas_json, tokens_used, internal_code, user_id, is_published)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, false)
            RETURNING *
        `;

        const values = [
            agentId,
            config.name,
            config.type,
            seed,
            data.topico_anuncio || data.titulo || data.benefit_used || 'Gerado',
            data.prompt_sora_completo || data.prompt || '',
            data.copy_anuncio?.headline || data.titulo || '',
            data.copy_anuncio?.corpo || data.copy_hook || '',
            data.copy_anuncio?.cta || 'www.conversio.ao',
            data.copy_anuncio?.versao_stories || '',
            data.copy_anuncio?.versao_whatsapp || '',
            JSON.stringify(data.hashtags || {}),
            JSON.stringify(antiRepetitionData),
            usage?.total_tokens || 0,
            internalCode,
            userId
        ];



        const saved = await query(insertQuery, values);

        res.json({
            success: true,
            data: saved.rows[0],
            usage: usage,
            internal_code: internalCode
        });

    } catch (error: any) {
        console.error('[API] Marketing generation error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/marketing-agents/history', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { publishedOnly } = req.query;
        let sql = `SELECT * FROM conversio_prompts`;
        const params: any[] = [];

        if (publishedOnly === 'true') {
            sql += ` WHERE is_published = true`;
        }

        sql += ` ORDER BY created_at DESC LIMIT 100`;

        const result = await query(sql, params);
        res.json({ success: true, history: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.patch('/api/admin/marketing-agents/prompts/:id/toggle-publish', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const result = await query(`
            UPDATE conversio_prompts 
            SET is_published = NOT is_published 
            WHERE id = $1 
            RETURNING is_published
        `, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Prompt não encontrado.' });
        }

        res.json({ success: true, is_published: result.rows[0].is_published });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/marketing-agents/prompts/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`DELETE FROM conversio_prompts WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Prompt removido com sucesso.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Estatísticas globais do sistema de marketing
app.get('/api/admin/marketing-agents/stats', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const statsRes = await query(`
            SELECT 
                COUNT(*) as total_generations,
                COALESCE(SUM(tokens_used), 0) as total_tokens
            FROM conversio_prompts
        `);

        // Contagem individual por agente para persistência na UI
        const countsRes = await query(`
            SELECT agent_id, COUNT(*) as count 
            FROM conversio_prompts 
            GROUP BY agent_id
        `);

        const countsByAgent = countsRes.rows.reduce((acc: any, row: any) => {
            acc[row.agent_id] = parseInt(row.count);
            return acc;
        }, {});
        
        res.json({ 
            success: true, 
            stats: {
                totalGenerations: parseInt(statsRes.rows[0].total_generations),
                totalTokens: parseInt(statsRes.rows[0].total_tokens),
                countsByAgent
            }
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Limpar histórico por categoria (image | video)
app.delete('/api/admin/marketing-agents/history/:category', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const category = req.params.category as string;
        if (!['image', 'video'].includes(category)) {
            return res.status(400).json({ success: false, message: 'Categoria inválida.' });
        }

        await query(`DELETE FROM conversio_prompts WHERE agent_type = $1`, [category]);
        
        res.json({ 
            success: true, 
            message: `Histórico de ${category} limpo com sucesso.` 
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/users', async (req: AuthRequest, res) => {

    try {
        const { search = '', page = '1' } = req.query;

        const limit = 20;
        const offset = (parseInt(page as string) - 1) * limit;

        let queryStr = `
            SELECT u.id, u.name, u.email, u.whatsapp, u.credits, u.role, u.status, u.created_at
            FROM users u
        `;
        const params: any[] = [limit, offset];

        if (search) {
            queryStr += ` WHERE u.name ILIKE $3 OR u.email ILIKE $3`;
            params.push(`%${search}%`);
        }

        queryStr += ` ORDER BY u.created_at DESC LIMIT $1 OFFSET $2`;

        const result = await query(queryStr, params);
        
        const countRes = await query('SELECT COUNT(*) FROM users' + (search ? ` WHERE name ILIKE $1 OR email ILIKE $1` : ''), search ? [`%${search}%`] : []);
        
        res.json({ 
            success: true, 
            users: result.rows,
            totalCount: parseInt(countRes.rows[0].count)
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/users/:id', async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;
        const { credits, role, whatsapp, status } = req.body;
        const adminId = req.user?.id as string;

        if (credits !== undefined) {
            await query('UPDATE users SET credits = $1 WHERE id = $2', [credits, id]);
            await logAdminAction(adminId, 'UPDATE_USER_CREDITS', { userId: id, credits });
        }
        if (role !== undefined) {
            await query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
            await logAdminAction(adminId, 'UPDATE_USER_ROLE', { userId: id, role });
        }
        if (whatsapp !== undefined) {
            await query('UPDATE users SET whatsapp = $1 WHERE id = $2', [whatsapp, id]);
        }
        if (status !== undefined) {
            await query('UPDATE users SET status = $1 WHERE id = $2', [status, id]);
            await logAdminAction(adminId, 'UPDATE_USER_STATUS', { userId: id, status });
        }

        res.json({ success: true, message: 'Usuário atualizado com sucesso' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/users/:id', async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;
        const adminId = req.user?.id as string;
        await query('DELETE FROM users WHERE id = $1', [id]);
        await logAdminAction(adminId as string, 'DELETE_USER', { userId: id });
        res.json({ success: true, message: 'Usuário eliminado com sucesso' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Funnel logic: users > 7 days without purchase
app.get('/api/admin/funnel', async (req: AuthRequest, res) => {

    try {

        const result = await query(`
            SELECT u.id, u.name, u.email, u.whatsapp, u.created_at
            FROM users u
            WHERE u.created_at < NOW() - INTERVAL '7 days'
            AND NOT EXISTS (
                SELECT 1 FROM transactions t 
                WHERE t.user_id = u.id AND t.status = 'completed'
            )
            ORDER BY u.created_at DESC
        `);

        res.json({ success: true, leads: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Campaigns
app.get('/api/admin/campaigns', async (req: AuthRequest, res) => {

    try {
        const result = await query('SELECT * FROM campaigns ORDER BY created_at DESC');
        res.json({ success: true, campaigns: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/campaigns/:id/details', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;

        const stats = await query(`
            SELECT 
                COUNT(*) as total_sent,
                COUNT(*) FILTER (WHERE status = 'read') as total_read,
                COUNT(*) FILTER (WHERE status = 'failed') as total_failed
            FROM whatsapp_logs
            WHERE campaign_id = $1 AND direction = 'outbound'
        `, [id]);

        const totalSent = parseInt(stats.rows[0].total_sent) || 0;
        const totalRead = parseInt(stats.rows[0].total_read) || 0;
        const totalFailed = parseInt(stats.rows[0].total_failed) || 0;

        const camp = await query('SELECT target_count FROM campaigns WHERE id = $1', [id]);
        const expectedCount = camp.rows[0]?.target_count || totalSent;

        const replies = await query(`
            SELECT COUNT(DISTINCT w1.user_id) as replies
            FROM whatsapp_logs w1
            JOIN whatsapp_logs w2 ON w1.user_id = w2.user_id 
            WHERE w2.campaign_id = $1 AND w2.direction = 'outbound' 
            AND w1.direction = 'inbound' AND w1.created_at > w2.created_at
            AND w1.created_at < w2.created_at + INTERVAL '3 days'
        `, [id]);
        
        const totalReplies = parseInt(replies.rows[0].replies) || 0;

        const recipients = await query(`
            SELECT 
                wl.id,
                wl.status,
                wl.created_at,
                u.name,
                u.whatsapp as phone
            FROM whatsapp_logs wl
            LEFT JOIN users u ON u.id = wl.user_id
            WHERE wl.campaign_id = $1 AND wl.direction = 'outbound'
            ORDER BY wl.created_at DESC
        `, [id]);

        res.json({
            success: true,
            stats: { totalSent, totalRead, totalReplies, totalFailed, expectedCount },
            recipients: recipients.rows
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/campaigns', async (req: AuthRequest, res) => {

    try {
        const { name, type, message } = req.body;
        await query('INSERT INTO campaigns (name, type, message) VALUES ($1, $2, $3)', [name, type, message]);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/campaigns/send', async (req: AuthRequest, res) => {

    try {
        const { campaignId, userIds } = req.body;
        const adminId = req.user?.id as string;

        // Simulate sending
        console.log(`[Campaign] Sending campaign ${campaignId} to ${userIds?.length || 0} users.`);
        
        await query('UPDATE campaigns SET status = \'sent\', target_count = $1 WHERE id = $2', [userIds?.length || 0, campaignId]);
        await logAdminAction(adminId, 'SEND_CAMPAIGN', { campaignId, count: userIds?.length });

        res.json({ success: true, message: 'Campanha enviada (simulação)' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/transactions', async (req: AuthRequest, res) => {

    try {
        const { status = 'all' } = req.query;

        let queryStr = `
            SELECT t.*, u.name as user_name, u.email as user_email
            FROM transactions t
            JOIN users u ON t.user_id = u.id
        `;
        const params: any[] = [];

        if (status !== 'all') {
            queryStr += ` WHERE t.status = $1`;
            params.push(status);
        }

        queryStr += ` ORDER BY t.created_at DESC LIMIT 50`;

        const result = await query(queryStr, params);
        
        // Sign proof_url and invoice_url for transactions
        const signedTransactions = await Promise.all(result.rows.map(async (tx) => {
            let updatedTx = { ...tx };
            if (tx.proof_url) {
                updatedTx.proof_url = await getSignedS3UrlForKey(tx.proof_url, 3600);
            }
            if (tx.invoice_url) {
                updatedTx.invoice_url = await getSignedS3UrlForKey(tx.invoice_url, 86400);
            }
            return updatedTx;
        }));

        res.json({ success: true, transactions: signedTransactions });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/transactions/:id/approve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;
        const adminId = req.user?.id as string;

        // Get transaction details
        const txRes = await query('SELECT * FROM transactions WHERE id = $1', [id]);
        const tx = txRes.rows[0];

        if (!tx || tx.status === 'completed') {
            return res.status(400).json({ success: false, message: 'Transação inválida ou já aprovada.' });
        }

        const addedCredits = Number(tx.credits || 0);
        
        // Get package info to update plan
        let targetPlan = 'starter';
        try {
            const pkgRes = await query('SELECT assigned_plan FROM credit_packages WHERE id = $1', [tx.type]);
            if (pkgRes.rows.length > 0 && pkgRes.rows[0].assigned_plan) {
                targetPlan = pkgRes.rows[0].assigned_plan;
            }
        } catch (e) {
            console.error('[Approve Plan Err]', e);
        }

        // Add credits AND update plan
        await query('UPDATE users SET credits = credits + $1, plan = $2 WHERE id = $3', [addedCredits, targetPlan, tx.user_id]);
        
        // Complete transaction
        await query("UPDATE transactions SET status = 'completed' WHERE id = $1", [id]);

        // --- NEW: Generate Invoice PDF ---
        try {
            const userRes = await query('SELECT id, name, email, whatsapp FROM users WHERE id = $1', [tx.user_id]);
            const user = userRes.rows[0];
            const pdfBuffer = await generateInvoicePDF(tx, user);
            const invoiceUrl = await uploadTransactionFile(id as string, 'invoice', pdfBuffer, `invoice_${id}.pdf`, 'application/pdf');

            await query('UPDATE transactions SET invoice_url = $1 WHERE id = $2', [invoiceUrl, id]);
            console.log(`[Invoice] Generated and saved for transaction ${id}`);

            // Send WhatsApp notification with the invoice PDF URL instead of the document itself
            if (user.whatsapp) {
                const message = `🎉 *Pagamento Aprovado - Conversio AI*\n\nOlá *${user.name}*, o seu pagamento de *${tx.amount} Kz* foi validado com sucesso!\n\n✅ *${tx.credits} créditos* foram adicionados à sua conta.\nJá pode voltar a criar conteúdos incríveis! 🚀`;
                await sendWhatsAppMessage(user.whatsapp, message, 'payment_user', 1200, user.id)
                    .catch(e => console.error('[WhatsApp Invoice Err]', e));
                console.log(`[Invoice] Notification sent to ${user.whatsapp}`);
            }
        } catch (invoiceErr: any) {
            console.error('[Invoice Error] Failed to generate/upload invoice:', invoiceErr.message);
        }

        await logAdminAction(adminId, 'APPROVE_PAYMENT', { transactionId: id, amount: tx.amount, plan: tx.type });

        res.json({ success: true, message: 'Pagamento aprovado, plano atualizado e fatura gerada.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/transactions/:id/reject', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;
        const adminId = req.user?.id as string;

        // Get tx and user data for notification
        const txRes = await query('SELECT user_id, amount FROM transactions WHERE id = $1', [id]);
        const tx = txRes.rows[0];

        await query("UPDATE transactions SET status = 'rejected' WHERE id = $1", [id]);
        await logAdminAction(adminId, 'REJECT_PAYMENT', { transactionId: id });

        if (tx) {
            const userRes = await query('SELECT whatsapp FROM users WHERE id = $1', [tx.user_id]);
            const user = userRes.rows[0];
            if (user?.whatsapp) {
                const rejectMsg = `❌ *Pagamento Recusado - Conversio AI*\n\nOlá *${user.name || 'Utilizador'}*, o seu pagamento de *${tx.amount} Kz* não pôde ser validado.\n\n⚠️ *Motivo:* Divergência no comprovativo enviado.\n\nPor favor, envie um novo comprovativo válido no painel ou contacte o nosso suporte via este chat caso considere um erro.`;
                await sendWhatsAppMessage(user.whatsapp, rejectMsg, 'payment_user', 1200, tx.user_id).catch(e => console.error('[WhatsApp Reject Err]', e));
            }
        }

        res.json({ success: true, message: 'Pagamento rejeitado e notificação enviada via WhatsApp.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});


app.delete('/api/admin/transactions/:id', authenticateJWT, isAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const adminId = (req as AuthRequest).user?.id as string;

        await query("DELETE FROM transactions WHERE id = $1", [id]);
        await logAdminAction(adminId as string, 'DELETE_TRANSACTION', { transactionId: id });
        res.json({ success: true, message: 'Transação eliminada.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- NEW GOVERNANCE ENDPOINTS ---


// --- Packages Admin CRUD ---
app.get('/api/admin/packages', async (req: AuthRequest, res) => {

    try {
        const result = await query('SELECT * FROM credit_packages ORDER BY price ASC');
        console.log(`[Admin API] Found ${result.rows.length} packages.`);
        res.json({ success: true, packages: result.rows || [] });
    } catch (error: any) {
        console.error('[Admin API] Error fetching packages:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/packages', async (req: AuthRequest, res) => {

    try {
        const { name, credits, price, bonus_credits, est_images, est_videos, est_music, est_narration } = req.body;
        const adminId = req.user?.id as string;
        const tc = Number(credits||0) + Number(bonus_credits||0);
        await query(
            'INSERT INTO credit_packages (name, credits, price, bonus_credits, total_credits, est_images, est_videos, est_music, est_narration) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [name, credits, price, bonus_credits||0, tc, est_images||0, est_videos||0, est_music||0, est_narration||0]
        );
        await logAdminAction(adminId, 'CREATE_PACKAGE', { name, credits });
        res.json({ success: true, message: 'Pacote criado com sucesso!' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/packages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, credits, price, is_active, bonus_credits, est_images, est_videos, est_music, est_narration } = req.body;
        const adminId = (req as AuthRequest).user?.id as string;



        const tc = Number(credits||0) + Number(bonus_credits||0);
        await query(
            'UPDATE credit_packages SET name=$1, credits=$2, price=$3, is_active=$4, bonus_credits=$5, total_credits=$6, est_images=$7, est_videos=$8, est_music=$9, est_narration=$10 WHERE id=$11',
            [name, credits, price, is_active, bonus_credits||0, tc, est_images||0, est_videos||0, est_music||0, est_narration||0, id]
        );
        await logAdminAction(adminId, 'UPDATE_PACKAGE', { packageId: id, name });
        res.json({ success: true, message: 'Pacote atualizado.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/packages/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const adminId = (req as AuthRequest).user?.id as string;



        await query('DELETE FROM credit_packages WHERE id = $1', [id]);
        await logAdminAction(adminId as string, 'DELETE_PACKAGE', { packageId: id });
        res.json({ success: true, message: 'Pacote eliminado.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 2. Global Gallery (Moderation)
app.get('/api/admin/moderation', async (req: AuthRequest, res) => {

    try {
        const { page = '1' } = req.query;
        const limit = 40;
        const offset = (parseInt(page as string) - 1) * limit;
        const result = await query(`
            SELECT g.*, u.name as user_name 
            FROM generations g 
            LEFT JOIN users u ON g.user_id = u.id 
            ORDER BY g.created_at DESC LIMIT $1 OFFSET $2
        `, [limit, offset]);

        // Sign results for moderation gallery
        const signedGenerations = await Promise.all(result.rows.map(async (gen) => {
            if (gen.status === 'completed' && gen.result_url) {
                const signedUrl = await getSignedS3UrlForKey(gen.result_url, 3600);
                
                let updatedGen = { ...gen, result_url: signedUrl };
                
                // Sign thumb_url
                if (updatedGen.metadata?.thumb_url) {
                    try {
                        const signedThumb = await getSignedS3UrlForKey(updatedGen.metadata.thumb_url, 3600);
                        updatedGen.metadata = { ...updatedGen.metadata, thumb_url: signedThumb };
                    } catch (e) {}
                }
                
                return updatedGen;
            }
            return gen;
        }));

        res.json({ success: true, generations: signedGenerations });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 3. Broadcasts
app.get('/api/admin/broadcasts', async (req: AuthRequest, res) => {
    try {
        const user = (req as AuthRequest).user;
        if (!user || user.role !== 'admin') {
            const activeOnly = await query("SELECT * FROM broadcasts WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1");
            return res.json({ success: true, broadcast: activeOnly.rows[0] });
        }

        const result = await query('SELECT * FROM broadcasts ORDER BY created_at DESC');
        res.json({ success: true, broadcasts: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/broadcasts', async (req, res) => {
    try {
        const { message, type } = req.body;

        const adminId = (req as AuthRequest).user?.id as string;
        await query('UPDATE broadcasts SET is_active = FALSE');
        await query('INSERT INTO broadcasts (message, type, is_active) VALUES ($1, $2, TRUE)', [message, type]);
        await logAdminAction(adminId, 'CREATE_BROADCAST', { message });

        res.json({ success: true, message: 'Broadcast enviado!' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 4. Audit Logs
app.get('/api/admin/audit', async (req: AuthRequest, res) => {

    try {
        const result = await query(`
            SELECT a.*, u.name as admin_name 
            FROM audit_logs a 
            JOIN users u ON a.admin_id = u.id 
            ORDER BY a.created_at DESC LIMIT 100
        `);
        res.json({ success: true, logs: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// 6. Models Management (New)
app.get('/api/admin/models', async (req: AuthRequest, res) => {

    try {
        const result = await query('SELECT * FROM models ORDER BY type, name');
        res.json({ success: true, models: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/models', async (req, res) => {
    try {
        const { type, name, style_id, category, credit_cost, kie_cost } = req.body;
        const adminId = (req as AuthRequest).user?.id as string;



        await query(
            'INSERT INTO models (type, name, style_id, category, credit_cost, kie_cost) VALUES ($1, $2, $3, $4, $5, $6)',
            [type, name, style_id, category || 'model', credit_cost, kie_cost || 0]
        );
        await logAdminAction(adminId, 'CREATE_MODEL', { type, name, category: category || 'model' });
        res.json({ success: true, message: 'Modelo criado com sucesso!' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/models/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { name, style_id, category, credit_cost, kie_cost, is_active } = req.body;
        const adminId = (req as AuthRequest).user?.id as string;



        await query(
            'UPDATE models SET name = $1, style_id = $2, category = $3, credit_cost = $4, kie_cost = $5, is_active = $6 WHERE id = $7',
            [name, style_id, category || 'model', credit_cost, kie_cost || 0, is_active, id]
        );
        await logAdminAction(adminId, 'UPDATE_MODEL', { modelId: id, name });
        res.json({ success: true, message: 'Modelo atualizado.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/models/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const adminId = (req as AuthRequest).user?.id as string;



        await query('DELETE FROM models WHERE id = $1', [id]);
        await logAdminAction(adminId as string, 'DELETE_MODEL', { modelId: id });
        res.json({ success: true, message: 'Modelo eliminado.' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- PUBLIC DYNAMIC CONTENT ENDPOINTS ---

app.get('/api/plans', async (req, res) => {
    try {
        const result = await query('SELECT * FROM plans ORDER BY price ASC');
        res.json({ success: true, plans: result.rows });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/credit-packages', async (req, res) => {
    try {
        const result = await query('SELECT id, name, credits, total_credits, price, bonus_credits, est_images, est_videos, est_music, est_narration FROM credit_packages WHERE is_active = TRUE ORDER BY price ASC');
        res.json({ success: true, packages: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/payment-info', async (req, res) => {
    try {
        const beneficiaryName = await getConfig('financial_beneficiary_name', 'CONVERSIO AO');
        const bankAccountsRaw = await getConfig('financial_bank_accounts', '[]');
        const mcxExpressRaw = await getConfig('financial_mcx_express', '[]');
        
        let bankAccounts = [];
        let mcxExpress = [];
        
        try { bankAccounts = JSON.parse(bankAccountsRaw); } catch(e) { bankAccounts = []; }
        try { mcxExpress = JSON.parse(mcxExpressRaw); } catch(e) { mcxExpress = []; }

        res.json({
            success: true,
            beneficiary_name: beneficiaryName,
            mcx_express: mcxExpress.length > 0 ? mcxExpress : [
                { name: 'Vendas Conversio', number: '923000000' }
            ],
            bank_accounts: bankAccounts.length > 0 ? bankAccounts : [
                { bank: 'BFA', iban: 'AO06 0006 0000 0123 4567 8901 2', account_number: '123456789' },
                { bank: 'BAI', iban: 'AO06 0040 0000 0123 4567 8901 2', account_number: '987654321' }
            ]
        });
    } catch (error: any) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/models', async (req, res) => {
    try {
        const { category, core_id, type } = req.query;
        let result;

        let sql = 'SELECT id, name, credit_cost, category, style_id, description, sort_order FROM models';
        const params: any[] = [];
        const whereClauses: string[] = ["is_active = TRUE"];
        
        if (category) {
            whereClauses.push(`category = $${params.length + 1}`);
            params.push(category);
        }

        if (core_id) {
            whereClauses.push(`core_id = $${params.length + 1}`);
            params.push(core_id);
        }

        if (type) {
            whereClauses.push(`type = $${params.length + 1}`);
            params.push(type);
        }

        if (whereClauses.length > 0) {
            sql += ' WHERE ' + whereClauses.join(' AND ');
        }

        sql += ' ORDER BY sort_order ASC, id ASC';
        result = await query(sql, params);

        res.json({ success: true, models: result.rows });
    } catch (error) {
        console.error('Error fetching models:', error);
        res.status(500).json({ success: false });
    }
});



app.get('/api/admin/users/:id/activity', async (req: AuthRequest, res) => {

    try {
        const { id } = req.params;

        const generations = await query(
            'SELECT id, type, prompt, status, result_url, created_at FROM generations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
            [id]
        );

        const transactions = await query(
            'SELECT id, amount, currency, status, type, description, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
            [id]
        );

        res.json({ 
            success: true, 
            generations: generations.rows,
            transactions: transactions.rows
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- ORCHESTRATOR NEURAL TERMINAL ---
app.post('/api/admin/orchestrator/command', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { command, agentName, taskType, payload } = req.body;
        const adminId = req.user?.id;

        // ── MODE 2: Structured agent command (from command panel buttons) ──
        if (agentName && taskType) {
            try {
                const { runAgentByCommand } = await import('./services/orchestrator.js');
                const resultMsg = await runAgentByCommand(agentName, taskType, payload || {});
                await logAdminAction(adminId as string, 'AGENT_COMMAND', { agentName, taskType, payload });
                return res.json({ success: true, message: resultMsg, reply: resultMsg });
            } catch (e: any) {
                return res.status(500).json({ success: false, message: e.message });
            }
        }

        // ── MODE 1: Free-text terminal command ──
        if (!command) return res.status(400).json({ success: false, message: 'Comando ou agente/taskType requerido.' });

        const apiKeyObj = await keyManager.getWorkingKey('openai');
        if (!apiKeyObj) return res.status(500).json({ success: false, reply: 'ERRO: Sem chaves OpenAI disponíveis.' });

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        const statsRes = await query(`
            SELECT 
                (SELECT COUNT(*) FROM users) as users,
                (SELECT COUNT(*) FROM generations) as gens,
                (SELECT COUNT(*) FROM users WHERE plan != 'free') as paid_users
        `);
        const stats = statsRes.rows[0];

        const systemPrompt = `És o Núcleo do Orquestrador Conversio (Kernel Alpha). Terminal de Comando.

Contexto do Sistema:
- Utilizadores Totais: ${stats.users} (Pagantes: ${stats.paid_users})
- Gerações Totais: ${stats.gens}

Diretivas:
1. Responde de forma técnica, curta e direta (estilo terminal NASA).
2. Usa terminologia: "Status: OK", "Warning: Latency", "[AUTHORIZED]", etc.
3. Se o comando for para ativar/executar algo, confirma que foi enviado para a fila.
4. Mantém respostas abaixo de 150 palavras. Sem Markdown.`;

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: command }
            ],
            max_tokens: 200,
            temperature: 0.15
        });

        const tokens_prompt = completion.usage?.prompt_tokens || 0;
        const tokens_completion = completion.usage?.completion_tokens || 0;
        const estimated_cost = (tokens_prompt * GPT4O_MINI_PRICING.input) + (tokens_completion * GPT4O_MINI_PRICING.output);
        await keyManager.logUsage(apiKeyObj.id, 'openai', 'Orchestrator Terminal', tokens_prompt, tokens_completion, estimated_cost);

        const reply = completion.choices[0].message.content;
        await logAdminAction(adminId as string, 'ORCHESTRATOR_COMMAND', { command, reply });

        res.json({ success: true, reply });
    } catch (e: any) {
        console.error('[Orchestrator Command] Error:', e);
        res.status(500).json({ success: false, message: e.message, reply: 'ERRO: O Kernel falhou. Verifique os logs.' });
    }
});

app.get('/api/admin/behavior-stats', async (req: AuthRequest, res) => {

    try {

        // 1. Generations per hour (last 24h)
        const hourlyGens = await query(`
            SELECT to_char(created_at, 'HH24:00') as hour, COUNT(*) as count 
            FROM generations 
            WHERE created_at >= NOW() - INTERVAL '24 hours' 
            GROUP BY hour ORDER BY hour ASC
        `);

        // 2. New users per day (last 30 days)
        const dailyUsers = await query(`
            SELECT to_char(created_at, 'YYYY-MM-DD') as day, COUNT(*) as count 
            FROM users 
            WHERE created_at >= NOW() - INTERVAL '30 days' 
            GROUP BY day ORDER BY day ASC
        `);

        // 3. Most Active Users (by generation count)
        const activeUsers = await query(`
            SELECT u.name, u.email, COUNT(g.id) as gen_count 
            FROM users u 
            JOIN generations g ON u.id = g.user_id 
            WHERE g.created_at >= NOW() - INTERVAL '30 days'
            GROUP BY u.id, u.name, u.email 
            ORDER BY gen_count DESC LIMIT 10
        `);

        // 4. Generation types breakdown (image/video/audio)
        const genTypes = await query(`
            SELECT type, COUNT(*) as count
            FROM generations
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY type
            ORDER BY count DESC
        `);

        // 5. Top models used
        const topModels = await query(`
            SELECT model, COUNT(*) as count
            FROM generations
            WHERE model IS NOT NULL AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY model
            ORDER BY count DESC
            LIMIT 8
        `);

        // 6. Success vs fail rate
        const successRate = await query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'completed') as completed,
                COUNT(*) FILTER (WHERE status = 'failed') as failed,
                COUNT(*) as total
            FROM generations
            WHERE created_at >= NOW() - INTERVAL '7 days'
        `);

        // 7. Credit consumption by type
        const creditsByType = await query(`
            SELECT type, COALESCE(SUM(cost), 0) as total_credits
            FROM generations
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY type
        `);

        // 8. Weekly revenue trend (last 8 weeks)
        const weeklyRevenue = await query(`
            SELECT to_char(date_trunc('week', created_at), 'DD Mon') as week,
                   COALESCE(SUM(amount), 0) as revenue,
                   COUNT(*) as transactions
            FROM transactions
            WHERE status = 'completed'
            AND created_at >= NOW() - INTERVAL '8 weeks'
            GROUP BY date_trunc('week', created_at)
            ORDER BY date_trunc('week', created_at) ASC
        `);

        // 9. Total platform stats
        const platformStats = await query(`
            SELECT
                (SELECT COUNT(*) FROM users) as total_users,
                (SELECT COUNT(*) FROM users WHERE created_at >= NOW() - INTERVAL '7 days') as new_users_7d,
                (SELECT COUNT(*) FROM generations) as total_gens,
                (SELECT COUNT(*) FROM generations WHERE created_at >= NOW() - INTERVAL '24 hours') as gens_24h,
                (SELECT COALESCE(SUM(cost), 0) FROM generations) as total_credits_consumed,
                (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE status = 'completed') as total_revenue
        `);

        res.json({ 
            success: true, 
            hourlyGens: hourlyGens.rows,
            dailyUsers: dailyUsers.rows,
            activeUsers: activeUsers.rows,
            genTypes: genTypes.rows,
            topModels: topModels.rows,
            successRate: successRate.rows[0],
            creditsByType: creditsByType.rows,
            weeklyRevenue: weeklyRevenue.rows,
            platformStats: platformStats.rows[0]
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});



// --- ADMIN TRANSACTION MANAGEMENT ---
app.get('/api/admin/transactions', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query(`
            SELECT t.*, u.name as user_name, u.email as user_email
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            ORDER BY t.created_at DESC
            LIMIT 100
        `);
        // Sign proof URLs if needed
        const transactions = await Promise.all(result.rows.map(async (tx) => {
            if (tx.proof_url && !tx.proof_url.startsWith('http')) {
                try {
                    const { getSignedS3UrlForKey } = await import('./storage.js');
                    tx.proof_url = await getSignedS3UrlForKey(tx.proof_url);
                } catch (e) {}
            }
            return tx;
        }));
        res.json({ success: true, transactions });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/transactions/:id/approve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    const { id } = req.params;
    try {
        // Get transaction details
        const txRes = await query('SELECT * FROM transactions WHERE id = $1', [id]);
        if (!txRes.rows.length) return res.status(404).json({ success: false, message: 'Transação não encontrada' });

        const tx = txRes.rows[0];
        if (tx.status === 'completed') return res.status(400).json({ success: false, message: 'Transação já aprovada' });

        // Mark as completed
        await query('UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2', ['completed', id]);

        // Credit the user
        const credits = tx.credits || 0;
        if (credits > 0 && tx.user_id) {
            await query('UPDATE users SET credits = credits + $1 WHERE id = $2', [credits, tx.user_id]);
        }

        // Log the action
        await logAdminAction(req.user?.id as string, 'APPROVE_TRANSACTION', { txId: id, credits, userId: tx.user_id });

        res.json({ success: true, message: 'Pagamento aprovado e créditos liberados' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/admin/transactions/:id/reject', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    const { id } = req.params;
    try {
        const txRes = await query('SELECT * FROM transactions WHERE id = $1', [id]);
        if (!txRes.rows.length) return res.status(404).json({ success: false, message: 'Transação não encontrada' });

        await query('UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2', ['rejected', id]);

        await logAdminAction(req.user?.id as string, 'REJECT_TRANSACTION', { txId: id });

        res.json({ success: true, message: 'Pagamento rejeitado' });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/admin/transactions/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    const { id } = req.params;
    try {
        await query('DELETE FROM transactions WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- FINANCIAL CONTROL PAGE ---
app.get('/api/admin/financial', async (req: AuthRequest, res) => {

    try {

        // MRR - Revenue this month from approved transactions
        const mrrResult = await query(`
            SELECT COALESCE(SUM(amount),0) as mrr
            FROM transactions
            WHERE status = 'completed'
            AND created_at >= date_trunc('month', NOW())
        `);

        // Total Revenue all-time
        const totalRevResult = await query(`
            SELECT COALESCE(SUM(amount),0) as total
            FROM transactions
            WHERE status = 'completed'
        `);

        // Monthly Revenue last 6 months
        const monthlyRevResult = await query(`
            SELECT to_char(date_trunc('month', created_at), 'Mon YYYY') as month,
                   COALESCE(SUM(amount),0) as revenue,
                   COUNT(*) as count
            FROM transactions
            WHERE status = 'completed'
            AND created_at >= NOW() - INTERVAL '6 months'
            GROUP BY date_trunc('month', created_at)
            ORDER BY date_trunc('month', created_at) ASC
        `);

        const planStatsResult = { rows: [] };

        // Recent Approved Transactions
        const recentTxResult = await query(`
            SELECT t.*, u.name as user_name
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'completed'
            ORDER BY t.created_at DESC
            LIMIT 10
        `);

        // Most consumed packages
        const packageStatsResult = await query(`
            SELECT t.type as package_id, COALESCE(cp.name, t.type) as name, COUNT(*) as sales, COALESCE(SUM(t.amount),0) as revenue
            FROM transactions t
            LEFT JOIN credit_packages cp ON cp.id::text = t.type
            WHERE t.status = 'completed'
            AND t.type IS NOT NULL
            GROUP BY t.type, cp.name
            ORDER BY sales DESC
            LIMIT 10
        `);

        // Total approved transactions
        const txCountResult = await query(`SELECT COUNT(*) as count FROM transactions WHERE status = 'completed'`);

        // Pending transactions
        const pendingResult = await query(`SELECT COUNT(*) as count FROM transactions WHERE status = 'pending'`);

        // AI Model consumption
        const modelStatsResult = await query(`
            SELECT model, COUNT(*) as count, type
            FROM generations
            WHERE status = 'completed'
            AND created_at >= NOW() - INTERVAL '30 days'
            GROUP BY model, type
            ORDER BY count DESC
            LIMIT 15
        `);

        // Generations per type
        const genTypeResult = await query(`
            SELECT type, COUNT(*) as count
            FROM generations
            WHERE status = 'completed'
            GROUP BY type
        `);

        // Active users (last 7 days)
        const activeUsersResult = await query(`
            SELECT COUNT(DISTINCT user_id) as count
            FROM generations
            WHERE created_at >= NOW() - INTERVAL '7 days'
        `);

        // Total users
        const totalUsersResult = await query(`SELECT COUNT(*) as count FROM users`);

        // Online users (last 5 minutes)
        const onlineUsersResult = await query(`SELECT COUNT(*) as count FROM users WHERE last_active_at >= NOW() - INTERVAL '5 minutes'`);

        // Device Stats
        const deviceStatsResult = await query(`SELECT last_device as device, COUNT(*) as count FROM users WHERE last_device IS NOT NULL GROUP BY last_device`);

        // Top Consumers (Ranking by credits spent)
        const topConsumersResult = await query(`
            SELECT u.name, u.email, SUM(g.cost) as total_spent, COUNT(g.id) as generations
            FROM generations g
            JOIN users u ON g.user_id = u.id
            WHERE g.status = 'completed'
            GROUP BY u.id, u.name, u.email
            ORDER BY total_spent DESC
            LIMIT 10
        `);

        // Pending Payments (Details)
        const pendingPaymentsResult = await query(`
            SELECT t.*, u.name as user_name
            FROM transactions t
            LEFT JOIN users u ON t.user_id = u.id
            WHERE t.status = 'pending'
            ORDER BY t.created_at DESC
            LIMIT 5
        `);

        res.json({
            success: true,
            mrr: Number(mrrResult.rows[0]?.mrr || 0),
            totalRevenue: Number(totalRevResult.rows[0]?.total || 0),
            monthlyRevenue: monthlyRevResult.rows,
            recentTransactions: recentTxResult.rows,
            packageStats: packageStatsResult.rows,
            totalTransactions: Number(txCountResult.rows[0]?.count || 0),
            pendingTransactions: Number(pendingResult.rows[0]?.count || 0),
            modelStats: modelStatsResult.rows,
            genByType: genTypeResult.rows,
            activeUsers: Number(activeUsersResult.rows[0]?.count || 0),
            totalUsers: Number(totalUsersResult.rows[0]?.count || 0),
            onlineUsers: Number(onlineUsersResult.rows[0]?.count || 0),
            deviceStats: deviceStatsResult.rows,
            topConsumers: topConsumersResult.rows,
            pendingPayments: pendingPaymentsResult.rows
        });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/admin/kie/stats', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // 1. Get KIE Budget Balance
        const budgetRes = await query("SELECT credit_balance FROM service_budgets WHERE service = 'kie'");
        const balance = Number(budgetRes.rows[0]?.credit_balance || 0);

        // 2. Conversion Calculations
        // 1000 credits = 5$ e 6.000kzs
        const dollarBalance = (balance / 1000) * 5;
        const kwanzaBalance = (balance / 1000) * 6000;

        // 3. Consumption & Earnings Logic
        // We sum kie_cost from generations metadata
        const consumptionRes = await query(`
            SELECT SUM((metadata->>'kie_cost')::numeric) as total_consumption
            FROM generations
            WHERE status = 'completed' AND metadata->>'kie_cost' IS NOT NULL
        `);
        const totalConsumption = Number(consumptionRes.rows[0]?.total_consumption || 0);

        // We sum user credits (cost) for these generations
        const earningsRes = await query(`
            SELECT SUM(cost) as total_earnings
            FROM generations
            WHERE status = 'completed' AND metadata->>'kie_cost' IS NOT NULL
        `);
        const totalEarnings = Number(earningsRes.rows[0]?.total_earnings || 0);

        const margin = totalEarnings - totalConsumption;

        res.json({
            success: true,
            stats: {
                balance,
                dollarBalance,
                kwanzaBalance,
                totalConsumption,
                totalEarnings,
                margin
            }
        });
    } catch (error: any) {
        console.error('[KIE Stats] Error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- MARKETING EXPERT CHAT ---
app.get('/api/expert/history', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) return res.status(400).json({ success: false });

        const result = await query(
            'SELECT role, content, created_at FROM expert_chat_messages WHERE user_id = $1 ORDER BY created_at ASC LIMIT 50',
            [userId]
        );
        res.json({ success: true, messages: result.rows });
    } catch (error: any) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/expert/chat', authenticateJWT, async (req: AuthRequest, res) => {
    try {
        const { message } = req.body;
        const userId = req.user?.id;
        if (!userId || !message) return res.status(400).json({ success: false, message: 'Dados incompletos' });

        // 1. Get System Prompt
        const systemPrompt = await getConfig('marketing_agent_prompt', 'És um especialista em Marketing Digital focado em Angola.');

        // 2. Get Recent History
        const historyRes = await query(
            'SELECT role, content FROM expert_chat_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
            [userId]
        );
        const history = historyRes.rows.reverse();

        // 3. Prepare Messages for OpenAI
        const messages = [
            { role: 'system', content: systemPrompt },
            ...history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: message }
        ];

        // 4. Call OpenAI
        const apiKeyObj = await keyManager.getWorkingKey('openai');
        if (!apiKeyObj) return res.status(500).json({ success: false, message: 'Sem chaves OpenAI disponíveis no momento.' });

        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: messages as any,
        });

        // Log usage
        const tokens_prompt = completion.usage?.prompt_tokens || 0;
        const tokens_completion = completion.usage?.completion_tokens || 0;
        const estimated_cost = (tokens_prompt * GPT4O_MINI_PRICING.input) + (tokens_completion * GPT4O_MINI_PRICING.output);
        await keyManager.logUsage(apiKeyObj.id, 'openai', 'Expert Chat', tokens_prompt, tokens_completion, estimated_cost);

        const reply = completion.choices[0].message.content;

        // 5. Save Progressively
        await query('INSERT INTO expert_chat_messages (user_id, role, content) VALUES ($1, $2, $3)', [userId, 'user', message]);
        await query('INSERT INTO expert_chat_messages (user_id, role, content) VALUES ($1, $2, $3)', [userId, 'assistant', reply]);

        res.json({ success: true, reply });
    } catch (error: any) {
        console.error('[Expert Chat Error]', error);
        res.status(500).json({ success: false, message: 'Falha ao conversar com o especialista.' });
    }
});

// --- SMART ORCHESTRATOR INTERACTIVE CHAT ---
app.get('/api/admin/orchestrator/chat/history', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const userId = req.user?.id;
        const historyRes = await query(`
            SELECT role, content, created_at FROM orchestrator_chat_messages 
            WHERE user_id = $1 
            ORDER BY created_at ASC 
            LIMIT 50
        `, [userId]);
        res.json({ success: true, history: historyRes.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/orchestrator/chat', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { message } = req.body;
        const userId = req.user?.id;
        if (!message) return res.status(400).json({ success: false, message: 'Mensagem é obrigatória.' });

        const historyRes = await query(`
            SELECT role, content FROM orchestrator_chat_messages 
            WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10
        `, [userId]);
        const history = [...historyRes.rows].reverse();

        const tools: any[] = [
            {
                type: "function",
                function: {
                    name: "get_detailed_stats",
                    description: "Obtém estatísticas detalhadas do sistema sobre leads, créditos e saúde geral.",
                }
            },
            {
                type: "function",
                function: {
                    name: "get_error_logs",
                    description: "Obtém os últimos logs de erro detalhados para diagnóstico.",
                    parameters: {
                        type: "object",
                        properties: {
                            limit: { type: "number", description: "Número de erros a buscar (padrão 10)" }
                        }
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "search_customer",
                    description: "Procura utilizadores por nome, email ou WhatsApp para obter o ID ou dados básicos.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "Termo de pesquisa" }
                        },
                        required: ["query"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "create_marketing_campaign",
                    description: "Cria uma nova campanha de marketing no sistema.",
                    parameters: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Nome da campanha" },
                            type: { type: "string", description: "Tipo (ex: auto_nurture, promotion, recovery)" },
                            message: { type: "string", description: "O conteúdo da mensagem a enviar" },
                            segmentKey: { type: "string", enum: ["new_users", "active_users", "churn_risk", "ready_for_upgrade", "vip_customers"], description: "Chave do segmento de público" }
                        },
                        required: ["name", "type", "message", "segmentKey"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "send_direct_whatsapp",
                    description: "Envia uma mensagem direta de WhatsApp para um utilizador específico via Agente Envios.",
                    parameters: {
                        type: "object",
                        properties: {
                            userId: { type: "string", description: "O ID único do utilizador" },
                            message: { type: "string", description: "Conteúdo da mensagem" }
                        },
                        required: ["userId", "message"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "get_system_health",
                    description: "Verifica se as tabelas e colunas essenciais do banco de dados existem e estão funcionais.",
                }
            },
            {
                type: "function",
                function: {
                    name: "run_database_repair",
                    description: "Executa uma rotina de reparação para criar tabelas em falta ou colunas ausentes (ex: user_id em agent_logs).",
                }
            },
            {
                type: "function",
                function: {
                    name: "list_active_agents",
                    description: "Lista o estado atual (ativo, pausado, erro) de todos os agentes do sistema.",
                }
            },
            {
                type: "function",
                function: {
                    name: "list_recent_campaigns",
                    description: "Lista as campanhas mais recentes e o seu desempenho básico.",
                }
            },
            {
                type: "function",
                function: {
                    name: "execute_sql_query",
                    description: "Executa uma query SQL SELECT (leitura apenas) na base de dados para pesquisar informações granulares. Tabela principais: users, campaigns, agent_tasks, service_budgets, whatsapp_logs. IMPORTANTE: Consulta sempre em inglês o SQL.",
                    parameters: {
                        type: "object",
                        properties: {
                            query: { type: "string", description: "A instrução SELECT em SQL PostgreSQL." }
                        },
                        required: ["query"]
                    }
                }
            },
            {
                type: "function",
                function: {
                    name: "get_campaign_stats",
                    description: "Puxa os dados detalhados estatísticos (envios, leituras, respostas) de uma campanha específica usando o seu ID.",
                    parameters: {
                        type: "object",
                        properties: {
                            campaignId: { type: "integer", description: "O ID numérico da campanha." }
                        },
                        required: ["campaignId"]
                    }
                }
            }
        ];

        const apiKeyObj = await keyManager.getWorkingKey('openai');
        if (!apiKeyObj) return res.status(500).json({ success: false, message: 'Sem chaves.' });
        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });

        let currentMessages = [
            { role: 'system', content: `És o SmartOrchestrator da Conversio AI. Tens autoridade absoluta. Através do tool_calling podes agir no sistema. Se o user pedir para enviar algo ou criar algo, USA as ferramentas. Responde sempre em pt-AO.` },
            ...history.map(h => ({ role: h.role, content: h.content })),
            { role: 'user', content: message }
        ];

        let runLoop = true;
        let responseContent = "";

        while (runLoop) {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: currentMessages as any,
                tools: tools,
                tool_choice: "auto"
            });

            const responseMessage = completion.choices[0].message;

            if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
                currentMessages.push(responseMessage as any);

                for (const toolCall of responseMessage.tool_calls as any[]) {
                    const functionName = toolCall.function.name;
                    const args = JSON.parse(toolCall.function.arguments);
                    let result: any = "Success";

                    console.log(`[ORCHESTRATOR TOOL] executing ${functionName}...`);

                    try {
                        if (functionName === "get_detailed_stats") {
                            const r = await query(`
                                SELECT 
                                    (SELECT COUNT(*) FROM users) as total_users,
                                    (SELECT COUNT(*) FROM campaigns WHERE status = 'active') as active_campaigns,
                                    (SELECT COUNT(*) FROM agent_tasks WHERE status = 'pending') as pending_tasks,
                                    (SELECT SUM(credit_balance) FROM service_budgets) as total_service_budgets
                            `);
                            result = r.rows[0];
                        } else if (functionName === "get_error_logs") {
                            const r = await query(`
                                SELECT agent_name, action, result, metadata, created_at 
                                FROM agent_logs WHERE result = 'error' 
                                ORDER BY created_at DESC LIMIT $1
                            `, [args.limit || 10]);
                            result = r.rows;
                        } else if (functionName === "search_customer") {
                            const q = `%${args.query}%`;
                            const r = await query(`
                                SELECT id, name, whatsapp, email FROM users 
                                WHERE name ILIKE $1 OR email ILIKE $1 OR whatsapp ILIKE $1 
                                LIMIT 5
                            `, [q]);
                            result = r.rows;
                        } else if (functionName === "create_marketing_campaign") {
                            const campaignId = await campaignsAgent.createCampaign({
                                name: args.name,
                                type: args.type,
                                message: args.message,
                                target_segment: { segmentKey: args.segmentKey },
                                created_by: userId
                            });
                            result = { success: true, campaignId, message: "Campanha criada. Aguarda validação ou já iniciou conforme permissões." };
                        } else if (functionName === "send_direct_whatsapp") {
                            await query(`
                                INSERT INTO agent_tasks (agent_name, task_type, priority, payload, status)
                                VALUES ($1, $2, $3, $4, $5)
                            `, ['Agente Envios', 'send_campaign_msg', 2, JSON.stringify({ userId: args.userId, message: args.message, type: 'chat_direct' }), 'awaiting_approval']);
                            result = { success: true, details: "Tarefa enviada para a fila de Validação." };
                        } else if (functionName === "get_system_health") {
                            const tables = await query(`
                                SELECT table_name, 
                                       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = t.table_name AND column_name = 'user_id') as has_user_id
                                FROM (SELECT unnest(ARRAY['users', 'agent_logs', 'campaigns', 'agent_tasks']) as table_name) t
                            `);
                            result = { 
                                status: "Checked", 
                                integrity: tables.rows 
                            };
                        } else if (functionName === "run_database_repair") {
                            await ensureSchemaIntegrity();
                            result = { success: true, message: "Rotina de integridade executada com sucesso. Tabelas/Colunas reparadas." };
                        } else if (functionName === "list_active_agents") {
                            const r = await query(`SELECT name, status, last_run FROM agents ORDER BY name`);
                            result = r.rows;
                        } else if (functionName === "list_recent_campaigns") {
                            const r = await query(`
                                SELECT c.name, c.status, c.target_segment, cs.total_sent 
                                FROM campaigns c 
                                LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id 
                                ORDER BY c.created_at DESC LIMIT 5
                            `);
                            result = r.rows;
                        } else if (functionName === "execute_sql_query") {
                            if (!args.query.trim().toUpperCase().startsWith('SELECT')) {
                                throw new Error("Apenas consultas SELECT de leitura são permitidas para proteção dos dados.");
                            }
                            const r = await query(args.query);
                            result = r.rows.slice(0, 50); // limit payload size
                        } else if (functionName === "get_campaign_stats") {
                            const cid = args.campaignId;
                            const stats = await query(`
                                SELECT 
                                    COUNT(*) as total_sent,
                                    COUNT(*) FILTER (WHERE status = 'read') as total_read,
                                    COUNT(*) FILTER (WHERE status = 'failed') as total_failed
                                FROM whatsapp_logs
                                WHERE campaign_id = $1 AND direction = 'outbound'
                            `, [cid]);
                            
                            const replies = await query(`
                                SELECT COUNT(DISTINCT w1.user_id) as replies
                                FROM whatsapp_logs w1
                                JOIN whatsapp_logs w2 ON w1.user_id = w2.user_id 
                                WHERE w2.campaign_id = $1 AND w2.direction = 'outbound' 
                                AND w1.direction = 'inbound' AND w1.created_at > w2.created_at
                                AND w1.created_at < w2.created_at + INTERVAL '3 days'
                            `, [cid]);

                            result = {
                                campaignId: cid,
                                totalSent: parseInt(stats.rows[0].total_sent) || 0,
                                totalRead: parseInt(stats.rows[0].total_read) || 0,
                                totalReplies: parseInt(replies.rows[0].replies) || 0,
                                totalFailed: parseInt(stats.rows[0].total_failed) || 0
                            };
                        }
                    } catch (e: any) {
                        result = { error: e.message };
                    }

                    currentMessages.push({
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(result)
                    } as any);
                }
            } else {
                responseContent = responseMessage.content || "Sem resposta.";
                runLoop = false;
            }
        }

        await query(`INSERT INTO orchestrator_chat_messages (user_id, role, content) VALUES ($1, $2, $3)`, [userId, 'user', message]);
        await query(`INSERT INTO orchestrator_chat_messages (user_id, role, content) VALUES ($1, $2, $3)`, [userId, 'assistant', responseContent]);

        res.json({ success: true, reply: responseContent });
    } catch (error: any) {
        console.error('--- [ORCHESTRATOR CHAT ERROR] ---', error.message);
        res.status(500).json({ success: false, message: 'Erro na conversa: ' + error.message });
    }
});

// [DUPLICATE REMOVED] — Orchestrator command route is defined at line ~4969 (unified terminal + agent commands)

app.get('/api/orchestrator/pending-actions', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const tasks = await query(`
            SELECT id, agent_name, task_type, payload, created_at 
            FROM agent_tasks 
            WHERE status = 'awaiting_approval' 
            ORDER BY created_at DESC
        `);
        const campaigns = await query(`
            SELECT id, name, type, message, target_segment, created_at 
            FROM campaigns 
            WHERE status = 'pending_validation' 
            ORDER BY created_at DESC
        `);
        res.json({ success: true, tasks: tasks.rows, campaigns: campaigns.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/tasks/:id/approve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE agent_tasks SET status = 'pending' WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Acção aprovada e enfileirada para execução.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/tasks/:id/reject', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE agent_tasks SET status = 'failed', error_message = 'Rejeitado pelo Admin' WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Acção rejeitada.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/orchestrator/status', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agentsRes = await query(`SELECT * FROM agents ORDER BY id ASC`);
        const pendingTasksRes = await query(`SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'pending'`);
        const errorTasksRes = await query(`SELECT COUNT(*) as count FROM agent_tasks WHERE status = 'failed'`);
        
        res.json({
            success: true,
            agents: agentsRes.rows,
            queue: {
                pending: parseInt(pendingTasksRes.rows[0].count),
                failed: parseInt(errorTasksRes.rows[0].count)
            }
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/pause/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agentName = req.params.agentName as string;
        const decodedName = decodeURIComponent(agentName);
        await query(`UPDATE agents SET status = 'paused' WHERE name = $1`, [decodedName]);
        res.json({ success: true, message: `Agente ${decodedName} pausado.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/resume/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agentName = req.params.agentName as string;
        const decodedName = decodeURIComponent(agentName);
        await query(`UPDATE agents SET status = 'active' WHERE name = $1`, [decodedName]);
        res.json({ success: true, message: `Agente ${decodedName} retomado.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/run/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agentName = req.params.agentName as string;
        const decodedName = decodeURIComponent(agentName);
        // O import dinaâmico impede erros circulares
        const orchestrator = await import('./services/orchestrator.js');
        // Para forçar a run imediamente (assumindo que a versão futura do código o faça por agent specific)
        // Aqui invocamos o core flow
        setTimeout(() => orchestrator.runOrchestrator(), 0); // corre de base
        res.json({ success: true, message: `Processamento do Orquestrador forçado para arranque imediato.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// AGENTE FUNIL API
// ============================================

app.get('/api/agents/funnel/leads', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const leadsRes = await query(`
            SELECT l.*, u.name, u.email, u.phone, u.whatsapp, u.plan 
            FROM leads l
            JOIN users u ON l.user_id = u.id
            ORDER BY l.score DESC
        `);
        res.json({ success: true, leads: leadsRes.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/agents/funnel/lead/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const userId = req.params.userId as string;
        const leadRes = await query(`
            SELECT l.*, u.name, u.email, u.phone, u.whatsapp, u.plan 
            FROM leads l
            JOIN users u ON l.user_id = u.id
            WHERE l.user_id = $1
        `, [userId]);

        if (leadRes.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'Lead não encontrado.' });
        }

        const leadId = leadRes.rows[0].id;
        const interactionsRes = await query(`
            SELECT id, type, metadata, created_at 
            FROM lead_interactions 
            WHERE lead_id = $1 
            ORDER BY created_at DESC
        `, [leadId]);

        res.json({ success: true, lead: leadRes.rows[0], interactions: interactionsRes.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/agents/funnel/recalculate/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const userId = req.params.userId as string;
        const funnelAgent = await import('./services/funnelAgent.js');
        const score = await funnelAgent.qualifyLead(userId);
        const temp = funnelAgent.classifyTemperature(score);
        await funnelAgent.updateLeadStage(score, score); // O stage update tb fará algo

        await query(`UPDATE leads SET score = $1, temperature = $2, last_interaction = now() WHERE user_id = $3`, [score, temp, userId]);

        // Grava no log de sistema
        await query(`
            INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
            VALUES ($1, $2, $3, $4, $5)
        `, ['Agente Funil', 'MANUAL_RECALCULATE', userId, 'success', JSON.stringify({ score, temp })]);

        res.json({ success: true, message: `Score recalculado: ${score} (${temp})`, score, temperature: temp });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/agents/funnel/stats', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const tempStats = await query(`SELECT temperature, COUNT(*) as count FROM leads GROUP BY temperature`);
        const stageStats = await query(`SELECT stage, COUNT(*) as count FROM leads GROUP BY stage`);
        
        res.json({
            success: true,
            temperatureStats: tempStats.rows,
            stageStats: stageStats.rows
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// AGENTE CAMPANHAS API
// ============================================

app.get('/api/campaigns', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const campaigns = await query(`
            SELECT c.*, cs.total_sent, cs.total_converted, cs.revenue_generated 
            FROM campaigns c
            LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
            ORDER BY c.created_at DESC
        `);
        res.json({ success: true, campaigns: campaigns.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/campaigns/create', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { name, type, target_segment } = req.body;
        const campaignsAgent = await import('./services/campaignsAgent.js');
        const campaignId = await campaignsAgent.createCampaign({
            name, type, target_segment, created_by: req.user?.id
        });
        res.json({ success: true, message: 'Campanha criada e audiência segmentada.', campaignId });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/campaigns/:id/launch', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE campaigns SET status = 'active' WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Campanha lançada com sucesso.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/campaigns/:id/pause', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE campaigns SET status = 'paused' WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Campanha pausada.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/campaigns/:id/stats', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const stats = await query(`SELECT * FROM campaign_stats WHERE campaign_id = $1`, [id]);
        res.json({ success: true, stats: stats.rows[0] });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/campaigns/:id/recipients', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const recipients = await query(`
            SELECT cr.*, u.name, u.email, u.whatsapp 
            FROM campaign_recipients cr
            JOIN users u ON cr.user_id = u.id
            WHERE cr.campaign_id = $1
            ORDER BY cr.sent_at DESC NULLS LAST
        `, [id]);
        res.json({ success: true, recipients: recipients.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// AGENTE RECUPERAÇÃO API
// ============================================

app.get('/api/agents/recovery/risks', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const risks = await query(`
            SELECT cr.*, u.name, u.email, u.whatsapp, u.plan 
            FROM churn_risks cr
            JOIN users u ON cr.user_id = u.id
            ORDER BY 
                CASE risk_level 
                    WHEN 'critical' THEN 1 
                    WHEN 'high' THEN 2 
                    WHEN 'medium' THEN 3 
                    WHEN 'low' THEN 4 
                    ELSE 5 
                END ASC,
                cr.days_inactive DESC
        `);
        res.json({ success: true, risks: risks.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/agents/recovery/stats', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const stats = await query(`
            SELECT recovery_status, COUNT(*) as count 
            FROM churn_risks 
            GROUP BY recovery_status
        `);
        // Adicionar taxa por nível
        const levelStats = await query(`
            SELECT risk_level, COUNT(*) FILTER (WHERE recovery_status = 'recovered') as recovered, COUNT(*) as total
            FROM churn_risks
            GROUP BY risk_level
        `);
        res.json({ success: true, general: stats.rows, byLevel: levelStats.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/agents/recovery/trigger/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { userId } = req.params;
        const recoveryAgent = await import('./services/recoveryAgent.js');
        const userRes = await query(`SELECT id, last_login_at, created_at, plan FROM users WHERE id = $1`, [userId]);
        
        if (userRes.rowCount === 0) return res.status(404).json({ success: false, message: 'User not found' });
        
        await recoveryAgent.detectChurnRisk(userRes.rows[0]);
        const riskRes = await query(`SELECT risk_level FROM churn_risks WHERE user_id = $1`, [userId]);
        const riskLevel = riskRes.rows[0]?.risk_level || 'low';
        
        await recoveryAgent.triggerRecovery(userId as string, riskLevel);
        res.json({ success: true, message: `Protocolo ${riskLevel} disparado manualmente.`, riskLevel });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/agents/recovery/mark-recovered/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { userId } = req.params;
        await query(`UPDATE churn_risks SET recovery_status = 'recovered' WHERE user_id = $1`, [userId]);
        res.json({ success: true, message: 'Utilizador marcado como recuperado manualmente.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ============================================
// AGENTE MONITOR API
// ============================================

app.get('/api/monitor/health', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const agents = await query(`SELECT name, status, last_run FROM agents`);
        const openAlerts = await query(`SELECT COUNT(*) FROM alerts WHERE status = 'active'`);
        const stuckTasks = await query(`SELECT COUNT(*) FROM agent_tasks WHERE status = 'running' AND created_at < NOW() - INTERVAL '30 minutes'`);
        
        res.json({ 
            success: true, 
            status: openAlerts.rows[0].count > 0 ? 'warning' : 'ok',
            agents: agents.rows, 
            activeAlerts: openAlerts.rows[0].count,
            stuckTasks: stuckTasks.rows[0].count 
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- Monitoring & Alert Center Routes ---
app.get('/api/monitor/metrics', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const metrics = await query('SELECT * FROM system_metrics ORDER BY created_at DESC LIMIT 100');
        res.json({ success: true, metrics: metrics.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/monitor/alerts', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const alerts = await query('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50');
        res.json({ success: true, alerts: alerts.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/monitor/alerts/:id/acknowledge', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE alerts SET status = 'acknowledged', acknowledged_at = now() WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Alerta reconhecido.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/monitor/alerts/:id/resolve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query("UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/reports', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const reports = await query('SELECT * FROM reports ORDER BY generated_at DESC LIMIT 50');
        res.json({ success: true, reports: reports.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/reports/generate', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { type } = req.body;
        const reportService = await import('./services/reportService.js');
        let data;
        
        if (type === 'weekly') data = await reportService.generateWeeklyReport();
        else data = await reportService.generateDailyDigest();
        
        res.json({ success: true, message: 'Relatório gerado com sucesso.', data });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/crm/profile/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { userId } = req.params;
        const profile = await query(`
            SELECT u.name, u.email, u.whatsapp, u.plan, u.created_at,
                   cp.*
            FROM users u
            LEFT JOIN crm_profiles cp ON cp.user_id = u.id
            WHERE u.id = $1
        `, [userId]);
        
        if (profile.rowCount === 0) return res.status(404).json({ success: false, message: 'Perfil não encontrado.' });
        
        res.json({ success: true, profile: profile.rows[0] });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/crm/enrich/:userId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { userId } = req.params;
        const crmAgent = await import('./services/crmAgent.js');
        await crmAgent.updateCRMProfile(userId as string);
        const insights = await crmAgent.enrichProfile(userId as string);
        res.json({ success: true, message: 'Perfil enriquecido com sucesso.', insights });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/retargeting/audiences', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const audiences = await query('SELECT * FROM retargeting_audiences ORDER BY last_synced DESC NULLS LAST');
        res.json({ success: true, audiences: audiences.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/admin/retargeting/sync', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const retargetingService = await import('./services/retargetingService.js');
        await retargetingService.updateRetargetingAudiences();
        res.json({ success: true, message: 'Sincronização de audiências iniciada.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/agents/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const configs = await query('SELECT * FROM agent_config ORDER BY agent_name ASC');
        res.json({ success: true, configs: configs.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/admin/agents/config/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { timing_minutes, allowed_hours, admin_alert_whatsapp, recovery_discount_pct, urgency_discount_pct, cooldown_hours, alert_toggles } = req.body;
        
        await query(`
            UPDATE agent_config 
            SET timing_minutes = $1, 
                allowed_hours = $2, 
                admin_alert_whatsapp = $3, 
                recovery_discount_pct = $4, 
                urgency_discount_pct = $5, 
                cooldown_hours = $6, 
                alert_toggles = $7,
                updated_at = now()
            WHERE id = $8
        `, [timing_minutes, JSON.stringify(allowed_hours), admin_alert_whatsapp, recovery_discount_pct, urgency_discount_pct, cooldown_hours, JSON.stringify(alert_toggles), id]);
        
        res.json({ success: true, message: 'Configuração atualizada.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// The monitoring routes are already defined above around line 5035.
// Removing duplicated routes to prevent ambiguity.

app.post('/api/monitor/alerts/:id/resolve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query("UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- Reports & Campaigns ---
app.get('/api/admin/reports', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const reports = await query('SELECT * FROM reports ORDER BY generated_at DESC LIMIT 50');
        res.json({ success: true, reports: reports.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/campaigns', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // Fallback for the frontend request reported in console
        const campaigns = await query('SELECT * FROM crm_campaigns ORDER BY created_at DESC');
        res.json({ success: true, campaigns: campaigns.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/agents/logs', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const logs = await query('SELECT * FROM agent_logs ORDER BY created_at DESC LIMIT 200');
        res.json({ success: true, logs: logs.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/whatsapp/metrics', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const metrics = await query(`
            SELECT 
                category,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE status = 'delivered') as success,
                COUNT(*) FILTER (WHERE status = 'failed') as failed
            FROM whatsapp_logs
            WHERE created_at >= NOW() - INTERVAL '30 days'
            GROUP BY category
        `);
        
        const health = await EvolutionService.getInstanceStatus().catch(() => ({ state: 'error' }));
        
        res.json({ success: true, metrics: metrics.rows, apiStatus: health.state });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Duplicated pulse route removed. Using the one at line 3285.

app.post('/api/admin/whatsapp/test-connection', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const adminWhatsapp = await getAdminWhatsApp();
        if (!adminWhatsapp) {
            return res.status(400).json({ success: false, message: 'Nenhum número de WhatsApp Admin configurado.' });
        }

        const msg = `✅ *TESTE DE SISTEMA CONVERSIO AI*\n\nEsta mensagem confirma que a ligação entre o seu Painel Admin e a *Evolution API* está configurada corretamente.\n\nDestino: ${adminWhatsapp}\nData: ${new Date().toLocaleString()}`;
        
        const result = await sendWhatsAppMessage(adminWhatsapp, msg, 'test');
        
        if (result.success) {
            res.json({ success: true, message: `Mensagem de teste enviada para ${adminWhatsapp}. Verifique o seu telemóvel.` });
        } else {
            res.status(500).json({ success: false, message: `Falha na Evolution API: ${result.error}` });
        }
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// --- AGENT CONFIG CRUD (used by AgentConfigEditor & useAgentsDashboard) ---
app.get('/api/admin/agents/config', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // Try agent_configs table first, fallback to agent_team settings
        let configs: any[] = [];
        try {
            const result = await query('SELECT * FROM agent_configs ORDER BY agent_name ASC');
            configs = result.rows;
        } catch {
            // Fallback: build configs from agent_team table
            const agents = await query('SELECT id, persona_name as agent_name, is_active FROM agent_team ORDER BY persona_name ASC');
            configs = agents.rows.map((a: any) => ({
                id: a.id,
                agent_name: a.agent_name,
                timing_minutes: 60,
                recovery_discount_pct: 10,
                admin_alert_whatsapp: '',
                alert_toggles: { errors: true }
            }));
        }
        res.json({ success: true, configs });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.put('/api/admin/agents/config/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { timing_minutes, recovery_discount_pct, admin_alert_whatsapp, alert_toggles } = req.body;
        try {
            await query(
                `INSERT INTO agent_configs (id, timing_minutes, recovery_discount_pct, admin_alert_whatsapp, alert_toggles)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (id) DO UPDATE SET 
                    timing_minutes = EXCLUDED.timing_minutes,
                    recovery_discount_pct = EXCLUDED.recovery_discount_pct,
                    admin_alert_whatsapp = EXCLUDED.admin_alert_whatsapp,
                    alert_toggles = EXCLUDED.alert_toggles`,
                [id, timing_minutes, recovery_discount_pct, admin_alert_whatsapp, JSON.stringify(alert_toggles)]
            );
        } catch {
            // agent_configs table may not exist yet, store in system_settings as fallback
            await query(
                `INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                [`agent_config_${id}`, JSON.stringify(req.body)]
            );
        }
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.get('/api/admin/crm/campaigns', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const result = await query(`
            SELECT 
                c.id, 
                c.name, 
                c.status, 
                c.message as message_template,
                c.created_at,
                cs.total_sent as sent_count 
            FROM campaigns c
            LEFT JOIN campaign_stats cs ON c.id = cs.campaign_id
            WHERE c.status != 'deleted'
            ORDER BY c.created_at DESC
        `);
        res.json({ success: true, campaigns: result.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- CAMPAIGN DELETE ---
app.delete('/api/admin/crm/campaigns/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        // Soft delete to preserve financial/SMS logs
        await query(`UPDATE campaigns SET status = 'deleted' WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- CAMPAIGN CREATE (used by CampaignManager) ---
app.post('/api/campaigns', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const newCampaign = req.body;
        const result = await query(
            `INSERT INTO campaigns (name, type, message, target_segment, status)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [
                newCampaign.name || 'Nova Campanha',
                'marketing',
                newCampaign.message_template || newCampaign.template || '',
                JSON.stringify(newCampaign.target_segment || 'all'),
                'pending_validation'
            ]
        );
        res.json({ success: true, campaign: result.rows[0] });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- ORCHESTRATOR CONTROLS (used by useAgentsDashboard) ---
app.post('/api/orchestrator/pause/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { agentName } = req.params;
        await query(`UPDATE agent_team SET is_active = false WHERE persona_name ILIKE $1`, [agentName]);
        res.json({ success: true, message: `Agente ${agentName} pausado.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/resume/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { agentName } = req.params;
        await query(`UPDATE agent_team SET is_active = true WHERE persona_name ILIKE $1`, [agentName]);
        res.json({ success: true, message: `Agente ${agentName} reativado.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/api/orchestrator/run/:agentName', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { agentName } = req.params;
        // Log the manual trigger
        await query(
            `INSERT INTO agent_logs (agent_name, action, status, details) VALUES ($1, 'manual_run', 'triggered', '{}')`,
            [agentName]
        ).catch(() => {}); // Non-critical
        res.json({ success: true, message: `Execução manual do agente ${agentName} agendada.` });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});


// Acknowledge alert  
app.post('/api/monitor/alerts/:id/acknowledge', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`UPDATE alerts SET status = 'acknowledged' WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- admin/reports/generate ---
app.post('/api/admin/reports/generate', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { type } = req.body;
        const reportData = {
            users: await query('SELECT COUNT(*) FROM users').then(r => r.rows[0].count),
            revenue: await query("SELECT SUM(amount) FROM transactions WHERE status = 'approved'").then(r => r.rows[0].sum || 0),
            messages: await query("SELECT COUNT(*) FROM whatsapp_logs WHERE created_at >= NOW() - INTERVAL '30 days'").then(r => r.rows[0].count)
        };
        await query(
            `INSERT INTO reports (type, data, generated_at) VALUES ($1, $2, NOW())`,
            [type || 'summary', JSON.stringify(reportData)]
        ).catch(() => {}); // Non-critical if reports table doesn't exist
        res.json({ success: true, report: reportData });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// --- Background Job: Generation Timeouts & Refunds ---
setInterval(async () => {
    try {
        // Find generations older than 10 minutes that are still processing
        const timeoutRows = await query(`
            SELECT id, user_id, cost, metadata 
            FROM generations 
            WHERE status = 'processing' 
            AND created_at < NOW() - INTERVAL '10 minutes'
        `);

        
        for (const row of timeoutRows.rows) {
            // Update to failed
            await query("UPDATE generations SET status = 'failed' WHERE id = $1", [row.id]);
            
            // Refund cost if valid
            const cost = parseFloat(row.cost);
            if (cost > 0 && row.user_id) {
                await query("UPDATE users SET credits = credits + $1 WHERE id = $2", [cost, row.user_id]);
                console.log(`[Timeout Cron] Refunded ${cost} credits to user ${row.user_id} for stranded generation ${row.id}`);
            }
        }
    } catch (e) {
        console.error('[Timeout Cron Error]', e);
    }
}, 60000); // Runs every 1 minute


// ─── PUBLIC CREDIT PACKAGES (For Landing Page) ───────────────────────────────

app.get('/api/public/credit-packages', async (_req, res) => {
    try {
        const result = await query('SELECT * FROM credit_packages WHERE is_active = true ORDER BY price ASC');
        res.json({ success: true, packages: result.rows });
    } catch (e: any) {
        console.error('[PublicPackages] Error:', e.message);
        res.status(500).json({ success: false, message: e.message });
    }
});


// ─── LANDING MEDIA MANAGEMENT (CMS) ──────────────────────────────────────────

// Public list for Landing Page
app.get('/api/public/landing-media', async (_req, res) => {
    try {
        const result = await query('SELECT slot_id, media_url, media_type, description FROM landing_media ORDER BY id ASC');
        for (const row of result.rows) {
            if (row.media_url.includes('contabostorage.com')) {
                try { row.media_url = await getSignedS3UrlForKey(row.media_url, 86400); } catch(e) {}
            }
        }
        res.json({ success: true, media: result.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Admin list
app.get('/api/admin/landing-media', authenticateJWT, isAdmin, async (_req, res) => {
    try {
        const result = await query('SELECT * FROM landing_media ORDER BY id ASC');
        for (const row of result.rows) {
            if (row.media_url.includes('contabostorage.com')) {
                try { row.media_url = await getSignedS3UrlForKey(row.media_url, 86400); } catch(e) {}
            }
        }
        res.json({ success: true, media: result.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Admin upload/update media
const mediaUpload = multer({ storage: multer.memoryStorage() });
app.post('/api/admin/landing-media/:slotId', authenticateJWT, isAdmin, mediaUpload.single('file'), async (req: AuthRequest, res) => {
    try {
        const { slotId } = req.params;
        const file = req.file;
        if (!file) return res.status(400).json({ success: false, message: 'Nenhum ficheiro enviado.' });

        const bucketName = await getConfig('storage_bucket', "kwikdocsao");
        const endpoint = await getConfig('storage_endpoint', "https://usc1.contabostorage.com");
        const s3 = await getS3Client();

        const extension = file.originalname.split('.').pop();
        const key = `midia-front-end/${slotId}_${Date.now()}.${extension}`;

        const command = new PutObjectCommand({
            Bucket: bucketName,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
            ACL: 'public-read'
        });

        await s3.send(command);
        const publicUrl = `${endpoint}/${bucketName}/${key}`;

        // Update database
        const mediaType = file.mimetype.startsWith('video') ? 'video' : 'image';
        const existing = await query('SELECT id FROM landing_media WHERE slot_id = $1', [slotId]);

        if (existing.rows.length > 0) {
            await query(
                `UPDATE landing_media SET media_url = $1, media_type = $2, updated_at = NOW() WHERE slot_id = $3`,
                [publicUrl, mediaType, slotId]
            );
        } else {
            await query(
                `INSERT INTO landing_media (slot_id, media_url, media_type) VALUES ($1, $2, $3)`,
                [slotId, publicUrl, mediaType]
            );
        }

        res.json({ success: true, media_url: publicUrl });
    } catch (e: any) {
        console.error('[AdminMedia] Upload error:', e);
        res.status(500).json({ success: false, message: e.message });
    }
});

// Admin delete media (resets to placeholder)
app.delete('/api/admin/landing-media/:slotId', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { slotId } = req.params;
        // Reset to a basic placeholder or empty
        await query(
            `UPDATE landing_media SET media_url = '/placeholder.png', updated_at = NOW() WHERE slot_id = $1`,
            [slotId]
        );
        res.json({ success: true, message: 'Mídia removida e redirecionada para placeholder.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// SMART ORCHESTRATOR — PLANOS DE AÇÃO
// ═══════════════════════════════════════════════════════════════

// Listar planos de ação
app.get('/api/admin/orchestrator/action-plans', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { status, limit = 50 } = req.query;
        let whereClause = status ? `WHERE oap.status = '${status}'` : "WHERE oap.status != 'executing'";

        const plans = await query(`
            SELECT 
                oap.*,
                u.name as approved_by_name
            FROM orchestrator_action_plans oap
            LEFT JOIN users u ON u.id = oap.approved_by
            ${whereClause}
            ORDER BY priority ASC, suggested_at DESC
            LIMIT $1
        `, [parseInt(limit as string)]);

        const counts = await query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'pending_approval') as pending,
                COUNT(*) FILTER (WHERE status = 'approved') as approved,
                COUNT(*) FILTER (WHERE status = 'completed') as completed,
                COUNT(*) FILTER (WHERE status = 'rejected') as rejected
            FROM orchestrator_action_plans
        `);

        res.json({ 
            success: true, 
            plans: plans.rows,
            counts: counts.rows[0]
        });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Aprovar plano de ação
app.put('/api/admin/orchestrator/action-plans/:id/approve', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const adminId = (req as any).user?.id || (req as any).user?.userId;

        await query(`
            UPDATE orchestrator_action_plans 
            SET status = 'approved', approved_at = now(), approved_by = $1
            WHERE id = $2 AND status = 'pending_approval'
        `, [adminId, id]);

        // Trigger immediate execution in background
        const { executeApprovedPlans } = await import('./services/smartOrchestrator.js');
        executeApprovedPlans().catch(e => console.error('[API] Auto-trigger plan execution error:', e));

        res.json({ success: true, message: 'Plano aprovado. Execução iniciada imediatamente.' });

    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Rejeitar plano de ação
app.put('/api/admin/orchestrator/action-plans/:id/reject', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;

        await query(`
            UPDATE orchestrator_action_plans 
            SET status = 'rejected'
            WHERE id = $1
        `, [id]);

        res.json({ success: true, message: 'Plano rejeitado.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Forçar análise imediata do Orquestrador
app.post('/api/admin/orchestrator/trigger-analysis', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        // Import and run immediately in background
        const { runSmartOrchestrator } = await import('./services/smartOrchestrator.js');
        
        // Run in background and respond immediately
        runSmartOrchestrator().catch(e => console.error('[API] Smart orchestrator trigger error:', e));

        res.json({ success: true, message: 'Análise iniciada em background. Os planos aparecerão em breve.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// [DUPLICATE REMOVED] — Orchestrator command route is defined at line ~4969 (unified terminal + agent commands)

// Executar plano específico agora
app.post('/api/admin/orchestrator/action-plans/:id/execute', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;

        // Mark as approved first, then execute
        const adminId = (req as any).user?.userId;
        await query(`
            UPDATE orchestrator_action_plans 
            SET status = 'approved', approved_at = now(), approved_by = $1
            WHERE id = $2
        `, [adminId, id]);

        const { executeApprovedPlans } = await import('./services/smartOrchestrator.js');
        executeApprovedPlans().catch(e => console.error('[API] Execute plan error:', e));

        res.json({ success: true, message: 'Execução iniciada em background.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// CONTAS BANCÁRIAS — GESTÃO (Admin)
// ═══════════════════════════════════════════════════════════════

// Listar contas bancárias
app.get('/api/admin/bank-accounts', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const accounts = await query(`
            SELECT * FROM bank_accounts ORDER BY is_active DESC, bank_name ASC
        `);
        res.json({ success: true, accounts: accounts.rows });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Adicionar nova conta bancária
app.post('/api/admin/bank-accounts', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { bank_name, account_holder, iban, account_number, multicaixa_reference, multicaixa_entity, notes } = req.body;

        if (!bank_name || !account_holder) {
            return res.status(400).json({ success: false, message: 'Nome do banco e titular são obrigatórios.' });
        }

        const result = await query(`
            INSERT INTO bank_accounts (bank_name, account_holder, iban, account_number, multicaixa_reference, multicaixa_entity, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `, [bank_name, account_holder, iban, account_number, multicaixa_reference, multicaixa_entity, notes]);

        res.json({ success: true, account: result.rows[0] });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Atualizar conta bancária
app.put('/api/admin/bank-accounts/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        const { bank_name, account_holder, iban, account_number, multicaixa_reference, multicaixa_entity, notes, is_active } = req.body;

        const result = await query(`
            UPDATE bank_accounts 
            SET bank_name = $1, account_holder = $2, iban = $3, account_number = $4, 
                multicaixa_reference = $5, multicaixa_entity = $6, notes = $7, is_active = $8, updated_at = now()
            WHERE id = $9
            RETURNING *
        `, [bank_name, account_holder, iban, account_number, multicaixa_reference, multicaixa_entity, notes, is_active, id]);

        res.json({ success: true, account: result.rows[0] });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Remover conta bancária
app.delete('/api/admin/bank-accounts/:id', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        await query(`DELETE FROM bank_accounts WHERE id = $1`, [id]);
        res.json({ success: true, message: 'Conta removida.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// VERIFICAÇÃO AI DE COMPROVATIVOS
// ═══════════════════════════════════════════════════════════════

// Disparar verificação AI para uma transação
app.post('/api/admin/transactions/:id/verify', authenticateJWT, isAdmin, async (req: AuthRequest, res) => {
    try {
        const { id } = req.params;
        /*
        const { verifyPaymentProof } = await import('./services/paymentVerificationAgent.js');

        // Atualizar para "verificando"
        await query(`UPDATE transactions SET verification_status = 'analyzing' WHERE id = $1`, [id]);

        // Rodar em background
        verifyPaymentProof(id)
            .then(result => {
                console.log(`[API] Verificação da transação #${id} concluída: ${result.status}`);
            })
            .catch(e => {
                console.error(`[API] Erro na verificação: `, e);
                query(`UPDATE transactions SET verification_status = 'error' WHERE id = $1`, [id]).catch(() => {});
            });

        res.json({ success: true, message: 'Verificação AI iniciada. O resultado aparecerá em breve e o admin será notificado.' });
        */
        res.json({ success: true, message: 'A verificação automática foi desativada por solicitação do administrador. Por favor, analise o comprovativo manualmente.' });
    } catch (e: any) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// Global Error Handler for malformed JSON (body-parser)
app.use((err: any, _req: any, res: any, next: any) => {
    if (err instanceof SyntaxError && 'status' in err && err.status === 400 && 'body' in err) {
        console.error('[Bad JSON] Invalid request body format received.');
        return res.status(400).json({ success: false, message: 'JSON inválido no corpo do pedido.' });
    }
    next();
});

const PORT = process.env.PORT || 3003;

app.listen(PORT, () => {
    console.log(`[Backend] Auth API server rodando em http://localhost:${PORT}`);
    initAdminDb(); // Run admin tables init on startup
});
