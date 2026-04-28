import { query } from '../db.js';
import { keyManager } from './KeyManager.js';
import { processWithOpenAI } from '../utils/openai.js';

/**
 * Agente de Campanhas — Motor de Marketing Automático
 */

export const runCampaignsAgent = async () => {
    // 1. Verificar Janela de Horário (8h - 22h Angola GMT+1)
    const now = new Date();
    // UTC+1
    const hours = now.getUTCHours() + 1;
    if (hours < 8 || hours >= 22) {
        console.log(`[Agente Campanhas] 😴 Fora da janela de envio (Atual: ${hours}h). Em repouso.`);
        return;
    }

    console.log('[Agente Campanhas] Iniciando motor de distribuição...');

    try {
        // 2. Localizar campanhas Ativas
        const activeCampaigns = await query(`
            SELECT id, name, type, target_segment, message, channels 
            FROM campaigns 
            WHERE status = 'active' 
            LIMIT 3 -- Regra: Máximo 3 campanhas activas em simultâneo
        `);

        if (activeCampaigns.rowCount === 0) {
            console.log('[Agente Campanhas] Nenhuma campanha ativa.');
            return;
        }

        for (const campaign of activeCampaigns.rows) {
            await processCampaignBatch(campaign);
        }

    } catch (e) {
        console.error('[Agente Campanhas] Erro no ciclo principal:', e);
    }
};

/**
 * Processa um lote de envio para uma campanha específica (Max 100/hora)
 */
async function processCampaignBatch(campaign: any) {
    const { id, name } = campaign;

    try {
        // 1. Verificar se o utilizador recebeu algo nas últimas 48h (Regra)
        // 2. Verificar se já não foi enviado para este utilizador nesta campanha
        // 3. Rate Limit: Pegar apenas utilizadores pendentes para esta campanha
        const pendingRecipients = await query(`
            SELECT cr.user_id, u.name, u.email, u.whatsapp, u.created_at
            FROM campaign_recipients cr
            JOIN users u ON cr.user_id = u.id
            WHERE cr.campaign_id = $1 
            AND cr.status = 'pending'
            AND NOT EXISTS (
                SELECT 1 FROM agent_logs al 
                WHERE al.user_id = cr.user_id 
                AND al.created_at > NOW() - INTERVAL '48 hours'
            )
            LIMIT 100 -- Rate Limit: Máximo 100 por hora
        `, [id]);

        if (pendingRecipients.rowCount === 0) {
            // Se não há mais ninguém, marcar campanha como completa
            const totalPending = await query(`SELECT COUNT(*) FROM campaign_recipients WHERE campaign_id = $1 AND status = 'pending'`, [id]);
            if (parseInt(totalPending.rows[0].count) === 0) {
                await query(`UPDATE campaigns SET status = 'completed', completed_at = now() WHERE id = $1`, [id]);
                console.log(`[Agente Campanhas] ✅ Campanha [${name}] finalizada.`);
            }
            return;
        }

        console.log(`[Agente Campanhas] Processando lote de ${pendingRecipients.rowCount} envios para [${name}]`);

        let queuedCount = 0;
        for (const user of pendingRecipients.rows) {
            const targetSegment = typeof campaign.target_segment === 'string' 
                ? JSON.parse(campaign.target_segment) 
                : (campaign.target_segment || {});
            
            // A/B Testing Split
            const useVariantB = queuedCount % 2 === 1;
            let message = '';

            if (useVariantB && targetSegment.variant_b) {
                message = targetSegment.variant_b.replace(/{nome}/gi, user.name || 'Cliente');
            } else if (!useVariantB && targetSegment.variant_a) {
                message = targetSegment.variant_a.replace(/{nome}/gi, user.name || 'Cliente');
            } else {
                // Fallback to generic completion if no variants
                message = await generateCampaignContent(campaign, user);
            }

            // Delegar ao Agente Envios via Orquestrador
            const payload = {
                userId: user.user_id,
                message: message,
                campaignId: id,
                type: 'marketing_campaign',
                ab_variant: useVariantB ? 'B' : 'A'
            };
            queuedCount++;

            await query(`
                INSERT INTO agent_tasks (agent_name, task_type, priority, payload)
                VALUES ($1, $2, $3, $4)
            `, ['Agente Envios', 'send_campaign_msg', 2, JSON.stringify(payload)]);

            // Atualizar status do destinatário
            await query(`
                UPDATE campaign_recipients 
                SET status = 'sent', sent_at = now() 
                WHERE campaign_id = $1 AND user_id = $2
            `, [id, user.user_id]);

            // Log de Acção
            await query(`
                INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
                VALUES ($1, $2, $3, $4, $5)
            `, ['Agente Campanhas', 'SENT_TO_ENVIOS', user.user_id, 'success', JSON.stringify({ campaignId: id, name })]);
        }

        // Atualizar estatísticas da campanha
        await trackCampaignPerformance(id);

    } catch (e) {
        console.error(`[Agente Campanhas] Erro ao processar lote da campanha ${id}:`, e);
    }
}

