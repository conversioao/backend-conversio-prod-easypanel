import { query } from '../db.js';
import { processWithOpenAI } from '../utils/openai.js';

/**
 * Agente Pós-Venda — Activação, Marcos e Upsell Automático
 * 
 * Três funções principais:
 * 1. Activação pós-compra: Detecta clientes que pagaram mas não usaram créditos
 * 2. Marcos de sucesso: Detecta marcos de utilização (10ª, 50ª, 100ª geração)
 * 3. Upsell automático: Detecta clientes com créditos baixos
 */

// ─────────────────────────────────────────────────────────────
// 1. ACTIVAÇÃO PÓS-COMPRA
// Clientes que pagaram nos últimos 3 dias e não fizeram nenhuma geração desde
// ─────────────────────────────────────────────────────────────

async function runPostPurchaseActivation() {
    console.log('[Post-Sale Agent] Verificando clientes pagos sem activação...');

    try {
        const paidNotUsed = await query(`
            SELECT DISTINCT t.user_id, u.name, u.whatsapp, t.credits, t.created_at as paid_at
            FROM transactions t
            JOIN users u ON u.id = t.user_id
            LEFT JOIN generations g ON g.user_id = t.user_id AND g.created_at > t.created_at
            WHERE t.status = 'completed'
            AND t.created_at > now() - INTERVAL '3 days'
            AND g.id IS NULL
            AND u.whatsapp IS NOT NULL
            LIMIT 50
        `);

        if (paidNotUsed.rows.length === 0) {
            console.log('[Post-Sale Agent] Todos os clientes pagos estão ativos. ✅');
            return;
        }

        console.log(`[Post-Sale Agent] ${paidNotUsed.rows.length} clientes pagos sem activação.`);

        for (const user of paidNotUsed.rows) {
            // Verificar se já enviámos esta mensagem
            const alreadySent = await query(`
                SELECT id FROM agent_tasks 
                WHERE payload::text LIKE '%post_sale_activation%' 
                AND payload::text LIKE $1
                AND created_at > now() - INTERVAL '7 days'
            `, [`%${user.user_id}%`]).catch(() => ({ rows: [] }));

            if (alreadySent.rows.length > 0) continue;

            let message = '';
            try {
                const { content } = await processWithOpenAI(
                    "És um CSM (Customer Success Manager) da Conversio AI, plataforma de criação de conteúdo com IA em Angola.",
                    `O cliente ${user.name} comprou ${user.credits} créditos mas ainda não usou. 
                     Cria uma mensagem curta (máx 180 chars) em português de Angola para motivá-lo a criar o seu primeiro conteúdo.
                     Tom: entusiasmante, amigável, directo. Usa o emoji 🚀 no início.
                     Usa {nome} como placeholder.`,
                    'postSaleAgent',
                    'gpt-4o-mini',
                    'text'
                );
                message = content || `🚀 Olá {nome}! Os seus ${user.credits} créditos estão prontos. Crie o seu primeiro anúncio com IA em 2 minutos!`;
            } catch {
                message = `🚀 Olá {nome}! Os seus ${user.credits} créditos estão prontos. Crie o seu primeiro anúncio com IA em 2 minutos!`;
            }

            await query(`
                INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload)
                VALUES ($1, $2, $3, $4, $5)
            `, ['Agente Envios', 'send_message', 'awaiting_approval', 2, JSON.stringify({
                userId: user.user_id,
                message,
                type: 'post_sale_activation',
                source: 'post_sale_agent',
                context: { credits: user.credits, paidAt: user.paid_at }
            })]);

            await query(`
                INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
                VALUES ($1, $2, $3, $4, $5)
            `, ['Agente Pós-Venda', 'ACTIVATION_QUEUED', user.user_id, 'success',
                JSON.stringify({ credits: user.credits })
            ]);
        }

        console.log(`[Post-Sale Agent] ${paidNotUsed.rows.length} activações pós-compra enfileiradas.`);

    } catch (e: any) {
        console.error('[Post-Sale Agent] Erro na activação pós-compra:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────
// 2. MARCOS DE SUCESSO
// Parabenizar clientes ao atingirem marcos de geração (10, 25, 50, 100)
// ─────────────────────────────────────────────────────────────

async function runMilestoneCheck() {
    console.log('[Post-Sale Agent] Verificando marcos de sucesso...');

    const milestones = [10, 25, 50, 100, 250, 500];

    try {
        for (const milestone of milestones) {
            const usersAtMilestone = await query(`
                SELECT g.user_id, u.name, u.whatsapp, COUNT(*) as gen_count
                FROM generations g
                JOIN users u ON u.id = g.user_id
                WHERE g.status = 'completed'
                AND u.whatsapp IS NOT NULL
                GROUP BY g.user_id, u.name, u.whatsapp
                HAVING COUNT(*) >= $1 AND COUNT(*) < $2
            `, [milestone, milestone + (milestone < 50 ? 5 : milestone < 100 ? 10 : 50)]);

            for (const user of usersAtMilestone.rows) {
                // Verificar se já parabenizámos por este marco
                const alreadySent = await query(`
                    SELECT id FROM agent_logs 
                    WHERE agent_name = 'Agente Pós-Venda' 
                    AND action = 'MILESTONE_SENT'
                    AND user_id = $1
                    AND metadata::text LIKE $2
                `, [user.user_id, `%"milestone":${milestone}%`]).catch(() => ({ rows: [] }));

                if (alreadySent.rows.length > 0) continue;

                const messages: Record<number, string> = {
                    10: `🎉 Parabéns {nome}! Já criou 10 conteúdos com a Conversio AI. O seu marketing está a evoluir!`,
                    25: `🏆 Incrível {nome}! 25 gerações! Já é um profissional da criação com IA. Continue assim!`,
                    50: `🌟 WOW {nome}! 50 conteúdos criados! Está no top dos criadores da Conversio AI!`,
                    100: `💎 LENDÁRIO {nome}! 100 gerações! É oficialmente um mestre de conteúdo com IA. Obrigado por confiar!`,
                    250: `🚀 {nome}, 250 gerações?! É um dos nossos clientes mais dedicados. Muito obrigado!`,
                    500: `👑 {nome}, atingiu 500 gerações! É uma lenda da Conversio AI. Contacte-nos para benefícios VIP!`,
                };

                const message = messages[milestone] || `🎉 Parabéns {nome}! Atingiu ${milestone} gerações!`;

                await query(`
                    INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['Agente Envios', 'send_message', 'awaiting_approval', 3, JSON.stringify({
                    userId: user.user_id,
                    message,
                    type: 'milestone_celebration',
                    source: 'post_sale_agent',
                    context: { milestone, genCount: user.gen_count }
                })]);

                await query(`
                    INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['Agente Pós-Venda', 'MILESTONE_SENT', user.user_id, 'success',
                    JSON.stringify({ milestone, genCount: user.gen_count })
                ]);
            }
        }

        console.log('[Post-Sale Agent] Marcos de sucesso verificados. ✅');

    } catch (e: any) {
        console.error('[Post-Sale Agent] Erro nos marcos de sucesso:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────
// 3. UPSELL AUTOMÁTICO — Créditos Baixos
// Se o cliente tem ≤5 créditos restantes, sugerir recarga
// ─────────────────────────────────────────────────────────────

async function runLowCreditsUpsell() {
    console.log('[Post-Sale Agent] Verificando clientes com créditos baixos...');

    try {
        const lowCredits = await query(`
            SELECT u.id, u.name, u.whatsapp, u.credits
            FROM users u
            WHERE u.credits > 0 AND u.credits <= 5
            AND u.role = 'user'
            AND u.whatsapp IS NOT NULL
            LIMIT 50
        `);

        if (lowCredits.rows.length === 0) {
            console.log('[Post-Sale Agent] Nenhum cliente com créditos baixos.');
            return;
        }

        for (const user of lowCredits.rows) {
            // Verificar cooldown: não mandar upsell mais de 1x por semana
            const recentUpsell = await query(`
                SELECT id FROM agent_tasks 
                WHERE payload::text LIKE '%upsell_low_credits%' 
                AND payload::text LIKE $1
                AND created_at > now() - INTERVAL '7 days'
            `, [`%${user.id}%`]).catch(() => ({ rows: [] }));

            if (recentUpsell.rows.length > 0) continue;

            const message = `⚡ Olá {nome}! Os seus créditos (${user.credits}) estão quase a acabar. Recarregue agora para não perder o ritmo criativo! 🎨`;

            await query(`
                INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload)
                VALUES ($1, $2, $3, $4, $5)
            `, ['Agente Envios', 'send_message', 'awaiting_approval', 2, JSON.stringify({
                userId: user.id,
                message,
                type: 'upsell_low_credits',
                source: 'post_sale_agent',
                context: { currentCredits: user.credits }
            })]);

            await query(`
                INSERT INTO agent_logs (agent_name, action, user_id, result, metadata)
                VALUES ($1, $2, $3, $4, $5)
            `, ['Agente Pós-Venda', 'UPSELL_QUEUED', user.id, 'success',
                JSON.stringify({ credits: user.credits })
            ]);
        }

        console.log(`[Post-Sale Agent] ${lowCredits.rows.length} upsells de créditos baixos enfileirados.`);

    } catch (e: any) {
        console.error('[Post-Sale Agent] Erro no upsell de créditos:', e.message);
    }
}

// ─────────────────────────────────────────────────────────────
// LOOP PRINCIPAL — chamado pelo cron
// ─────────────────────────────────────────────────────────────

export const runPostSaleAgent = async () => {
    console.log('[Post-Sale Agent] 🎯 Iniciando ciclo de pós-venda...');

    try {
        await runPostPurchaseActivation();
        await runMilestoneCheck();
        await runLowCreditsUpsell();
        console.log('[Post-Sale Agent] ✅ Ciclo de pós-venda concluído.');
    } catch (e) {
        console.error('[Post-Sale Agent] Erro fatal:', e);
    }
};
