import axios from 'axios';
import dotenv from 'dotenv';
import { query } from '../db.js';

dotenv.config();

import { getConfig } from '../config.js';

export const sendWhatsAppMessage = async (
    number: string, 
    text: string, 
    category: string = 'general', 
    delayMs: number = 1200,
    userId: string | null = null,
    campaignId: number | null = null
) => {
    const EVOLUTION_API_URL = await getConfig('EVOLUTION_API_URL');
    const EVOLUTION_API_KEY = await getConfig('EVOLUTION_API_KEY');
    const EVOLUTION_INSTANCE = await getConfig('EVOLUTION_INSTANCE');

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        console.error('Evolution API credentials missing');
        return { success: false, error: 'Configuração da API WhatsApp ausente' };
    }

    try {
        // Formatar o número (remover espaços, caracteres especiais e garantir o DDI)
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.startsWith('244') && formattedNumber.length === 9) {
            formattedNumber = '244' + formattedNumber;
        }

        const response = await axios.post(
            `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
            {
                number: formattedNumber,
                options: {
                    delay: delayMs,
                    presence: "composing",
                    linkPreview: false
                },
                text: text

            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                }
            }
        );

        await query(
            `INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category, user_id, campaign_id, direction) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [formattedNumber, 'text', text, 'success', null, category, userId, campaignId, 'outbound']
        ).catch(e => console.error('[WhatsApp Log Error]', e.message));

        console.log(`[WhatsApp Agent] ✅ Mensagem enviada para ${formattedNumber} (Categoria: ${category})`);

        return { success: true, data: response.data };
    } catch (error: any) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error('Error sending WhatsApp message:', JSON.stringify(error.response?.data || error.message, null, 2));

        await query(
            `INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category, user_id, campaign_id, direction) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [number, 'text', text, 'failed', errorMsg, category, userId, campaignId, 'outbound']
        ).catch(e => console.error('[WhatsApp Log Error]', e.message));

        return { 
            success: false, 
            error: errorMsg 
        };
    }
};

export const generateVerificationCode = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

export const sendWhatsAppDocument = async (
    number: string, 
    documentUrl: string, 
    fileName: string, 
    caption?: string, 
    category: string = 'general',
    userId: string | null = null,
    campaignId: number | null = null
) => {
    const EVOLUTION_API_URL = await getConfig('EVOLUTION_API_URL');
    const EVOLUTION_API_KEY = await getConfig('EVOLUTION_API_KEY');
    const EVOLUTION_INSTANCE = await getConfig('EVOLUTION_INSTANCE');

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        console.error('Evolution API credentials missing for document');
        return { success: false, error: 'Configuração da API WhatsApp ausente' };
    }

    try {
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.startsWith('244') && formattedNumber.length === 9) {
            formattedNumber = '244' + formattedNumber;
        }

        const data = {
            number: formattedNumber,
            options: {
                delay: 1200,
                presence: "composing",
                linkPreview: false
            },
            mediatype: "document",
            mimetype: "application/pdf",
            caption: caption || "",
            media: documentUrl,
            fileName: fileName
        };

        const response = await axios.post(
            `${EVOLUTION_API_URL}/message/sendMedia/${EVOLUTION_INSTANCE}`,
            data,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                }
            }
        );

        await query(
            `INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category, user_id, campaign_id, direction) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [formattedNumber, 'document', `File: ${fileName} | Caption: ${caption || ''}`, 'success', null, category, userId, campaignId, 'outbound']
        ).catch(e => console.error('[WhatsApp Log Error]', e.message));

        return { success: true, data: response.data };
    } catch (error: any) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error('Error sending WhatsApp document:', JSON.stringify(error.response?.data || error.message, null, 2));
        
        await query(
            `INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category, user_id, campaign_id, direction) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [number, 'document', `File: ${fileName}`, 'failed', errorMsg, category, userId, campaignId, 'outbound']
        ).catch(e => console.error('[WhatsApp Log Error]', e.message));

        return { 
            success: false, 
            error: errorMsg 
        };
    }
};

export const sendWhatsAppVideo = async (
    number: string, 
    videoUrl: string, 
    caption?: string, 
    category: string = 'agent_action',
    userId: string | null = null,
    campaignId: number | null = null
) => {
    const EVOLUTION_API_URL = await getConfig('EVOLUTION_API_URL');
    const EVOLUTION_API_KEY = await getConfig('EVOLUTION_API_KEY');
    const EVOLUTION_INSTANCE = await getConfig('EVOLUTION_INSTANCE');

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        console.error('Evolution API credentials missing for video');
        return { success: false, error: 'Configuração da API WhatsApp ausente' };
    }

    try {
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.startsWith('244') && formattedNumber.length === 9) {
            formattedNumber = '244' + formattedNumber;
        }

        const response = await axios.post(
            `${EVOLUTION_API_URL}/message/sendMedia/${EVOLUTION_INSTANCE}`,
            {
                number: formattedNumber,
                options: {
                    delay: 1200,
                    presence: "composing",
                    linkPreview: false
                },
                mediatype: "video",
                mimetype: "video/mp4",
                caption: caption || "",
                media: videoUrl
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                }
            }
        );

        await query(
            `INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category, user_id, campaign_id, direction) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [formattedNumber, 'video', `Video: ${videoUrl}`, 'success', null, category, userId, campaignId, 'outbound']
        ).catch(e => console.error('[WhatsApp Log Error]', e.message));

        return { success: true, data: response.data };
    } catch (error: any) {
        const errorMsg = error.response?.data?.message || error.message;
        console.error('Error sending WhatsApp video:', errorMsg);

        await query(
            `INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category, user_id, campaign_id, direction) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [number, 'video', `Video: ${videoUrl}`, 'failed', errorMsg, category, userId, campaignId, 'outbound']
        ).catch(e => console.error('[WhatsApp Log Error]', e.message));

        return { success: false, error: errorMsg };
    }
};

export const sendWhatsAppImage = async (
    number: string, 
    imageUrl: string, 
    caption?: string, 
    category: string = 'agent_action',
    userId: string | null = null,
    campaignId: number | null = null
) => {
    const EVOLUTION_API_URL = await getConfig('EVOLUTION_API_URL');
    const EVOLUTION_API_KEY = await getConfig('EVOLUTION_API_KEY');
    const EVOLUTION_INSTANCE = await getConfig('EVOLUTION_INSTANCE');

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        return { success: false, error: 'Configuração da API WhatsApp ausente' };
    }

    try {
        let formattedNumber = number.replace(/\D/g, '');
        if (!formattedNumber.startsWith('244') && formattedNumber.length === 9) {
            formattedNumber = '244' + formattedNumber;
        }

        const response = await axios.post(
            `${EVOLUTION_API_URL}/message/sendMedia/${EVOLUTION_INSTANCE}`,
            {
                number: formattedNumber,
                options: {
                    delay: 1200,
                    presence: "composing",
                    linkPreview: false
                },
                mediatype: "image",
                mimetype: "image/jpeg",
                caption: caption || "",
                media: imageUrl
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': EVOLUTION_API_KEY
                }
            }
        );

        await query(
            `INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category, user_id, campaign_id, direction) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [formattedNumber, 'image', `Image: ${imageUrl}`, 'success', null, category, userId, campaignId, 'outbound']
        ).catch(e => console.error('[WhatsApp Log Error]', e.message));

        return { success: true, data: response.data };
    } catch (error: any) {
        const errorMsg = error.response?.data?.message || error.message;
        
        await query(
            `INSERT INTO whatsapp_logs (recipient, type, content, status, error_details, category, user_id, campaign_id, direction) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [number, 'image', `Image: ${imageUrl}`, 'failed', errorMsg, category, userId, campaignId, 'outbound']
        ).catch(e => console.error('[WhatsApp Log Error]', e.message));

        return { success: false, error: errorMsg };
    }
};

/**
 * Envia um relatório administrativo formatado seguindo o padrão Conversio Premium:
 * Objetivo -> Explicação -> Ação personalizada
 */
export const sendPremiumAdminReport = async (
    number: string,
    objective: string,
    explanation: string,
    action: string,
    severity: 'info' | 'warning' | 'critical' = 'info'
) => {
    const emojis = {
        info: '🔵 *INFO*',
        warning: '🟡 *ATENÇÃO*',
        critical: '🔴 *URGENTE*'
    };

    const text = `${emojis[severity]} [CONVERSIO AI]\n\n` +
                 `🎯 *OBJECTIVO:* ${objective}\n\n` +
                 `📝 *EXPLICAÇÃO:* ${explanation}\n\n` +
                 `⚡ *COMO AGIR:* ${action}`;

    return await sendWhatsAppMessage(number, text, 'system_alert');
};
