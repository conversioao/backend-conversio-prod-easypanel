import { query } from '../db.js';

/**
 * A/B Testing & Optimization Agent
 * Analisa as métricas de conversão de diferentes variantes de mensagens (A vs B).
 */

export const runABTestingAgent = async () => {
    console.log('[AB Testing Agent] Iniciando análise de variantes A/B...');

    try {
        // Obter os IDs das mensagens A/B enviadas nas últimas 48 horas
        // Assume que as tarefas foram geradas com ab_variant no payload e guardadas no agent_logs ou whatsapp_logs
        
        // Nesta versão, vamos analisar pelo tipo de tarefa que tem histórico A/B (upsell, post_sale)
        const taskTypes = ['upsell_low_credits', 'post_sale_activation'];

        for (const taskType of taskTypes) {
            // Obter estatísticas do WhatsApp Logs mapeadas com as Tarefas
            // O payload original deve ter ficado no agent_logs quando a tarefa foi executada
            const stats = await query(`
                SELECT 
                    al.metadata->>'ab_variant' as variant,
                    COUNT(*) as total_sent,
                    COUNT(*) FILTER (WHERE wl.status = 'read') as total_read,
                    COUNT(*) FILTER (WHERE wl.direction = 'inbound') as total_replies
                FROM agent_logs al
                JOIN agent_tasks at ON at.id::text = al.metadata->>'task_id'
                LEFT JOIN whatsapp_logs wl ON wl.recipient = (al.metadata->>'phone') AND wl.created_at >= al.created_at
                WHERE al.action = 'WHATSAPP_SENT'
                AND al.metadata->>'type' = $1
                AND al.metadata->>'ab_variant' IS NOT NULL
                AND al.created_at > now() - INTERVAL '72 hours'
                GROUP BY al.metadata->>'ab_variant'
            `, [taskType]).catch(() => ({ rows: [] }));

            if (stats.rows.length === 2) {
                const varA = stats.rows.find(r => r.variant === 'A');
                const varB = stats.rows.find(r => r.variant === 'B');

                if (varA && varB && parseInt(varA.total_sent) > 5 && parseInt(varB.total_sent) > 5) {
                    const replyRateA = parseInt(varA.total_replies) / parseInt(varA.total_sent);
                    const replyRateB = parseInt(varB.total_replies) / parseInt(varB.total_sent);

                    let winner = '';
                    if (replyRateA > replyRateB * 1.2) winner = 'A'; // A is 20% better
                    else if (replyRateB > replyRateA * 1.2) winner = 'B'; // B is 20% better

                    if (winner) {
                        console.log(`[AB Testing Agent] Vencedor claro encontrado para ${taskType}: Variante ${winner}!`);
                        
                        // Gravar o insight para o Orquestrador
                        await query(`
                            INSERT INTO orchestrator_memory (context_key, context_value, updated_at)
                            VALUES ($1, $2, now())
                            ON CONFLICT (context_key) DO UPDATE SET context_value = EXCLUDED.context_value, updated_at = now()
                        `, [`ab_winner_${taskType}`, `A Variante ${winner} teve melhor taxa de resposta (${Math.round((winner === 'A' ? replyRateA : replyRateB)*100)}%). Priorizar esta variante.`]);
                    }
                }
            }
        }

        console.log('[AB Testing Agent] ✅ Análise A/B concluída.');

    } catch (e) {
        console.error('[AB Testing Agent] Erro crítico:', e);
    }
};
