import { query } from '../db.js';
import { sendWhatsAppMessage, sendPremiumAdminReport } from './whatsappService.js';
import { getAdminWhatsApp } from './configService.js';

/**
 * Agente Monitor — Vigilância 24h e Alertas Críticos
 */

export const runMonitorAgent = async () => {
    console.log('[Agente Monitor] Iniciando auditoria de saúde do sistema...');

    try {
        // 0. Garantir Schema de Orçamentos (Migração In-place)
        await ensureBudgetSchema();

        // 1. Coleta e Registo de Métricas Atuais
        const metrics = await collectAllMetrics();

        // 2. Avaliação de Regras de Alerta (Automático via Base de Dados)
        await evaluateAlertRules(metrics);

        // 3. Verificações Específicas
        await checkAgentsHealth();
        await checkStuckTasks();
        await checkGenerationFailures();
        await checkBudgetThresholds();
        await checkApiInstability();
        await checkInfraExpirations();

    } catch (e) {
        console.error('[Agente Monitor] Erro na auditoria:', e);
    }
};

/**
 * Coleta snapshot de métricas de diversas fontes
 */
async function collectAllMetrics() {
    const metrics: any = {};
    try {
        // a) Registos (24h)
    const signups = await query(`SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours'`);
    metrics['daily_signups'] = parseInt(signups.rows[0].count);

    // b) Erros de Agentes (Última hora)
    const agentErrors = await query(`
        SELECT COUNT(*) as errors, agent_name 
        FROM agent_logs 
        WHERE result = 'error' AND created_at > NOW() - INTERVAL '1 hour'
        GROUP BY agent_name
    `);
    // Fazemos uma média ou pegamos o máximo para a regra genérica
    metrics['agent_error_rate'] = agentErrors.rows.length > 0 ? (agentErrors.rows[0].errors * 10) : 0; // Exemplo simplificado

    // c) WhatsApp Delivery (1h)
    const waStats = await query(`
        SELECT 
            COUNT(*) FILTER (WHERE status = 'failed') as failed,
            COUNT(*) as total
        FROM whatsapp_logs 
        WHERE created_at > NOW() - INTERVAL '1 hour'
    `);
    const totalWA = parseInt(waStats.rows[0].total);
    metrics['whatsapp_failure_rate'] = totalWA > 0 ? (parseInt(waStats.rows[0].failed) / totalWA) * 100 : 0;

    // d) Tarefas Estagnadas
    const stuck = await query(`
        SELECT COUNT(*) FROM agent_tasks 
        WHERE status IN ('pending', 'running') 
        AND created_at < NOW() - INTERVAL '30 minutes'
    `);
    metrics['stuck_tasks'] = parseInt(stuck.rows[0].count);
    // Guardar na tabela system_metrics
    try {
        for (const [name, val] of Object.entries(metrics)) {
            await query(`INSERT INTO system_metrics (metric_name, metric_value) VALUES ($1, $2)`, [name, val as number]);
        }
    } catch (e: any) {
        console.error('[Agente Monitor] Erro ao gravar métricas:', e.message);
    }
} catch (e: any) {
    console.error('[Agente Monitor] Erro ao recolher métricas:', e.message);
}

    return metrics;
}

/**
 * Avalia regras dinâmicas da tabela alert_rules
 */
async function evaluateAlertRules(metrics: any) {
    try {
        const rules = await query(`SELECT * FROM alert_rules WHERE is_active = true`);

    for (const rule of rules.rows) {
        const val = metrics[rule.metric_name];
        if (val === undefined) continue;

        let triggered = false;
        if (rule.condition === 'gt' && val > rule.threshold) triggered = true;
        if (rule.condition === 'lt' && val < rule.threshold) triggered = true;
        if (rule.condition === 'eq' && val == rule.threshold) triggered = true;

        if (triggered) {
            // Verificar Cooldown
            const cooldownPassed = !rule.last_triggered_at || 
                (new Date().getTime() - new Date(rule.last_triggered_at).getTime()) / 60000 >= rule.cooldown_minutes;

            if (cooldownPassed) {
                const message = rule.message_template.replace('{value}', val.toString());
                await triggerAlert(
                    rule.metric_name, 
                    rule.severity, 
                    `Alerta de Regra: ${rule.metric_name}`, 
                    message,
                    { value: val, ruleId: rule.id }
                );

                // Update last triggered
                await query(`UPDATE alert_rules SET last_triggered_at = now() WHERE id = $1`, [rule.id]);
            }
        }
    }
} catch (e: any) {
    console.error('[Agente Monitor] Erro ao avaliar regras de alerta:', e.message);
}
}