/**
 * IA Content Engine: Prompt Mestre
 */
async function generateCampaignContent(campaign: any, user: any) {
    try {
        const daysSinceSignup = Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24));
        const recentActivity = "Ativo na plataforma.";
        
        const prompt = `Copywriter senior. Campanha: ${campaign.name}, Cliente: ${user.name}.`;

        const { content: reply } = await processWithOpenAI(
            "És um copywriter sénior especializado em conversão e retenção de SaaS.",
            prompt,
            'campaignsAgent',
            'gpt-4o-mini',
            'text'
        );

        return reply || `Olá ${user.name}! Temos novidades incríveis na Conversio AI para o teu plano. Descobre mais no nosso painel!`;

    } catch (e: any) {
        console.error('[Agente Campanhas] Erro IA Content:', e.message);
        return `Olá ${user.name}! Temos novidades incríveis na Conversio AI para o teu plano. Descobre mais no nosso painel!`;
    }
}


/**
 * Criação de Campanha e Segmentação
 */
export async function createCampaign(config: any) {
    const { name, type, target_segment, created_by } = config;
    const message = config.message || config.message_template || `Olá! Temos novidades incríveis na Conversio AI para si. Descubra mais no nosso painel!`;

    const campaign = await query(`
        INSERT INTO campaigns (name, type, target_segment, created_by, message, status)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
    `, [
        name || 'Campanha Automática', 
        type || 'orchestrator_auto', 
        JSON.stringify(target_segment || {}), 
        created_by || null, 
        message,
        config.status || 'active'
    ]);


    const campaignId = campaign.rows[0].id;

    // Criar estatística inicial vazia
    await query(`INSERT INTO campaign_stats (campaign_id) VALUES ($1)`, [campaignId]);

    // Build Audience (Segmentação Automática)
    const audience = await buildAudience(target_segment);
    
    for (const userId of audience) {
        await query(`
            INSERT INTO campaign_recipients (campaign_id, user_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        `, [campaignId, userId]);
    }

    return campaignId;
}

/**
 * Motor de Segmentação: Processa regras dinâmicas ou chaves pré-definidas
 */
