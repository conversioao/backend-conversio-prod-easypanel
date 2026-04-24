import { query } from '../db.js';
import { processWithOpenAI } from '../utils/openai.js';
import { sendPremiumAdminReport } from './whatsappService.js';
import { getAdminWhatsApp } from './configService.js';
import { createCampaign } from './campaignsAgent.js';
/**
 * Agente Orquestrador Inteligente — Conversio AI
 * Analisa o estado do sistema e propõe Planos de Ação ao Admin.
 * O Admin aprova ou rejeita cada plano antes da execução.
 */
// ─────────────────────────────────────────────────────────────
// ANÁLISE DO SISTEMA
// ─────────────────────────────────────────────────────────────
async function analyzeSystem() {
    const data = {};
    try {
        // 1. Leads por estágio e temperatura
        const leadsByStage = await query(`
            SELECT 
                stage, temperature, COUNT(*) as count,
                AVG(score) as avg_score
            FROM leads
            GROUP BY stage, temperature
            ORDER BY stage;
        `);
        data.leadsByStage = leadsByStage.rows;
        // 2. Leads inativos (sem next_action_date ou data passada há mais de 7 dias)
        const inactiveLeads = await query(`
            SELECT COUNT(*) as count
            FROM leads
            WHERE (next_action_date IS NULL OR next_action_date < now() - INTERVAL '7 days')
            AND temperature IN ('cold', 'warm');
        `);
        data.inactiveLeads = parseInt(inactiveLeads.rows[0].count);
        // 3. Campanhas ativas e seu desempenho
        const campaigns = await query(`
            SELECT status, COUNT(*) as count
            FROM crm_campaigns
            GROUP BY status;
        `).catch(() => ({ rows: [] }));
        data.campaigns = campaigns.rows;
        // 4. Taxa de churn risk
        const churnRisk = await query(`
            SELECT 
                COUNT(*) FILTER (WHERE churn_risk_score > 70) as high_risk,
                COUNT(*) FILTER (WHERE churn_risk_score > 40 AND churn_risk_score <= 70) as medium_risk,
                COUNT(*) as total
            FROM leads;
        `).catch(() => ({ rows: [{ high_risk: 0, medium_risk: 0, total: 0 }] }));
        data.churnRisk = churnRisk.rows[0];
        // 5. Utilizadores sem geração nos últimos 7 dias (candidatos a recovery)
        const dormantUsers = await query(`
            SELECT COUNT(DISTINCT u.id) as count
            FROM users u
            LEFT JOIN generations g ON g.user_id = u.id AND g.created_at > now() - INTERVAL '7 days'
            WHERE u.plan = 'free'
            AND g.id IS NULL
            AND u.created_at < now() - INTERVAL '3 days';
        `).catch(() => ({ rows: [{ count: 0 }] }));
        data.dormantUsers = parseInt(dormantUsers.rows[0].count);
        // 6. Últimas gerações — métricas de sucesso
        const genStats = await query(`
            SELECT 
                COUNT(*) FILTER (WHERE status = 'completed' AND created_at > now() - INTERVAL '24 hours') as success_24h,
                COUNT(*) FILTER (WHERE status = 'failed' AND created_at > now() - INTERVAL '24 hours') as failed_24h
            FROM generations;
        `).catch(() => ({ rows: [{ success_24h: 0, failed_24h: 0 }] }));
        data.genStats = genStats.rows[0];
        // 7. Follow-ups pendentes
        const pendingFollowups = await query(`
            SELECT COUNT(*) as count 
            FROM agent_tasks 
            WHERE task_type = 'send_message' AND status = 'pending';
        `).catch(() => ({ rows: [{ count: 0 }] }));
        data.pendingFollowups = parseInt(pendingFollowups.rows[0].count);
        // 8. Novos registos últimas 24h
        const newUsers = await query(`
            SELECT COUNT(*) as count FROM users WHERE created_at > now() - INTERVAL '24 hours';
        `);
        data.newUsers24h = parseInt(newUsers.rows[0].count);
        console.log('[SmartOrchestrator] Análise concluída:', JSON.stringify(data, null, 2));
        return data;
    }
    catch (e) {
        console.error('[SmartOrchestrator] Erro ao analisar sistema:', e);
        return null;
    }
}
// ─────────────────────────────────────────────────────────────
// GERAÇÃO DE PLANOS VIA GPT-4o-mini
// ─────────────────────────────────────────────────────────────
async function generateActionPlansWithAI(systemData) {
    const systemPrompt = `
Você é o Orquestrador Inteligente da plataforma Conversio AI Angola — uma plataforma de geração de conteúdo com IA para o mercado angolano.

Analise os dados do sistema e retorne um array JSON de planos de ação estratégicos.

ESTRUTURA DE CADA PLANO:
{
  "type": "campaign|nurture|followup|recovery|classification",
  "title": "Título curto e claro",
  "description": "Descrição de 2-3 frases explicando o quê, porquê e o impacto esperado",
  "priority": 1|2|3, // 1=Urgente, 2=Alta, 3=Normal
  "estimated_impact": "Descrição do impacto esperado (ex: ativar 50 leads inativos)",
  "target_segment": { "stage": "...", "temperature": "...", "days_inactive": ... },
  "proposed_actions": [
    { "action": "send_campaign", "message_template": "...", "schedule": "..." },
    { "action": "update_leads", "criteria": "..." }
  ]
}

REGRAS:
- Máximo 5 planos por análise
- Priorize urgência real (leads quentes, churn alto, inativos há muito)
- Mensagens devem ser em Português Angolano (pt-AO)
- Foco em resultados de vendas e retenção
- Retorne APENAS o array JSON, sem markdown
`;
    const userPrompt = `
DADOS DO SISTEMA AGORA:
- Leads por estágio: ${JSON.stringify(systemData.leadsByStage)}
- Leads inativos (+7 dias): ${systemData.inactiveLeads}
- Risco Churn: ${JSON.stringify(systemData.churnRisk)}
- Utilizadores dormentes (free, sem usar em 7 dias): ${systemData.dormantUsers}
- Novos utilizadores (24h): ${systemData.newUsers24h}
- Campanhas: ${JSON.stringify(systemData.campaigns)}
- Follow-ups pendentes: ${systemData.pendingFollowups}
- Gerações bem-sucedidas (24h): ${systemData.genStats?.success_24h || 0}
- Gerações falhadas (24h): ${systemData.genStats?.failed_24h || 0}

Com base nestes dados, gere os planos de ação mais estratégicos e urgentes para manter o funil de vendas saudável.
`;
    try {
        const { content: responseText } = await processWithOpenAI(systemPrompt, userPrompt, 'smartOrchestrator', 'gpt-4o-mini', 'json_object');
        const parsed = JSON.parse(responseText);
        // Handle both array and object with plans key
        const plans = Array.isArray(parsed) ? parsed : (parsed.plans || parsed.action_plans || []);
        console.log(`[SmartOrchestrator] AI gerou ${plans.length} planos de ação.`);
        return plans;
    }
    catch (e) {
        console.error('[SmartOrchestrator] Erro ao gerar planos via AI:', e.message);
        return generateHeuristicPlans(systemData);
    }
}
// ─────────────────────────────────────────────────────────────
// PLANOS HEURÍSTICOS (fallback sem AI)
// ─────────────────────────────────────────────────────────────
function generateHeuristicPlans(data) {
    const plans = [];
    // Leads inativos > 20 → campanha de nutrição
    if (data.inactiveLeads > 20) {
        plans.push({
            type: 'nurture',
            title: `Reactivar ${data.inactiveLeads} Leads Inactivos`,
            description: `Existem ${data.inactiveLeads} leads sem contacto há mais de 7 dias. Uma campanha de nutrição estratégica pode recuperar até 30% destes leads.`,
            priority: 2,
            estimated_impact: `Potencial de reativar ~${Math.round(data.inactiveLeads * 0.3)} leads`,
            target_segment: { days_inactive: 7, temperature: 'cold' },
            proposed_actions: [
                { action: 'send_campaign', message_template: 'Olá {nome}! Estamos com novidades incríveis na Conversio AI. Voltou a visitar-nos recentemente? Temos muito para partilhar consigo.', schedule: 'immediate' }
            ]
        });
    }
    // Alto risco de churn
    if (parseInt(data.churnRisk?.high_risk || 0) > 5) {
        plans.push({
            type: 'recovery',
            title: `Recuperar ${data.churnRisk.high_risk} Utilizadores em Risco`,
            description: `${data.churnRisk.high_risk} utilizadores apresentam risco de churn alto (>70%). Sequência de recuperação urgente recomendada.`,
            priority: 1,
            estimated_impact: `Recuperação potencial de ${Math.round(parseInt(data.churnRisk.high_risk) * 0.4)} utilizadores`,
            target_segment: { churn_risk_min: 70 },
            proposed_actions: [
                { action: 'send_recovery_sequence', message_template: 'Olá {nome}, notamos a sua ausência e queremos ajudar. Descobriu algum desafio com a plataforma? Fale connosco.', urgency: 'high' }
            ]
        });
    }
    // Utilizadores dormentes
    if (data.dormantUsers > 10) {
        plans.push({
            type: 'campaign',
            title: `Campanha para ${data.dormantUsers} Utilizadores Dormentes`,
            description: `${data.dormantUsers} utilizadores no plano gratuito ainda não utilizaram a plataforma nos últimos 7 dias. Guia de início rápido e oferta exclusiva podem converter.`,
            priority: 2,
            estimated_impact: `Potencial de ativação de ~${Math.round(data.dormantUsers * 0.25)} utilizadores`,
            target_segment: { plan: 'free', days_inactive: 7 },
            proposed_actions: [
                { action: 'send_onboarding', message_template: 'Olá {nome}! A sua conta Conversio AI está pronta mas ainda não explorou tudo. Veja como criar o seu primeiro anúncio em menos de 2 minutos.', schedule: 'morning' }
            ]
        });
    }
    // Follow-up classification
    plans.push({
        type: 'classification',
        title: 'Recalcular Temperatura de Todos os Leads',
        description: 'Recálculo automático de scores e classificação de temperatura (cold/warm/hot) para garantir segmentação precisa das campanhas.',
        priority: 3,
        estimated_impact: 'Melhoria na precisão de segmentação em 100% dos leads',
        target_segment: { all: true },
        proposed_actions: [
            { action: 'recalculate_scores', scope: 'all_leads' }
        ]
    });
    return plans;
}
// ─────────────────────────────────────────────────────────────
// GUARDAR PLANOS NA BD
// ─────────────────────────────────────────────────────────────
async function savePlans(plans) {
    let saved = 0;
    for (const plan of plans) {
        try {
            // Evitar duplicados: não criar se já existe plano com mesmo título em pending_approval
            const existing = await query(`
                SELECT id FROM orchestrator_action_plans 
                WHERE title = $1 AND status = 'pending_approval'
                AND suggested_at > now() - INTERVAL '24 hours'
            `, [plan.title]);
            if (existing.rowCount > 0) {
                console.log(`[SmartOrchestrator] Plano "${plan.title}" já existe. Ignorado.`);
                continue;
            }
            await query(`
                INSERT INTO orchestrator_action_plans 
                    (type, title, description, priority, target_segment, proposed_actions, estimated_impact)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                plan.type,
                plan.title,
                plan.description,
                plan.priority || 3,
                JSON.stringify(plan.target_segment || {}),
                JSON.stringify(plan.proposed_actions || []),
                plan.estimated_impact || ''
            ]);
            saved++;
        }
        catch (e) {
            console.error('[SmartOrchestrator] Erro ao guardar plano:', e);
        }
    }
    return saved;
}
// ─────────────────────────────────────────────────────────────
// NOTIFICAR ADMIN VIA WHATSAPP
// ─────────────────────────────────────────────────────────────
async function notifyAdminNewPlans(count, plans) {
    try {
        const adminPhone = await getAdminWhatsApp();
        if (!adminPhone)
            return;
        const urgentCount = plans.filter(p => p.priority === 1).length;
        const summary = plans.slice(0, 3).map((p, i) => `${i + 1}. [${p.priority === 1 ? '🔴 URGENTE' : p.priority === 2 ? '🟡 ALTA' : '🟢 NORMAL'}] ${p.title}`).join('\n');
        const message = `🤖 *ORQUESTRADOR CONVERSIO AI*\n\n` +
            `📋 *${count} novo(s) Plano(s) de Ação gerado(s)*\n` +
            (urgentCount > 0 ? `⚠️ *${urgentCount} plano(s) URGENTE(s)*\n\n` : '\n') +
            `*Resumo dos planos:*\n${summary}\n\n` +
            `👉 *Aceda ao Painel > Orquestrador > Planos de Ação* para aprovar ou recusar cada plano antes da execução.\n\n` +
            `_Nenhuma ação é executada sem a sua aprovação._`;
        await sendPremiumAdminReport(adminPhone, 'APROVAR PLANOS DE ACÇÃO', `🤖 O Orquestrador gerou ${count} novos planos de ação.`, 'Aceda ao Painel Admin > Orquestrador > Planos de Ação para aprovar.', urgentCount > 0 ? 'warning' : 'info');
    }
    catch (e) {
        console.error('[SmartOrchestrator] Erro ao notificar admin:', e);
    }
}
// ─────────────────────────────────────────────────────────────
// EXECUÇÃO DE PLANOS APROVADOS
// ─────────────────────────────────────────────────────────────
export async function executeApprovedPlans() {
    console.log('[SmartOrchestrator] Verificando planos aprovados para execução...');
    try {
        const approvedPlans = await query(`
            SELECT * FROM orchestrator_action_plans
            WHERE status = 'approved'
            ORDER BY priority ASC, approved_at ASC
            LIMIT 5
        `);
        for (const plan of approvedPlans.rows) {
            await query(`
                UPDATE orchestrator_action_plans SET status = 'executing' WHERE id = $1
            `, [plan.id]);
            console.log(`[SmartOrchestrator] Executando plano: ${plan.title} (${plan.type})`);
            let report = '';
            let success = true;
            try {
                const actions = plan.proposed_actions || [];
                for (const action of actions) {
                    report += await executeAction(action, plan);
                }
                // Log de execução
                await query(`
                    INSERT INTO agent_logs (agent_name, action, result, metadata)
                    VALUES ($1, $2, $3, $4)
                `, ['Orquestrador Inteligente', `PLAN_EXECUTED: ${plan.title}`, 'success', JSON.stringify({ planId: plan.id, type: plan.type })]);
            }
            catch (e) {
                success = false;
                report = `❌ Erro na execução: ${e.message}`;
                console.error(`[SmartOrchestrator] Erro ao executar plano ${plan.id}:`, e);
            }
            // Atualizar status e relatório
            await query(`
                UPDATE orchestrator_action_plans 
                SET status = $1, executed_at = now(), execution_report = $2
                WHERE id = $3
            `, [success ? 'completed' : 'failed', report || 'Execução concluída sem erros.', plan.id]);
            // Notificar admin com relatório
            await notifyAdminExecutionReport(plan, report, success);
        }
    }
    catch (e) {
        console.error('[SmartOrchestrator] Erro ao executar planos:', e);
    }
}
// ─────────────────────────────────────────────────────────────
// EXECUTOR DE AÇÕES INDIVIDUAIS
// ─────────────────────────────────────────────────────────────
async function executeAction(action, plan) {
    const actionType = action.action;
    switch (actionType) {
        case 'send_campaign': {
            // Cria uma campanha oficial usando o motor do AgenteCampanhas
            const segment = plan.target_segment || {};
            const campaignId = await createCampaign({
                name: plan.title,
                type: 'orchestrator_auto',
                target_segment: segment,
                message_template: action.message_template || 'Mensagem automática gerada pelo Orquestrador.',
                created_by: 'smart_orchestrator'
            });
            return `✅ Campanha "${plan.title}" criada e activada (ID: ${campaignId}). Destinatários gerados.\n`;
        }
        case 'recalculate_scores': {
            // Aciona o recálculo de leads via funnelAgent
            const funnelAgent = await import('./funnelAgent.js');
            await funnelAgent.recalculateAllActiveLeads();
            return `✅ Recálculo de scores de todos os leads concluído.\n`;
        }
        case 'send_recovery_sequence': {
            // Cria tarefas de recuperação para leads em risco
            const churnThreshold = plan.target_segment?.churn_risk_min || 70;
            const leads = await query(`
                SELECT id, user_id FROM leads WHERE churn_risk_score >= $1
            `, [churnThreshold]).catch(() => ({ rows: [] }));
            let created = 0;
            for (const lead of leads.rows) {
                await query(`
                    INSERT INTO agent_tasks (agent_name, task_type, priority, payload)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT DO NOTHING
                `, ['Agente Recuperação', 'recovery_message', 1, JSON.stringify({
                        userId: lead.user_id,
                        leadId: lead.id,
                        message: action.message_template,
                        source: 'orchestrator_plan',
                        planId: plan.id
                    })]);
                created++;
            }
            return `✅ ${created} tarefas de recuperação criadas para o Agente Recuperação.\n`;
        }
        case 'send_onboarding': {
            // Campanha de onboarding para utilizadores dormentes
            const dormant = await query(`
                SELECT DISTINCT u.id FROM users u
                LEFT JOIN generations g ON g.user_id = u.id AND g.created_at > now() - INTERVAL '7 days'
                WHERE u.plan = 'free' AND g.id IS NULL
                AND u.created_at < now() - INTERVAL '3 days'
                LIMIT 100
            `).catch(() => ({ rows: [] }));
            let queued = 0;
            for (const user of dormant.rows) {
                await query(`
                    INSERT INTO agent_tasks (agent_name, task_type, priority, payload)
                    VALUES ($1, $2, $3, $4)
                `, ['Agente Envios', 'send_message', 2, JSON.stringify({
                        userId: user.id,
                        type: 'onboarding_reengagement',
                        message: action.message_template,
                        source: 'orchestrator_plan'
                    })]);
                queued++;
            }
            return `✅ ${queued} mensagens de onboarding enfileiradas para o Agente Envios.\n`;
        }
        default:
            return `ℹ️ Ação "${actionType}" registada (sem executor definido).\n`;
    }
}
// ─────────────────────────────────────────────────────────────
// RELATÓRIO DE EXECUÇÃO PARA ADMIN
// ─────────────────────────────────────────────────────────────
async function notifyAdminExecutionReport(plan, report, success) {
    try {
        const adminPhone = await getAdminWhatsApp();
        if (!adminPhone)
            return;
        const message = `${success ? '✅' : '❌'} *ORQUESTRADOR — RELATÓRIO DE EXECUÇÃO*\n\n` +
            `📋 *Plano:* ${plan.title}\n` +
            `📌 *Tipo:* ${plan.type}\n` +
            `${success ? '🟢 *Estado: CONCLUÍDO*' : '🔴 *Estado: FALHOU*'}\n\n` +
            `*Relatório:*\n${report}\n\n` +
            `_O plano foi executado automaticamente após a sua aprovação._`;
        await sendPremiumAdminReport(adminPhone, success ? 'PLANO EXECUTADO' : 'FALHA NA EXECUÇÃO', `Plano: ${plan.title}`, success ? 'Verifique os resultados no painel CRM.' : 'Aceda ao painel para verificar o erro.', success ? 'info' : 'critical');
    }
    catch (e) {
        console.error('[SmartOrchestrator] Erro ao enviar relatório de execução:', e);
    }
}
// ─────────────────────────────────────────────────────────────
// LOOP PRINCIPAL — chamado pelo cron
// ─────────────────────────────────────────────────────────────
export const runSmartOrchestrator = async () => {
    console.log('[SmartOrchestrator] 🧠 Iniciando análise inteligente do sistema...');
    try {
        // 1. Executar planos já aprovados pelo Admin
        await executeApprovedPlans();
        // 2. Analisar o sistema
        const systemData = await analyzeSystem();
        if (!systemData)
            return;
        // 3. Gerar novos planos de ação
        const plans = await generateActionPlansWithAI(systemData);
        if (!plans || plans.length === 0) {
            console.log('[SmartOrchestrator] Nenhum plano novo gerado neste ciclo.');
            return;
        }
        // 4. Salvar planos na BD (sem duplicados)
        const savedCount = await savePlans(plans);
        if (savedCount > 0) {
            // 5. Notificar Admin via WhatsApp
            await notifyAdminNewPlans(savedCount, plans);
            console.log(`[SmartOrchestrator] ✅ ${savedCount} planos de ação guardados e admin notificado.`);
        }
        else {
            console.log('[SmartOrchestrator] Todos os planos gerados já existem. Nenhum novo guardado.');
        }
    }
    catch (e) {
        console.error('[SmartOrchestrator] Falha geral no orquestrador inteligente:', e);
    }
};