/**
 * Verifica se agentes pararam, mas apenas se houver trabalho pendente.
 * Se o agente estiver inativo mas a fila estiver vazia, ele está "descansando".
 */
async function checkAgentsHealth() {
    const agents = await query(`SELECT name, last_run, status FROM agents WHERE status = 'active'`);
    for (const agent of agents.rows) {
        // Se não corre há mais de 1 hora
        if (agent.last_run) {
            const diffMin = (new Date().getTime() - new Date(agent.last_run).getTime()) / 60000;
            
            if (diffMin > 60) {
                // VERIFICAÇÃO INTELIGENTE: Existe trabalho pendente para este agente?
                const pendingTasks = await query(
                    `SELECT COUNT(*) FROM agent_tasks WHERE agent_name = $1 AND status = 'pending'`,
                    [agent.name]
                );
                const taskCount = parseInt(pendingTasks.rows[0].count);

                if (taskCount > 0) {
                    await triggerAlert(
                        'agent_stopped', 
                        'critical', 
                        `Agente Travado: ${agent.name}`, 
                        `O ${agent.name} tem ${taskCount} tarefas pendentes mas não reporta actividade há ${Math.floor(diffMin)} minutos!`,
                        { agentName: agent.name, lastRun: agent.last_run, pendingTasks: taskCount }
                    );
                } else {
                    console.log(`[Agente Monitor] ${agent.name} está inativo há ${Math.floor(diffMin)}min, mas a fila está vazia. Descansando.`);
                }
            }
        }
    }
}

/**
 * Verifica tarefas estagnadas
 */
async function checkStuckTasks() {
    const res = await query(`
        SELECT COUNT(*), task_type 
        FROM agent_tasks 
        WHERE status = 'running' AND created_at < NOW() - INTERVAL '30 minutes'
        GROUP BY task_type
    `);
    
    if (res.rowCount > 0) {
        for (const row of res.rows) {
            await triggerAlert(
                'stuck_tasks',
                'critical',
                'Fila de Tarefas Estagnada',
                `A tarefa do tipo ${row.task_type} está presa em processamento há mais de 30 min.`,
                { type: row.task_type, count: row.count }
            );
        }
    }
}

/**
 * DISPARADOR CENTRAL DE ALERTAS
 * Pode ser chamado de qualquer lugar do sistema para alertas imediatos
 */
export async function triggerAlert(type: string, severity: string, title: string, description: string, metadata: any = {}) {
    try {
        // 1. Gravar na tabela alerts
        const alertRes = await query(`
            INSERT INTO alerts (type, severity, title, message, metadata)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
        `, [type, severity, title, description, JSON.stringify(metadata)]);

        const alertId = alertRes.rows[0].id;

        // 2. Se for CRITICAL ou WARNING, enviar WhatsApp imediato (se não estiver em cooldown global)
        if (severity === 'critical' || severity === 'warning') {
            await sendAdminAlert(severity, title, description);
        }

        // 3. Logar no agent_logs
        await query(`
            INSERT INTO agent_logs (agent_name, action, result, metadata)
            VALUES ($1, $2, $3, $4)
        `, ['Agente Monitor', 'ALERT_TRIGGERED', severity, JSON.stringify({ alertId, title, type })]);

        return alertId;

    } catch (e) {
        console.error('[Agente Monitor] Erro ao disparar alerta:', e);
    }
}

/**
 * Formatação e Envio WhatsApp
 */