export async function buildAudience(segmentRules: any) {
    const rules = typeof segmentRules === 'string' ? JSON.parse(segmentRules) : (segmentRules || {});
    const { segmentKey, scoreMin, temperature, plan, daysInactive, all } = rules;
    
    let usersQuery = "";
    let params: any[] = [];

    // Se "all" estiver presente, seleciona todos (com limite de segurança)
    if (all) {
        usersQuery = "SELECT id FROM users WHERE role = 'user' ORDER BY created_at DESC LIMIT 500";
    } 
    // Segmentos por Chave (Legacy/Simple)
    else if (segmentKey) {
        switch (segmentKey) {
            case 'new_users':
                usersQuery = "SELECT id FROM users WHERE created_at > NOW() - INTERVAL '7 days'";
                break;
            case 'active_users':
                usersQuery = "SELECT id FROM users WHERE last_login_at > NOW() - INTERVAL '3 days'";
                break;
            case 'churn_risk':
                usersQuery = "SELECT id FROM users WHERE (last_login_at < NOW() - INTERVAL '14 days' OR last_login_at IS NULL)";
                break;
            case 'ready_for_upgrade':
                usersQuery = "SELECT u.id FROM users u JOIN leads l ON u.id = l.user_id WHERE l.score > 70";
                break;
            case 'vip_customers':
                usersQuery = "SELECT id FROM users WHERE created_at < NOW() - INTERVAL '90 days'";
                break;
            default:
                usersQuery = "SELECT id FROM users WHERE role = 'user' LIMIT 50";
        }
    } 
    // Regras Dinâmicas (Complexas)
    else {
        let conditions = ["role = 'user'"];
        
        if (scoreMin) {
            conditions.push(`EXISTS (SELECT 1 FROM leads l WHERE l.user_id = users.id AND l.score >= $${params.length + 1})`);
            params.push(scoreMin);
        }
        
        if (temperature) {
            conditions.push(`EXISTS (SELECT 1 FROM leads l WHERE l.user_id = users.id AND l.temperature = $${params.length + 1})`);
            params.push(temperature);
        }
        
        if (plan) {
            conditions.push(`plan = $${params.length + 1}`);
            params.push(plan);
        }
        
        if (daysInactive) {
            conditions.push(`(last_login_at < NOW() - ($${params.length + 1} || ' days')::INTERVAL OR last_login_at IS NULL)`);
            params.push(daysInactive);
        }

        usersQuery = `SELECT id FROM users WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT 500`;
    }

    const res = await query(usersQuery, params);
    console.log(`[Agente Campanhas] Audiência segmentada: ${res.rowCount} utilizadores encontrados.`);
    return res.rows.map(r => r.id);
}

/**
 * Actualiza Stats em Tempo Real — agora com métricas reais do WhatsApp
 */
export async function trackCampaignPerformance(campaignId: number) {
    // 1. Métricas de recipients
    const recipientStats = await query(`
        SELECT 
            COUNT(*) FILTER (WHERE status = 'sent') as sent,
            COUNT(*) FILTER (WHERE status = 'converted') as converted,
            COUNT(*) as total_recipients
        FROM campaign_recipients 
        WHERE campaign_id = $1
    `, [campaignId]);

    const { sent, converted, total_recipients } = recipientStats.rows[0];

    // 2. Métricas reais de entrega via whatsapp_logs
    const waStats = await query(`
        SELECT 
            COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'success') as delivered,
            COUNT(*) FILTER (WHERE status = 'read') as read,
            COUNT(*) FILTER (WHERE direction = 'inbound') as replied,
            COUNT(*) FILTER (WHERE status = 'failed') as failed
        FROM whatsapp_logs 
        WHERE campaign_id = $1
    `, [campaignId]).catch(() => ({ rows: [{ delivered: 0, read: 0, replied: 0, failed: 0 }] }));

    const wa = waStats.rows[0];

    // 3. Actualizar campaign_stats com dados completos
    await query(`
        UPDATE campaign_stats 
        SET total_sent = $1, total_converted = $2, 
            total_delivered = $3, total_read = $4, 
            total_replied = $5, total_failed = $6,
            calculated_at = now()
        WHERE campaign_id = $7
    `, [
        parseInt(sent), parseInt(converted),
        parseInt(wa.delivered), parseInt(wa.read),
        parseInt(wa.replied), parseInt(wa.failed),
        campaignId
    ]).catch(async () => {
        // Fallback: columns may not exist yet, use basic update
        await query(`
            UPDATE campaign_stats 
            SET total_sent = $1, total_converted = $2, calculated_at = now()
            WHERE campaign_id = $3
        `, [parseInt(sent), parseInt(converted), campaignId]);
    });
}
