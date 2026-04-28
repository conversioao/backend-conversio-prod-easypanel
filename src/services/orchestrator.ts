import { query } from '../db.js';
import { sendWhatsAppMessage } from './whatsappService.js';

/**
 * Agente Orquestrador Central
 * Controla e coordena todos os agentes (Funil, Campanhas, Recuperação, Envios, Monitor)
 */

// ─── EXECUTOR DO AGENTE ENVIOS ────────────────────────────────────────────────

async function executeAgentEnvios(task: any): Promise<void> {
    const { task_type, payload } = task;
    
    // Buscar número de WhatsApp do utilizador
    let phone = payload.phone || payload.whatsapp;
    if (!phone && payload.userId) {
        const userRes = await query(`SELECT whatsapp FROM users WHERE id = $1`, [payload.userId]);
        phone = userRes.rows[0]?.whatsapp;
    }

    if (!phone) {
        throw new Error(`Nenhum número WhatsApp encontrado para userId: ${payload.userId}`);
    }

    const message = payload.message;
    if (!message) throw new Error('Payload sem campo "message"');

    const result = await sendWhatsAppMessage(phone, message, task_type);
    if (!result.success) {
        throw new Error(`WhatsApp send failed: ${result.error}`);
    }

    // Registo no CRM se houver userId
    if (payload.userId) {
        await query(`
            INSERT INTO crm_interactions (user_id, type, content)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
        `, [payload.userId, task_type, message.substring(0, 200)]).catch(() => {});
    }

    console.log(`[Agente Envios] ✅ WhatsApp enviado para ${phone} (tipo: ${task_type})`);
}

// ─── EXECUTOR DO AGENTE FUNIL ─────────────────────────────────────────────────

async function executeAgentFunil(task: any): Promise<any> {
    const { runFunnelAgent, executeTask } = await import('./funnelAgent.js');
    if (task && task.task_type) {
        return await executeTask(task);
    }
    await runFunnelAgent();
}


// ─── EXECUTOR DO AGENTE CAMPANHAS ─────────────────────────────────────────────

async function executeAgentCampanhas(task: any): Promise<void> {
    const { runCampaignsAgent } = await import('./campaignsAgent.js');
    await runCampaignsAgent();
}


// ─── EXECUTOR DO AGENTE RECUPERAÇÃO ──────────────────────────────────────────

async function executeAgentRecuperacao(task: any): Promise<void> {
    const { runRecoveryAgent } = await import('./recoveryAgent.js');
    await runRecoveryAgent();
}

// ─── EXECUTOR DO AGENTE SMART / ORQUESTRADOR IA ─────────────────────────────

async function executeAgentSmart(task: any): Promise<void> {
    const { task_type, payload } = task;
    const { runSmartOrchestrator, executeApprovedPlans, analyzeSystem } = await import('./smartOrchestrator.js');

    console.log(`[Agente Smart] 🧠 Processando instrução: ${task_type}`);

    switch (task_type) {
        case 'generate_plan':
        case 'run_analysis':
            await runSmartOrchestrator();
            break;
        case 'execute_approved':
            await executeApprovedPlans();
            break;
        case 'full_analysis':
            await analyzeSystem();
            break;
        case 'auto_nurture':
            // Lógica para Criar Campanha de Nutrição Automática
            const { createCampaign } = await import('./campaignsAgent.js');
            await createCampaign({
                name: 'Nutrição Automática (Smart)',
                type: 'nurture',
                target_segment: payload.target || 'cold_leads',
                message: 'Olá! Notamos o seu interesse anterior. Temos novas soluções de IA prontas para si. Deseja ver como o Conversio AI evoluiu?',
                status: 'active'
            });
            break;
        default:
            // Fallback: tentar rodar a análise básica se for um comando desconhecido
            await runSmartOrchestrator();
    }
}

// ─── DISPATCHER CENTRAL ───────────────────────────────────────────────────────

async function dispatchTask(task: any): Promise<void> {
    const agentName = (task.agent_name || '').toLowerCase();
    const taskType = task.task_type;

    // Agente Envios — trata todos os tipos de mensagens
    if (agentName.includes('envios') || 
        ['send_message', 'send_recovery_msg', 'send_campaign_msg', 'send_onboarding', 'recovery_message'].includes(taskType)) {
        return executeAgentEnvios(task);
    }

    // Agente Funil
    if (agentName.includes('funil') || agentName.includes('funnel')) {
        return executeAgentFunil(task);
    }

    // Agente Campanhas
    if (agentName.includes('campanha')) {
        return executeAgentCampanhas(task);
    }

    // Agente Recuperação
    if (agentName.includes('recupera')) {
        return executeAgentRecuperacao(task);
    }

    // Agente Smart / Orquestrador IA
    if (agentName === 'smart' || agentName.includes('orquestrador') || agentName.includes('ia')) {
        return executeAgentSmart(task);
    }

    // Agente Pós-Venda
    if (agentName.includes('venda') || agentName.includes('post_sale') || agentName.includes('upsell')) {
        const { runPostSaleAgent } = await import('./postSaleAgent.js');
        return runPostSaleAgent();
    }

    console.log(`[ORCHESTRATOR] Nenhum executor para agente: "${task.agent_name}" / tipo: "${taskType}"`);
}

// ─── LOOP PRINCIPAL DO ORQUESTRADOR ──────────────────────────────────────────