export async function sendAdminAlert(severity: string, title: string, message: string) {
    const adminWhatsApp = await getAdminWhatsApp();
    
    if (!adminWhatsApp) {
        console.warn('[Agente Monitor] WhatsApp Admin não configurado. Alerta não enviado.');
        return;
    }

    let formattedMsg = "";
    if (severity === 'critical') {
        formattedMsg = `🔴 URGENTE [SISTEMA]\n*${title}*\n${message}\n\nAcção necessária: Verificar Painel Admin imediatamente.`;
    } else if (severity === 'warning') {
        formattedMsg = `🟡 ATENÇÃO [SISTEMA]\n*${title}*\n${message}`;
    } else {
        formattedMsg = `🔵 INFO [SISTEMA]\n*${title}*\n${message}`;
    }

    // Rate Limit: Não enviar mais de 10 por hora
    const lastHourAlerts = await query(`
        SELECT COUNT(*) FROM agent_logs 
        WHERE agent_name = 'Agente Monitor' 
        AND action = 'WHATSAPP_SENT' 
        AND created_at > NOW() - INTERVAL '1 hour'
    `);
    
    if (parseInt(lastHourAlerts.rows[0].count) >= 10) {
        console.log('[Agente Monitor] 🛑 Rate limit de WhatsApp atingido. Agrupando alertas...');
        return;
    }

    await sendWhatsAppMessage(adminWhatsApp, formattedMsg, 'system_alert');

    await query(`
        INSERT INTO agent_logs (agent_name, action, result, metadata)
        VALUES ($1, $2, $3, $4)
    `, ['Agente Monitor', 'WHATSAPP_SENT', 'success', JSON.stringify({ recipient: adminWhatsApp, severity })]);
}

/**
 * Resumo Diário 08:00 AM
 */
export async function sendDailySummary() {
    const adminWhatsApp = await getAdminWhatsApp();
    console.log('[Agente Monitor] Gerando resumo diário...');
    try {
        const last24h = await query(`
            SELECT severity, COUNT(*) as count 
            FROM alerts 
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY severity
        `);

        let summary = `📑 *RESUMO DIÁRIO CONVERSIO AI*\nPeríodo: Últimas 24h\n\n`;
        
        for (const row of last24h.rows) {
            const emoji = row.severity === 'critical' ? '🔴' : (row.severity === 'warning' ? '🟡' : '🔵');
            summary += `${emoji} ${row.severity.toUpperCase()}: ${row.count} incidentes\n`;
        }

        const signups = await query(`SELECT COUNT(*) FROM users WHERE created_at > NOW() - INTERVAL '24 hours'`);
        summary += `\n👤 Novos Registos: ${signups.rows[0].count}\n`;

        summary += `\nSaúde Geral: ✅ Operacional`;

        await sendWhatsAppMessage(adminWhatsApp, summary, 'system_alert');
    } catch (e) {
        console.error('[Agente Monitor] Erro ao gerar resumo diário:', e);
    }
}

/**
 * Monitora falhas na tabela de gerações e identifica gatilhos críticos (OpenAI, KIE.AI, Créditos)
 */
async function checkGenerationFailures() {
    try {
        const failedGens = await query(`
            SELECT id, user_id, type, metadata, created_at 
            FROM generations 
            WHERE status = 'failed' 
            AND created_at > NOW() - INTERVAL '30 minutes'
            AND (metadata->>'alerted')::boolean IS NOT TRUE
        `);

        for (const gen of failedGens.rows) {
            const errorMsg = (gen.metadata?.error || 'Erro desconhecido').toLowerCase();
            
            // Determinar se o erro é CRÍTICO (Infraestrutura/APIs externas)
            let severity = 'warning';
            let title = `Falha na Geração: ${gen.type.toUpperCase()}`;
            
            if (errorMsg.includes('openai') || errorMsg.includes('gpt-4')) {
                severity = 'critical';
                title = '🚨 ERRO CRÍTICO: OpenAI / GPT';
            } else if (errorMsg.includes('credits') || errorMsg.includes('saldo') || errorMsg.includes('balance')) {
                severity = 'critical';
                title = '💰 ERRO CRÍTICO: Saldo de API insuficiente';
            } else if (errorMsg.includes('kie.ai') || errorMsg.includes('engine') || errorMsg.includes('timeout')) {
                severity = 'critical';
                title = '⚙️ ERRO CRÍTICO: Motor de Geração / KIE.AI';
            }

            await triggerAlert(
                'generation_failed_detailed',
                severity,
                title,
                `ID: ${gen.id}\nErro: ${gen.metadata?.error}\nUser: ${gen.user_id}\nTipo: ${gen.type}`,
                { generationId: gen.id, error: gen.metadata?.error }
            );

            // Marcar como alertado
            await query(`
                UPDATE generations 
                SET metadata = metadata || '{"alerted": true}'::jsonb 
                WHERE id = $1
            `, [gen.id]);
        }
    } catch (e) {
        console.error('[Agente Monitor] Erro ao auditar gerações:', e);
    }
}

