import { query } from '../db.js';
import { keyManager } from './KeyManager.js';
import { processWithOpenAI } from '../utils/openai.js';
import { sendPremiumAdminReport } from './whatsappService.js';
import { getAdminWhatsApp } from './configService.js';
import { createCampaign, buildAudience } from './campaignsAgent.js';


/**
 * Agente Orquestrador Inteligente — Conversio AI
 * Analisa o estado do sistema e propõe Planos de Ação ao Admin.
 * O Admin aprova ou rejeita cada plano antes da execução.
 */

// ─────────────────────────────────────────────────────────────
// ANÁLISE DO SISTEMA
// ─────────────────────────────────────────────────────────────

export async function analyzeSystem() {
    const data: any = {};

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
            FROM campaigns
            GROUP BY status;
        `).catch(() => ({ rows: [] }));
        data.campaigns = campaigns.rows;

        // 4. Taxa de churn risk
        const churnRisk = await query(`
            SELECT 
                COUNT(*) FILTER (WHERE (100 - COALESCE(score, 0)) > 70) as high_risk,
                COUNT(*) FILTER (WHERE (100 - COALESCE(score, 0)) > 40 AND (100 - COALESCE(score, 0)) <= 70) as medium_risk,
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

        // ═══════════════════════════════════════════════════════════
        // 9. FEEDBACK LOOP — Resultados de planos de ação passados
        // ═══════════════════════════════════════════════════════════
        const pastPlans = await query(`
            SELECT title, type, status, execution_report, 
                   executed_at, estimated_impact, priority
            FROM orchestrator_action_plans 
            WHERE status IN ('completed', 'failed')
            AND executed_at > now() - INTERVAL '7 days'
            ORDER BY executed_at DESC LIMIT 10
        `).catch(() => ({ rows: [] }));
        data.pastPlanResults = pastPlans.rows;

        // 10. Performance real das campanhas (delivery, reads, replies)
        const campaignPerformance = await query(`
            SELECT c.name, c.type, c.status, c.created_at,
                   COALESCE(cs.total_sent, 0) as total_sent,
                   COALESCE(cs.total_converted, 0) as total_converted,
                   COALESCE(wl.total_delivered, 0) as wa_delivered,
                   COALESCE(wl.total_read, 0) as wa_read,
                   COALESCE(wl.total_replied, 0) as wa_replied,
                   COALESCE(wl.total_failed, 0) as wa_failed
            FROM campaigns c
            LEFT JOIN campaign_stats cs ON cs.campaign_id = c.id
            LEFT JOIN LATERAL (
                SELECT 
                    COUNT(*) FILTER (WHERE status = 'success' AND direction = 'outbound') as total_delivered,
                    COUNT(*) FILTER (WHERE status = 'read') as total_read,
                    COUNT(*) FILTER (WHERE direction = 'inbound') as total_replied,
                    COUNT(*) FILTER (WHERE status = 'failed') as total_failed
                FROM whatsapp_logs WHERE campaign_id = c.id
            ) wl ON true
            WHERE c.created_at > now() - INTERVAL '30 days'
            ORDER BY c.created_at DESC LIMIT 10
        `).catch(() => ({ rows: [] }));
        data.campaignPerformance = campaignPerformance.rows;

        // 11. WhatsApp delivery stats globais (últimas 24h)
        const waGlobalStats = await query(`
            SELECT 
                COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'success') as sent_ok,
                COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'failed') as sent_fail,
                COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'read') as read,
                COUNT(*) FILTER (WHERE direction = 'inbound') as replies
            FROM whatsapp_logs
            WHERE created_at > now() - INTERVAL '24 hours'
        `).catch(() => ({ rows: [{ sent_ok: 0, sent_fail: 0, read: 0, replies: 0 }] }));
        data.whatsappStats24h = waGlobalStats.rows[0];

        // 12. SMART SCHEDULING — Melhores horas de resposta
        const bestHours = await query(`
            SELECT 
                EXTRACT(HOUR FROM created_at) as hour,
                COUNT(*) as reply_count
            FROM whatsapp_logs
            WHERE direction = 'inbound'
            AND created_at > now() - INTERVAL '30 days'
            GROUP BY EXTRACT(HOUR FROM created_at)
            ORDER BY reply_count DESC
            LIMIT 5
        `).catch(() => ({ rows: [] }));
        data.bestReplyHours = bestHours.rows;

        // 13. Post-sale: clientes que pagaram mas não usaram créditos
        const paidNotUsed = await query(`
            SELECT COUNT(DISTINCT t.user_id) as count
            FROM transactions t
            LEFT JOIN generations g ON g.user_id = t.user_id AND g.created_at > t.created_at
            WHERE t.status = 'completed'
            AND t.created_at > now() - INTERVAL '7 days'
            AND g.id IS NULL
        `).catch(() => ({ rows: [{ count: 0 }] }));
        data.paidNotUsed = parseInt(paidNotUsed.rows[0].count);

        // 14. Clientes com créditos baixos (<10% do que compraram)
        const lowCredits = await query(`
            SELECT COUNT(*) as count
            FROM users
            WHERE credits > 0 AND credits <= 5
            AND role = 'user'
        `).catch(() => ({ rows: [{ count: 0 }] }));
        data.lowCreditUsers = parseInt(lowCredits.rows[0].count);

        // 15. MEMÓRIA DO ORQUESTRADOR — carregar contexto dos últimos ciclos
        const memory = await query(`
            SELECT context_key, context_value, updated_at
            FROM orchestrator_memory
            ORDER BY updated_at DESC
            LIMIT 20
        `).catch(() => ({ rows: [] }));
        data.orchestratorMemory = memory.rows;

        console.log('[SmartOrchestrator] Análise concluída com feedback loop ✅');
        return data;

    } catch (e) {
        console.error('[SmartOrchestrator] Erro ao analisar sistema:', e);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
// GERAÇÃO DE PLANOS VIA GPT-4o-mini
// ─────────────────────────────────────────────────────────────

async function generateActionPlansWithAI(systemData: any): Promise<any[]> {
    // ═══ MEMORY: Resumo de aprendizados passados ═══
    const memoryContext = (systemData.orchestratorMemory || []).map((m: any) => `${m.context_key}: ${m.context_value}`).join('\n');
    const pastResultsContext = (systemData.pastPlanResults || []).map((p: any) => `[${p.status}] "${p.title}" (${p.type}) → ${(p.execution_report || '').substring(0, 120)}`).join('\n');
    const campaignContext = (systemData.campaignPerformance || []).map((c: any) => {
        const deliveryRate = c.wa_delivered > 0 ? Math.round((parseInt(c.wa_read || 0) / parseInt(c.wa_delivered)) * 100) : 0;
        const replyRate = c.wa_delivered > 0 ? Math.round((parseInt(c.wa_replied || 0) / parseInt(c.wa_delivered)) * 100) : 0;
        return `"${c.name}" (${c.type}): sent=${c.total_sent}, delivered=${c.wa_delivered}, read=${deliveryRate}%, replies=${replyRate}%`;
    }).join('\n');
    const bestHoursStr = (systemData.bestReplyHours || []).map((h: any) => `${h.hour}h → ${h.reply_count} respostas`).join(', ');

    const systemPrompt = `Role: Conversio AI SmartOrchestrator v2 (Angola SaaS) — Strategic Marketing Brain.
Task: Analyze ALL data including past results, learn from successes/failures, and return optimized strategic plans.
Important: "SACALA" is a common recipient name/placeholder, NOT the brand name. The platform is Conversio AI.

You are a LEARNING system. Before generating new plans:
1. Review PAST PLAN RESULTS — what worked? what failed? Do NOT repeat failed strategies.
2. Review CAMPAIGN PERFORMANCE — which messages got replies? which were ignored?
3. Use BEST REPLY HOURS to schedule campaigns optimally.
4. Consider POST-SALE opportunities (paid users not using credits, low-credit users).
5. Generate A/B VARIANTS when proposing campaigns: include "variant_a" and "variant_b" messages.
6. Include a "self_evaluation" field rating your confidence 1-10 and explaining your reasoning.

JSON Format: [{"type":"campaign|nurture|followup|recovery|classification|post_sale|upsell","title":"...","description":"...","priority":1|2|3,"estimated_impact":"...","confidence":8,"self_evaluation":"...","target_segment":{"scoreMin":70,"temperature":"warm","plan":"free","daysInactive":7},"best_send_hour":10,"proposed_actions":[{"action":"send_campaign|send_followup|send_recovery_sequence|send_onboarding|send_post_sale|send_upsell","variant_a":"...","variant_b":"...","message":"...","schedule":"morning|afternoon|evening|immediate"}]}]
Rules:
1. Max 5 plans. Tone: pt-AO professional.
2. Messages must be WhatsApp-ready: SHORT (max 180 chars), objective.
3. Use {nome} as placeholder for the customer's name.
4. "action" MUST BE ONE OF: send_campaign, send_followup, send_recovery_sequence, send_onboarding, send_post_sale, send_upsell.
5. "target_segment" CAN USE: scoreMin (number), temperature ("cold"|"warm"|"hot"), plan ("free"|"pro"), daysInactive (number), or segmentKey ("active_users"|"churn_risk"|etc).
6. NEVER repeat the exact same plan title as a recent one that failed.
7. Prioritize strategies that showed high reply rates in past campaigns.`;

    const userPrompt = `══ SYSTEM SNAPSHOT ══
- Stage/Temp: ${JSON.stringify(systemData.leadsByStage)}
- Inactive (>7d): ${systemData.inactiveLeads}
- Churn High/Med: ${systemData.churnRisk?.high_risk}/${systemData.churnRisk?.medium_risk} (Total: ${systemData.churnRisk?.total})
- Dormant (Free): ${systemData.dormantUsers}
- New (24h): ${systemData.newUsers24h}
- Gen Stats (24h): Success=${systemData.genStats?.success_24h}, Failed=${systemData.genStats?.failed_24h}
- Pending Followups: ${systemData.pendingFollowups}

══ POST-SALE OPPORTUNITIES ══
- Paid users who haven't used credits (7d): ${systemData.paidNotUsed || 0}
- Users with low credits (≤5): ${systemData.lowCreditUsers || 0}

══ WHATSAPP DELIVERY (24h) ══
- Sent OK: ${systemData.whatsappStats24h?.sent_ok || 0}
- Failed: ${systemData.whatsappStats24h?.sent_fail || 0}
- Read: ${systemData.whatsappStats24h?.read || 0}
- Replies: ${systemData.whatsappStats24h?.replies || 0}

══ BEST REPLY HOURS (last 30 days) ══
${bestHoursStr || 'No data yet'}

══ PAST PLAN RESULTS (last 7 days) ══
${pastResultsContext || 'No past plans yet — this is a fresh start.'}

══ CAMPAIGN PERFORMANCE (last 30 days) ══
${campaignContext || 'No campaign data yet.'}

══ ORCHESTRATOR MEMORY ══
${memoryContext || 'No memory entries yet.'}

Generate strategic plans that LEARN from these results. Explain WHY you chose each plan.`;

    try {
        const { content: responseText } = await processWithOpenAI(
            systemPrompt,
            userPrompt,
            'smartOrchestrator',
            'gpt-4o-mini',
            'json_object'
        );

        const parsed = JSON.parse(responseText);

        // Handle both array and object with plans key
        const plans = Array.isArray(parsed) ? parsed : (parsed.plans || parsed.action_plans || []);
        console.log(`[SmartOrchestrator] AI gerou ${plans.length} planos de ação (v2 com feedback loop).`);

        // ═══ SAVE MEMORY: Record what the AI decided and why ═══
        await saveMemory('last_cycle_plans_count', String(plans.length));
        await saveMemory('last_cycle_timestamp', new Date().toISOString());
        const topPlan = plans[0];
        if (topPlan) {
            await saveMemory('last_top_priority', `${topPlan.title} (confidence: ${topPlan.confidence || 'N/A'})`);
            if (topPlan.self_evaluation) {
                await saveMemory('last_self_evaluation', topPlan.self_evaluation.substring(0, 300));
            }
        }

        return plans;

    } catch (e: any) {
        console.error('[SmartOrchestrator] Erro ao gerar planos via AI:', e.message);
        return generateHeuristicPlans(systemData);
    }
}

// ─────────────────────────────────────────────────────────────
// PLANOS HEURÍSTICOS (fallback sem AI)
// ─────────────────────────────────────────────────────────────

function generateHeuristicPlans(data: any): any[] {
    const plans: any[] = [];

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

async function savePlans(plans: any[]) {
    let saved = 0;
    for (const plan of plans) {
        try {
            // Evitar duplicados: não criar se já existe plano com mesmo título em pending_approval
            const existing = await query(`
                SELECT id FROM orchestrator_action_plans 
                WHERE title = $1 AND status = 'pending_approval'
                AND suggested_at > now() - INTERVAL '24 hours'
            `, [plan.title]);

            if (existing.rowCount! > 0) {
                console.log(`[SmartOrchestrator] Plano "${plan.title}" já existe. Ignorado.`);
                continue;
            }

            // Quantificar Leads (Especificar alvos no plano)
            let audienceCount = 0;
            if (plan.target_segment) {
                try {
                    const audience = await buildAudience(plan.target_segment);
                    audienceCount = audience.length;
                } catch (e) {
                    console.error('[SmartOrchestrator] Erro ao calcular audiência para plano:', e);
                }
            }

            const finalDescription = audienceCount > 0 
                ? `${plan.description}\n\n🎯 *Segmentação:* ${audienceCount} leads identificados.` 
                : plan.description;

            await query(`
                INSERT INTO orchestrator_action_plans 
                    (type, title, description, priority, target_segment, proposed_actions, estimated_impact)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
                plan.type,
                plan.title,
                finalDescription,
                plan.priority || 3,
                JSON.stringify(plan.target_segment || {}),
                JSON.stringify(plan.proposed_actions || []),
                plan.estimated_impact || ''
            ]);
            saved++;
        } catch (e) {
            console.error('[SmartOrchestrator] Erro ao guardar plano:', e);
        }
    }
    return saved;
}

// ─────────────────────────────────────────────────────────────
// NOTIFICAR ADMIN VIA WHATSAPP
// ─────────────────────────────────────────────────────────────

async function notifyAdminNewPlans(count: number, plans: any[]) {
    try {
        const adminPhone = await getAdminWhatsApp();
        if (!adminPhone) return;

        const urgentCount = plans.filter(p => p.priority === 1).length;
        const summary = plans.slice(0, 3).map((p, i) => 
            `${i + 1}. [${p.priority === 1 ? '🔴 URGENTE' : p.priority === 2 ? '🟡 ALTA' : '🟢 NORMAL'}] ${p.title}`
        ).join('\n');

        const message = `🤖 *ORQUESTRADOR CONVERSIO AI*\n\n` +
            `📋 *${count} novo(s) Plano(s) de Ação gerado(s)*\n` +
            (urgentCount > 0 ? `⚠️ *${urgentCount} plano(s) URGENTE(s)*\n\n` : '\n') +
            `*Resumo dos planos:*\n${summary}\n\n` +
            `👉 *Aceda ao Painel > Orquestrador > Planos de Ação* para aprovar ou recusar cada plano antes da execução.\n\n` +
            `_Nenhuma ação é executada sem a sua aprovação._`;

        await sendPremiumAdminReport(
            adminPhone, 
            'APROVAR PLANOS DE ACÇÃO', 
            `🤖 O Orquestrador gerou ${count} novos planos de ação.`, 
            'Aceda ao Painel Admin > Orquestrador > Planos de Ação para aprovar.', 
            urgentCount > 0 ? 'warning' : 'info'
        );

    } catch (e) {
        console.error('[SmartOrchestrator] Erro ao notificar admin:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// RECUPERAÇÃO DE PLANOS BLOQUEADOS
// ─────────────────────────────────────────────────────────────

async function recoverStuckPlans() {
    try {
        const stuck = await query(`
            UPDATE orchestrator_action_plans 
            SET status = 'approved', execution_report = 'Auto-reset: plano bloqueado em executing > 10 min.'
            WHERE status = 'executing' 
            AND approved_at < now() - INTERVAL '10 minutes'
            RETURNING id, title
        `);
        if (stuck.rowCount && stuck.rowCount > 0) {
            console.log(`[SmartOrchestrator] ♻️ ${stuck.rowCount} plano(s) bloqueado(s) recuperado(s):`, stuck.rows.map((r: any) => r.title).join(', '));
        }
    } catch (e) {
        console.error('[SmartOrchestrator] Erro ao recuperar planos bloqueados:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// SAFE JSON PARSER — Garante que proposed_actions é sempre um Array
// ─────────────────────────────────────────────────────────────

function safeParseActions(raw: any): any[] {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : (parsed.actions || parsed.proposed_actions || []);
        } catch {
            console.error('[SmartOrchestrator] ⚠️ proposed_actions não é JSON válido:', raw);
            return [];
        }
    }
    // Se for um Object (pg retornou JSONB como object), tenta extrair array
    if (typeof raw === 'object' && raw.actions) return raw.actions;
    return [];
}

function safeParseSegment(raw: any): any {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return {}; }
    }
    return {};
}

// ─────────────────────────────────────────────────────────────
// EXECUÇÃO DE PLANOS APROVADOS
// ─────────────────────────────────────────────────────────────

export async function executeApprovedPlans() {
    console.log('[SmartOrchestrator] Verificando planos aprovados para execução...');

    try {
        // 1. Recuperar planos bloqueados antes de processar novos
        await recoverStuckPlans();

        // 2. Buscar planos aprovados
        const approvedPlans = await query(`
            SELECT * FROM orchestrator_action_plans
            WHERE status = 'approved'
            ORDER BY priority ASC, approved_at ASC
            LIMIT 5
        `);

        if (!approvedPlans.rows || approvedPlans.rows.length === 0) {
            console.log('[SmartOrchestrator] Nenhum plano aprovado na fila.');
            return;
        }

        console.log(`[SmartOrchestrator] 📋 ${approvedPlans.rows.length} plano(s) aprovado(s) a executar.`);

        for (const plan of approvedPlans.rows) {
            // Marcar como executing
            await query(`
                UPDATE orchestrator_action_plans SET status = 'executing' WHERE id = $1
            `, [plan.id]);

            console.log(`[SmartOrchestrator] ▶ Executando plano #${plan.id}: "${plan.title}" (tipo: ${plan.type})`);

            let report = '';
            let success = true;

            try {
                // SAFE PARSE: garantir que actions é sempre um array
                const actions = safeParseActions(plan.proposed_actions);
                const segment = safeParseSegment(plan.target_segment);

                console.log(`[SmartOrchestrator]   → ${actions.length} acção(ões) a executar`);

                if (actions.length === 0) {
                    // Se não tem ações explícitas, executar baseado no tipo do plano
                    report += await executeByPlanType(plan, segment);
                } else {
                    for (let i = 0; i < actions.length; i++) {
                        const action = actions[i];
                        console.log(`[SmartOrchestrator]   → Acção ${i + 1}/${actions.length}: "${action.action || action.type || 'unknown'}"`);
                        report += await executeAction(action, plan, segment);
                    }
                }

                // Log de execução
                await query(`
                    INSERT INTO agent_logs (agent_name, action, result, metadata)
                    VALUES ($1, $2, $3, $4)
                `, ['Orquestrador Inteligente', `PLAN_EXECUTED: ${plan.title}`, 'success', JSON.stringify({ planId: plan.id, type: plan.type, report: report.substring(0, 500) })]);

            } catch (e: any) {
                success = false;
                report = `❌ Erro na execução: ${e.message}\n${report}`;
                console.error(`[SmartOrchestrator] ❌ Erro ao executar plano #${plan.id}:`, e.message);

                // Log do erro
                await query(`
                    INSERT INTO agent_logs (agent_name, action, result, metadata)
                    VALUES ($1, $2, $3, $4)
                `, ['Orquestrador Inteligente', `PLAN_FAILED: ${plan.title}`, 'error', JSON.stringify({ planId: plan.id, error: e.message })]).catch(() => {});
            }

            // Atualizar status e relatório
            await query(`
                UPDATE orchestrator_action_plans 
                SET status = $1, executed_at = now(), execution_report = $2
                WHERE id = $3
            `, [success ? 'completed' : 'failed', report || 'Execução concluída sem erros.', plan.id]);

            console.log(`[SmartOrchestrator] ${success ? '✅' : '❌'} Plano #${plan.id} "${plan.title}" → ${success ? 'CONCLUÍDO' : 'FALHOU'}`);

            // Notificar admin com relatório
            await notifyAdminExecutionReport(plan, report, success);
        }
    } catch (e) {
        console.error('[SmartOrchestrator] Erro fatal ao executar planos:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// EXECUTOR POR TIPO DE PLANO (fallback quando não há actions explícitas)
// ─────────────────────────────────────────────────────────────

async function executeByPlanType(plan: any, segment: any): Promise<string> {
    const message = plan.description || 'Mensagem automática do Orquestrador Conversio AI.';

    switch (plan.type) {
        case 'campaign':
        case 'nurture': {
            const campaignId = await createCampaign({
                name: plan.title,
                type: 'orchestrator_auto',
                target_segment: segment,
                message_template: message,
                created_by: null,
                status: 'pending_validation'
            });
            return `✅ Campanha "${plan.title}" criada e aguarda validação (ID: ${campaignId}).\n`;
        }

        case 'recovery': {
            const threshold = segment.churn_risk_min || 70;
            const leads = await query(`SELECT id, user_id FROM leads WHERE (100 - COALESCE(score, 0)) >= $1 LIMIT 200`, [threshold]).catch(() => ({ rows: [] }));
            let created = 0;
            for (const lead of leads.rows) {
                await query(`INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload) VALUES ($1, $2, $3, $4, $5)`,
                    ['Agente Recuperação', 'recovery_message', 'awaiting_approval', 1, JSON.stringify({ userId: lead.user_id, leadId: lead.id, message, source: 'orchestrator_plan', planId: plan.id })]
                ).catch(() => {});
                created++;
            }
            return `✅ ${created} tarefas de recuperação criadas e aguardam aprovação.\n`;
        }

        case 'followup': {
            const leads = await query(`
                SELECT id, user_id FROM leads 
                WHERE (next_action_date IS NULL OR next_action_date < now()) 
                AND temperature IN ('warm', 'hot')
                LIMIT 100
            `).catch(() => ({ rows: [] }));
            let queued = 0;
            for (const lead of leads.rows) {
                await query(`INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload) VALUES ($1, $2, $3, $4, $5)`,
                    ['Agente Envios', 'send_message', 'awaiting_approval', 2, JSON.stringify({ userId: lead.user_id, message, source: 'orchestrator_plan', planId: plan.id })]
                ).catch(() => {});
                queued++;
            }
            return `✅ ${queued} follow-ups aguardando aprovação para leads warm/hot.\n`;
        }

        case 'classification': {
            const funnelAgent = await import('./funnelAgent.js');
            await funnelAgent.recalculateAllActiveLeads();
            return `✅ Recálculo de scores de todos os leads concluído via tipo.\n`;
        }

        default:
            return `ℹ️ Tipo "${plan.type}" executado (sem acções específicas disponíveis).\n`;
    }
}

// ─────────────────────────────────────────────────────────────
// EXECUTOR DE AÇÕES INDIVIDUAIS (Completo)
// ─────────────────────────────────────────────────────────────

async function executeAction(action: any, plan: any, segment: any): Promise<string> {
    // Suportar tanto action.action como action.type (a IA pode gerar ambos)
    const actionType = action.action || action.type || '';

    switch (actionType) {

        // ── CAMPANHAS ──────────────────────────────────────────────
        case 'send_campaign':
        case 'create_campaign':
        case 'launch_campaign': {
            const campaignId = await createCampaign({
                name: action.campaign_name || plan.title,
                type: action.campaign_type || 'orchestrator_auto',
                target_segment: {
                    ...(action.target_segment || segment),
                    variant_a: action.variant_a,
                    variant_b: action.variant_b
                },
                message_template: action.message_template || action.message || 'Mensagem automática gerada pelo Orquestrador.',
                created_by: null,
                status: 'pending_validation'
            });
            return `✅ Campanha "${action.campaign_name || plan.title}" criada e MARCARA PARA VALIDAÇÃO (ID: ${campaignId}).\n`;
        }

        // ── RECÁLCULO DE SCORES ────────────────────────────────────
        case 'recalculate_scores':
        case 'update_scores':
        case 'recalculate': {
            const funnelAgent = await import('./funnelAgent.js');
            await funnelAgent.recalculateAllActiveLeads();
            return `✅ Recálculo de scores de todos os leads concluído.\n`;
        }

        // ── SEQUÊNCIA DE RECUPERAÇÃO ───────────────────────────────
        case 'send_recovery_sequence':
        case 'recovery_sequence':
        case 'start_recovery': {
            const churnThreshold = segment.churn_risk_min || action.churn_threshold || 70;
            const leads = await query(`
                SELECT id, user_id FROM leads WHERE (100 - COALESCE(score, 0)) >= $1 LIMIT 200
            `, [churnThreshold]).catch(() => ({ rows: [] }));

            let created = 0;
            for (const lead of leads.rows) {
                await query(`
                    INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['Agente Recuperação', 'recovery_message', 'awaiting_approval', 1, JSON.stringify({
                    userId: lead.user_id,
                    leadId: lead.id,
                    message: action.message_template || action.message,
                    source: 'orchestrator_plan',
                    planId: plan.id
                })]).catch(() => {});
                created++;
            }
            return `✅ ${created} tarefas de recuperação criadas (Aguardando Aprovação).\n`;
        }

        // ── ONBOARDING / REENGAJAMENTO ─────────────────────────────
        case 'send_onboarding':
        case 'onboarding':
        case 'reengagement': {
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
                    INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['Agente Envios', 'send_message', 'awaiting_approval', 2, JSON.stringify({
                    userId: user.id,
                    type: 'onboarding_reengagement',
                    message: action.message_template || action.message,
                    source: 'orchestrator_plan'
                })]).catch(() => {});
                queued++;
            }
            return `✅ ${queued} mensagens de onboarding aguardando aprovação.\n`;
        }

        // ── FOLLOW-UP DIRECTO ──────────────────────────────────────
        case 'send_followup':
        case 'followup':
        case 'send_follow_up':
        case 'follow_up': {
            const temperature = action.temperature || segment.temperature || 'warm';
            const daysInactive = action.days_inactive || segment.days_inactive || 3;
            const leads = await query(`
                SELECT id, user_id FROM leads 
                WHERE temperature = $1 
                AND (next_action_date IS NULL OR next_action_date < now() - ($2 || ' days')::INTERVAL)
                LIMIT 100
            `, [temperature, daysInactive]).catch(() => ({ rows: [] }));

            let sent = 0;
            for (const lead of leads.rows) {
                await query(`
                    INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['Agente Envios', 'send_message', 'awaiting_approval', 2, JSON.stringify({
                    userId: lead.user_id,
                    leadId: lead.id,
                    message: action.message_template || action.message || 'Olá! A Conversio AI tem novidades para si. Passe pelo painel e descubra.',
                    source: 'orchestrator_plan',
                    planId: plan.id
                })]).catch(() => {});
                sent++;

                // Atualizar próxima ação do lead
                await query(`
                    UPDATE leads SET next_action_date = now() + INTERVAL '3 days' WHERE id = $1
                `, [lead.id]).catch(() => {});
            }
            return `✅ ${sent} follow-ups enviados para leads ${temperature} (inativos há ${daysInactive}+ dias).\n`;
        }

        // ── ATUALIZAÇÃO EM MASSA DE LEADS ──────────────────────────
        case 'update_leads':
        case 'classify_leads':
        case 'reclassify': {
            const criteria = action.criteria || {};
            if (criteria.set_temperature) {
                const where = criteria.where || `temperature = 'cold' AND score > 50`;
                const updated = await query(`
                    UPDATE leads SET temperature = $1 WHERE ${where}
                `, [criteria.set_temperature]).catch(() => ({ rowCount: 0 }));
                return `✅ ${updated.rowCount || 0} leads actualizados para temperatura "${criteria.set_temperature}".\n`;
            }
            // Fallback: recalcular tudo
            const funnelAgent = await import('./funnelAgent.js');
            await funnelAgent.recalculateAllActiveLeads();
            return `✅ Leads reclassificados via recálculo automático.\n`;
        }

        // ── SEGMENTAÇÃO DE AUDIÊNCIA ───────────────────────────────
        case 'segment_audience':
        case 'build_audience':
        case 'create_segment': {
            const { buildAudience } = await import('./campaignsAgent.js');
            const segmentKey = action.segment_key || action.segmentKey || 'active_users';
            const audience = await buildAudience({ segmentKey });
            return `✅ Audiência segmentada: ${audience.length} utilizadores no segmento "${segmentKey}".\n`;
        }

        // ── AUTOMAÇÃO / SEQUÊNCIA DE MENSAGENS ─────────────────────
        case 'create_automation':
        case 'automation':
        case 'create_sequence': {
            // Criar uma série de tarefas escalonadas
            const steps = action.steps || action.sequence || [
                { delay_hours: 0, message: action.message_template || 'Bem-vindo! Descubra como a Conversio AI pode transformar o seu marketing.' },
                { delay_hours: 24, message: 'Já experimentou criar o seu primeiro anúncio? Leva menos de 2 minutos!' },
                { delay_hours: 72, message: 'Oferta exclusiva: ganhe créditos extra ao fazer upgrade hoje.' },
            ];

            const targetLeads = await query(`
                SELECT id, user_id FROM leads 
                WHERE temperature IN ('cold', 'warm') 
                AND score < 50
                LIMIT 50
            `).catch(() => ({ rows: [] }));

            let totalTasks = 0;
            for (const lead of targetLeads.rows) {
                for (let i = 0; i < steps.length; i++) {
                    const step = steps[i];
                    await query(`
                        INSERT INTO agent_tasks (agent_name, task_type, priority, payload)
                        VALUES ($1, $2, $3, $4)
                    `, ['Agente Envios', 'send_message', 3, JSON.stringify({
                        userId: lead.user_id,
                        leadId: lead.id,
                        message: step.message,
                        source: 'orchestrator_automation',
                        planId: plan.id,
                        step: i + 1,
                        delay_hours: step.delay_hours || 0
                    })]).catch(() => {});
                    totalTasks++;
                }
            }
            return `✅ Automação criada: ${steps.length} passos × ${targetLeads.rows.length} leads = ${totalTasks} tarefas enfileiradas.\n`;
        }

        // ── NOTIFICAÇÃO/ALERTA ─────────────────────────────────────
        case 'send_notification':
        case 'notify':
        case 'alert': {
            const msg = action.message || action.message_template || plan.description;
            try {
                const adminPhone = await getAdminWhatsApp();
                if (adminPhone) {
                    await sendPremiumAdminReport(adminPhone, 'ORQUESTRADOR ALERTA', msg, 'Verifique o painel admin.', action.severity || 'info');
                }
            } catch (e) { /* non-critical */ }
            return `✅ Notificação enviada ao admin.\n`;
        }

        // ── PAUSAR CAMPANHAS ───────────────────────────────────────
        case 'pause_campaigns':
        case 'pause_campaign': {
            const paused = await query(`
                UPDATE campaigns SET status = 'paused' WHERE status = 'active'
                RETURNING id, name
            `).catch(() => ({ rows: [], rowCount: 0 }));
            return `✅ ${paused.rowCount || 0} campanha(s) pausada(s).\n`;
        }

        // ── EXECUTAR AGENTE ESPECÍFICO ─────────────────────────────
        case 'run_agent':
        case 'trigger_agent': {
            const agentName = action.agent || action.agent_name || '';
            try {
                if (agentName.includes('funil') || agentName.includes('funnel')) {
                    const funnelAgent = await import('./funnelAgent.js');
                    await funnelAgent.runFunnelAgent();
                    return `✅ Agente Funil executado com sucesso.\n`;
                }
                if (agentName.includes('campanha') || agentName.includes('campaign')) {
                    const campaignsAgent = await import('./campaignsAgent.js');
                    await campaignsAgent.runCampaignsAgent();
                    return `✅ Agente Campanhas executado com sucesso.\n`;
                }
                if (agentName.includes('recupera') || agentName.includes('recovery')) {
                    const recoveryAgent = await import('./recoveryAgent.js');
                    await recoveryAgent.runRecoveryAgent();
                    return `✅ Agente Recuperação executado com sucesso.\n`;
                }
                if (agentName.includes('monitor')) {
                    const monitorAgent = await import('./monitorAgent.js');
                    await monitorAgent.runMonitorAgent();
                    return `✅ Agente Monitor executado com sucesso.\n`;
                }
                return `ℹ️ Agente "${agentName}" não reconhecido para execução directa.\n`;
            } catch (e: any) {
                return `❌ Erro ao executar agente "${agentName}": ${e.message}\n`;
            }
        }

        // ── POST-SALE (NOVO) ──────────────────────────────────────
        case 'send_post_sale':
        case 'post_sale': {
            const paidUsers = await query(`
                SELECT DISTINCT t.user_id
                FROM transactions t
                LEFT JOIN generations g ON g.user_id = t.user_id AND g.created_at > t.created_at
                WHERE t.status = 'completed'
                AND t.created_at > now() - INTERVAL '7 days'
                AND g.id IS NULL
                LIMIT 100
            `).catch(() => ({ rows: [] }));

            let queued = 0;
            for (const user of paidUsers.rows) {
                // A/B Testing: alternate between variant_a and variant_b
                const useVariantB = queued % 2 === 1;
                const msg = useVariantB && action.variant_b ? action.variant_b : (action.variant_a || action.message_template || action.message || 'Olá {nome}! Os seus créditos estão prontos. Crie o seu primeiro conteúdo incrível agora!');

                await query(`
                    INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['Agente Envios', 'send_message', 'awaiting_approval', 2, JSON.stringify({
                    userId: user.user_id,
                    message: msg,
                    type: 'post_sale_activation',
                    source: 'orchestrator_plan',
                    planId: plan.id,
                    ab_variant: useVariantB ? 'B' : 'A'
                })]).catch(() => {});
                queued++;
            }
            return `✅ ${queued} mensagens post-sale enfileiradas (A/B split).\n`;
        }

        // ── UPSELL (NOVO) ─────────────────────────────────────────
        case 'send_upsell':
        case 'upsell': {
            const lowCreditUsers = await query(`
                SELECT id FROM users
                WHERE credits > 0 AND credits <= 5 AND role = 'user'
                LIMIT 100
            `).catch(() => ({ rows: [] }));

            let upsellQueued = 0;
            for (const user of lowCreditUsers.rows) {
                const useVariantB = upsellQueued % 2 === 1;
                const msg = useVariantB && action.variant_b ? action.variant_b : (action.variant_a || action.message_template || action.message || 'Olá {nome}! Os seus créditos estão quase a acabar. Recarregue agora e continue a criar!');

                await query(`
                    INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['Agente Envios', 'send_message', 'awaiting_approval', 2, JSON.stringify({
                    userId: user.id,
                    message: msg,
                    type: 'upsell_low_credits',
                    source: 'orchestrator_plan',
                    planId: plan.id,
                    ab_variant: useVariantB ? 'B' : 'A'
                })]).catch(() => {});
                upsellQueued++;
            }
            return `✅ ${upsellQueued} mensagens de upsell enfileiradas (A/B split).\n`;
        }

        // ── ACÇÃO DESCONHECIDA (FALLBACK) ───────────────────────────
        default: {
            console.log(`[SmartOrchestrator] ℹ️ Mapeamento automático: Redirecionando a acção "${actionType}" para a mecânica de "${plan.type}"...`);
            // Tentar usar o tipo do plano como fallback
            return await executeByPlanType(plan, segment);
        }
    }
}

// ─────────────────────────────────────────────────────────────
// RELATÓRIO DE EXECUÇÃO PARA ADMIN
// ─────────────────────────────────────────────────────────────

async function notifyAdminExecutionReport(plan: any, report: string, success: boolean) {
    try {
        const adminPhone = await getAdminWhatsApp();
        if (!adminPhone) return;

        await sendPremiumAdminReport(
            adminPhone,
            success ? 'ACÇÕES GERADAS' : 'FALHA NA EXECUÇÃO',
            `Plano: ${plan.title}`,
            success ? 'As acções propostas foram geradas e AGUARDAM A SUA VALIDAÇÃO no painel antes de serem disparadas.' : 'Aceda ao painel para verificar o erro.',
            success ? 'info' : 'critical'
        );

    } catch (e) {
        console.error('[SmartOrchestrator] Erro ao enviar relatório de execução:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// LOOP PRINCIPAL — chamado pelo cron
// ─────────────────────────────────────────────────────────────

export const runSmartOrchestrator = async () => {
    console.log('[SmartOrchestrator] 🧠 Iniciando análise inteligente do sistema (v2)...');

    try {
        // 1. Executar planos já aprovados pelo Admin
        await executeApprovedPlans();

        // 2. Analisar o sistema (com feedback loop completo)
        const systemData = await analyzeSystem();
        if (!systemData) return;

        // 3. Gerar novos planos de ação (com aprendizagem)
        const plans = await generateActionPlansWithAI(systemData);
        if (!plans || plans.length === 0) {
            console.log('[SmartOrchestrator] Nenhum plano novo gerado neste ciclo.');
            await saveMemory('last_cycle_result', 'no_plans_generated');
            return;
        }

        // 4. Salvar planos na BD (sem duplicados)
        const savedCount = await savePlans(plans);

        if (savedCount > 0) {
            // 5. Notificar Admin via WhatsApp
            await notifyAdminNewPlans(savedCount, plans);
            console.log(`[SmartOrchestrator] ✅ ${savedCount} planos de ação guardados e admin notificado.`);
            await saveMemory('last_cycle_result', `${savedCount}_plans_saved`);
        } else {
            console.log('[SmartOrchestrator] Todos os planos gerados já existem. Nenhum novo guardado.');
            await saveMemory('last_cycle_result', 'all_duplicates');
        }

    } catch (e) {
        console.error('[SmartOrchestrator] Falha geral no orquestrador inteligente:', e);
        await saveMemory('last_cycle_result', 'error').catch(() => {});
    }
};

// ─────────────────────────────────────────────────────────────
// MEMÓRIA PERSISTENTE DO ORQUESTRADOR
// ─────────────────────────────────────────────────────────────

export async function saveMemory(key: string, value: string) {
    try {
        await query(`
            INSERT INTO orchestrator_memory (context_key, context_value, updated_at)
            VALUES ($1, $2, now())
            ON CONFLICT (context_key) DO UPDATE SET context_value = EXCLUDED.context_value, updated_at = now()
        `, [key, value.substring(0, 1000)]);
    } catch (e: any) {
        // Table may not exist yet — silent fail
        console.error('[SmartOrchestrator] Memory save error:', e.message);
    }
}