export const runOrchestrator = async () => {
    console.log('[ORCHESTRATOR] Iniciando rotina de distribuição de tarefas...');

    try {
        // 1. Obter todos os agentes ativos
        const activeAgentsRes = await query(`SELECT name, config FROM agents WHERE status = 'active'`);
        if (activeAgentsRes.rowCount === 0) {
            // Não bloqueia — pode não ter tabela "agents" em todos os ambientes
            console.log('[ORCHESTRATOR] Nenhum agente registado em BD — a processar fila de tasks diretamente.');
        }

        const activeAgents = activeAgentsRes.rows.map(r => r.name);

        // 2. Tarefas pendentes — sem filtro de agentes se não houver nenhum registado
        const whereClause = activeAgents.length > 0
            ? `WHERE status = 'pending' AND agent_name = ANY($1) ORDER BY priority ASC, created_at ASC LIMIT 30`
            : `WHERE status = 'pending' ORDER BY priority ASC, created_at ASC LIMIT 30`;

        const pendingTasksRes = activeAgents.length > 0
            ? await query(`SELECT id, agent_name, task_type, priority, payload, attempts FROM agent_tasks ${whereClause}`, [activeAgents])
            : await query(`SELECT id, agent_name, task_type, priority, payload, attempts FROM agent_tasks ${whereClause}`);

        if (!pendingTasksRes.rowCount || pendingTasksRes.rowCount === 0) {
            console.log('[ORCHESTRATOR] Fila de tarefas vazia. Descansando até próximo ciclo.');
            return;
        }

        const tasks = pendingTasksRes.rows;
        console.log(`[ORCHESTRATOR] ${tasks.length} tarefa(s) na fila. A distribuir...`);

        // 3. Anti-colisão: mesmo utilizador não é processado duas vezes no mesmo ciclo
        const processedUsers = new Set<string>();
        const failedAgents = new Set<string>();

        for (const task of tasks) {
            const { id, agent_name, payload, attempts, task_type } = task;
            const parsedPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
            const userId = parsedPayload?.userId;

            // Anti-colisão por utilizador
            if (userId && processedUsers.has(userId)) {
                console.log(`[ORCHESTRATOR] Skip: user ${userId} já processado nesta janela.`);
                continue;
            }
            if (failedAgents.has(agent_name)) continue;
            if (userId) processedUsers.add(userId);

            // Marcar como running
            await query(`UPDATE agent_tasks SET status = 'running' WHERE id = $1`, [id]);
            await query(`UPDATE agents SET last_run = now() WHERE name = $1`, [agent_name]).catch(() => {});

            try {
                console.log(`[ORCHESTRATOR] ▶ [${agent_name}] → ${task_type}`);

                await dispatchTask({ ...task, payload: parsedPayload });

                // Concluída com sucesso
                await query(`UPDATE agent_tasks SET status = 'done', executed_at = now() WHERE id = $1`, [id]);
                await query(`
                    INSERT INTO agent_logs (agent_name, action, result, metadata)
                    VALUES ($1, $2, $3, $4)
                `, [agent_name, task_type, 'success', JSON.stringify({ taskId: id, userId: userId || null })]);

            } catch (error: any) {
                console.error(`[ORCHESTRATOR] ❌ Erro [${agent_name}] ${task_type}:`, error.message);

                const newAttempts = (attempts || 0) + 1;

                await query(`
                    INSERT INTO agent_logs (agent_name, action, result, metadata)
                    VALUES ($1, $2, $3, $4)
                `, [agent_name, task_type, 'error', JSON.stringify({ error: error.message, taskId: id, attempt: newAttempts, userId: userId || null })]);

                if (newAttempts >= 3) {
                    await query(`UPDATE agent_tasks SET status = 'failed', error_message = $1, attempts = $2 WHERE id = $3`, [error.message, newAttempts, id]);
                    await query(`UPDATE agents SET status = 'paused' WHERE name = $1`, [agent_name]).catch(() => {});
                    failedAgents.add(agent_name);
                    console.warn(`[ORCHESTRATOR] 🚨 [${agent_name}] pausado após 3 falhas.`);
                } else {
                    await query(`UPDATE agent_tasks SET status = 'pending', error_message = $1, attempts = $2 WHERE id = $3`, [error.message, newAttempts, id]);
                }
            }
        }

        console.log('[ORCHESTRATOR] Ciclo concluído. Próximo em 15min.');

    } catch (e) {
        console.error('[ORCHESTRATOR] Falha severa no orquestrador:', e);
    }
};

/**
 * Reset diário às 06:00 — reativa agentes pausados
 */
export const resumeAllAgents = async () => {
    try {
        console.log('[ORCHESTRATOR] Reset Diário: Retomando agentes pausados...');
        await query(`UPDATE agents SET status = 'active' WHERE status = 'paused'`).catch(() => {});
        await query(`UPDATE agent_tasks SET status = 'pending', attempts = 0 WHERE status = 'failed'`);
        console.log('[ORCHESTRATOR] Reset concluído.');
    } catch (e) {
        console.error('[ORCHESTRATOR] Erro no reset diário:', e);
    }
};

/**
 * Comando manual do Admin — executa agente específico agora
 */
export const runAgentByCommand = async (agentName: string, taskType: string, payload: any): Promise<string> => {
    try {
        const task = { id: 0, agent_name: agentName, task_type: taskType, priority: 1, payload, attempts: 0 };
        await dispatchTask(task);

        await query(`
            INSERT INTO agent_logs (agent_name, action, result, metadata)
            VALUES ($1, $2, $3, $4)
        `, [agentName, `MANUAL_CMD: ${taskType}`, 'success', JSON.stringify({ payload, source: 'admin' })]);

        return `✅ Agente "${agentName}" executou "${taskType}" com sucesso.`;
    } catch (e: any) {
        return `❌ Erro ao executar "${agentName}": ${e.message}`;
    }
};