/**
 * Garante que os campos de orçamento inicial existem para cálculo de %
 */
async function ensureBudgetSchema() {
    await query(`
        ALTER TABLE service_budgets ADD COLUMN IF NOT EXISTS initial_budget_dollar NUMERIC(10,2) DEFAULT 100.00;
        ALTER TABLE service_budgets ADD COLUMN IF NOT EXISTS initial_budget_credits NUMERIC(15,2) DEFAULT 1000.00;
    `).catch(() => {});
}

/**
 * Verifica se o consumo atingiu 70% ou 80%
 */
async function checkBudgetThresholds() {
    const adminWhatsApp = await getAdminWhatsApp();
    if (!adminWhatsApp) return;

    try {
        const budgets = await query(`SELECT * FROM service_budgets`);
        
        for (const budget of budgets.rows) {
            let consumption = 0;
            let initial = 0;
            let current = 0;
            let unit = '';

            if (budget.service === 'openai') {
                initial = parseFloat(budget.initial_budget_dollar || 100);
                current = parseFloat(budget.dollar_balance || 0);
                consumption = ((initial - current) / initial) * 100;
                unit = '$';
            } else if (budget.service === 'kie') {
                initial = parseFloat(budget.initial_budget_credits || 1000);
                current = parseFloat(budget.credit_balance || 0);
                consumption = ((initial - current) / initial) * 100;
                unit = 'créditos';
            }

            // Verificar se deve alertar (70% ou 80%)
            const metadata = budget.metadata || {};
            const alertedLevels = metadata.alerted_levels || [];
            let levelToAlert = 0;

            if (consumption >= 80 && !alertedLevels.includes(80)) levelToAlert = 80;
            else if (consumption >= 70 && !alertedLevels.includes(70)) levelToAlert = 70;

            if (levelToAlert > 0) {
                const objective = `Alerta de Saldo ${levelToAlert}% Consumido`;
                const explanation = `O serviço *${budget.service.toUpperCase()}* atingiu ${consumption.toFixed(1)}% de consumo. Saldo atual: ${current.toFixed(2)} ${unit} (de um total de ${initial} ${unit}).`;
                const action = `Acede ao Centro de Custo no Painel Admin e recarrega o saldo para evitar interrupções no serviço.`;

                await sendPremiumAdminReport(adminWhatsApp, objective, explanation, action, levelToAlert >= 80 ? 'critical' : 'warning');

                // Marcar nível como alertado
                alertedLevels.push(levelToAlert);
                await query(
                    `UPDATE service_budgets SET metadata = metadata || $1 WHERE id = $2`,
                    [JSON.stringify({ alerted_levels: alertedLevels }), budget.id]
                );
            }
        }
    } catch (e: any) {
        console.error('[Agente Monitor] Erro ao verificar orçamentos:', e.message);
    }
}

/**
 * Detecta instabilidade nas APIs (baseado em falhas sequenciais ou chaves marcadas como 'failed')
 */
async function checkApiInstability() {
    const adminWhatsApp = await getAdminWhatsApp();
    if (!adminWhatsApp) return;

    try {
        // 1. Verificar chaves que falharam recentemente
        const failedKeys = await query(`
            SELECT provider, last_error, updated_at 
            FROM api_keys 
            WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '5 minutes'
        `);

        for (const key of failedKeys.rows) {
            const objective = `Instabilidade Detectada: API ${key.provider.toUpperCase()}`;
            const explanation = `Uma chave da API ${key.provider} foi marcada como FALHADA por erro técnico: "${key.last_error}".`;
            const action = `Verifica a validade das chaves no Painel "IA e Motores". Se o erro persistir, substitui a chave secreta.`;

            await sendPremiumAdminReport(adminWhatsApp, objective, explanation, action, 'critical');
        }

        // 2. Verificar densidade de erros em gerações
        const recentErrors = await query(`
            SELECT COUNT(*) FROM generations 
            WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '15 minutes'
        `);

        if (parseInt(recentErrors.rows[0].count) >= 5) {
            const objective = `Instabilidade Geral no Sistema de Geração`;
            const explanation = `Detectadas ${recentErrors.rows[0].count} falhas de geração nos últimos 15 minutos. Isto pode indicar instabilidade nas APIs externas ou no Generation Engine.`;
            const action = `Monitoriza os logs de processamento detalhados e verifica se há um erro comum afetando todos os utilizadores.`;

            await sendPremiumAdminReport(adminWhatsApp, objective, explanation, action, 'warning');
        }
    } catch (e: any) {
        console.error('[Agente Monitor] Erro ao verificar instabilidade:', e.message);
    }
}

/**
 * Verifica se as datas de expiração de infraestrutura (servidor, storage, domínio) estão próximas.
 * Alerta o admin 6 dias antes da expiração.
 */
async function checkInfraExpirations() {
    const adminWhatsApp = await getAdminWhatsApp();
    if (!adminWhatsApp) return;

    const infraKeys = [
        { key: 'infra_server_expiry', label: 'Servidor VPS (Contabo)' },
        { key: 'infra_storage_expiry', label: 'Object Storage (Contabo)' },
        { key: 'infra_domain_expiry', label: 'Domínio' },
    ];

    try {
        for (const item of infraKeys) {
            const result = await query(
                `SELECT value FROM system_settings WHERE key = $1`, [item.key]
            ).catch(() => ({ rows: [] }));

            const dateStr = result.rows[0]?.value;
            if (!dateStr) continue;

            const expiryDate = new Date(dateStr);
            const now = new Date();
            const daysLeft = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

            if (daysLeft <= 6) {
                // Check cooldown — don't alert more than once per day for the same item
                const cooldownKey = `infra_alert_${item.key}`;
                const lastAlert = await query(
                    `SELECT value FROM system_settings WHERE key = $1`, [cooldownKey]
                ).catch(() => ({ rows: [] }));
                const lastAlertDate = lastAlert.rows[0]?.value;
                const today = now.toISOString().split('T')[0];

                if (lastAlertDate === today) continue; // Already alerted today

                const severity = daysLeft <= 0 ? 'critical' : (daysLeft <= 3 ? 'critical' : 'warning');
                const expiredText = daysLeft <= 0 
                    ? `EXPIROU há ${Math.abs(daysLeft)} dia(s)!` 
                    : `expira em ${daysLeft} dia(s) (${expiryDate.toLocaleDateString('pt-AO')})`;

                await triggerAlert(
                    'infra_expiration',
                    severity,
                    `Infraestrutura a Expirar: ${item.label}`,
                    `O serviço ${item.label} ${expiredText}. Renove imediatamente para evitar interrupções no serviço.`,
                    { service: item.label, daysLeft, expiryDate: dateStr }
                );

                await sendPremiumAdminReport(
                    adminWhatsApp,
                    `ALERTA: ${item.label} ${daysLeft <= 0 ? 'EXPIRADO' : 'a expirar'}`,
                    `${item.label} ${expiredText}.`,
                    'Renove o serviço imediatamente no painel Contabo ou no registar do domínio.',
                    severity
                );

                // Mark as alerted today
                await query(
                    `INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
                    [cooldownKey, today]
                ).catch(() => {});

                console.log(`[Agente Monitor] 🚨 Alerta de expiração: ${item.label} — ${daysLeft} dias restantes`);
            }
        }
    } catch (e: any) {
        console.error('[Agente Monitor] Erro ao verificar infraestrutura:', e.message);
    }
}

