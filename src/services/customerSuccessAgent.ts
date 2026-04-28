import { query } from '../db.js';
import { processWithOpenAI } from '../utils/openai.js';

/**
 * Customer Success Agent
 * Proactivamente envia "Prompts Mágicos" para utilizadores inativos para incentivar o uso da plataforma.
 */

export const runCustomerSuccessAgent = async () => {
    console.log('[Customer Success Agent] Iniciando verificação de utilizadores inativos...');

    try {
        // Encontrar utilizadores que têm créditos mas não geraram nada nas últimas 48 horas
        // E que não receberam um "Magic Prompt" recentemente
        const targetUsers = await query(`
            SELECT u.id, u.name, u.whatsapp, u.context_briefing, u.credits
            FROM users u
            LEFT JOIN generations g ON g.user_id = u.id AND g.created_at > now() - INTERVAL '48 hours'
            LEFT JOIN agent_logs al ON al.metadata->>'user_id' = u.id::text AND al.action = 'MAGIC_PROMPT_SENT' AND al.created_at > now() - INTERVAL '7 days'
            WHERE u.credits > 0 
            AND u.whatsapp IS NOT NULL
            AND g.id IS NULL
            AND al.id IS NULL
            LIMIT 50
        `);

        if (targetUsers.rows.length === 0) {
            console.log('[Customer Success Agent] Nenhum utilizador inativo elegível encontrado hoje.');
            return;
        }

        console.log(`[Customer Success Agent] Encontrados ${targetUsers.rows.length} utilizadores elegíveis. Gerando Prompts Mágicos...`);

        let sent = 0;
        for (const user of targetUsers.rows) {
            const userName = user.name ? user.name.split(' ')[0] : 'Empreendedor';
            const briefing = user.context_briefing || 'Um negócio angolano à procura de crescimento';

            // Gerar o Prompt Mágico
            const systemPrompt = `Você é o Diretor Criativo da Conversio AI. O seu objectivo é criar UM (1) prompt espectacular e altamente visual para geração de imagem ou vídeo focado no negócio do utilizador.
O negócio é: "${briefing}".
Retorne APENAS o texto do prompt, pronto a copiar e colar na plataforma. Seja criativo, inclua iluminação cinematográfica, cores vibrantes, e um toque profissional/angolano se fizer sentido. Não inclua aspas no início ou fim. Mantenha-o em inglês (para a IA) ou português muito descritivo. Limite a 50 palavras.`;

            try {
                const { content: magicPrompt } = await processWithOpenAI(
                    systemPrompt,
                    "Gera um prompt incrível para mim.",
                    'customerSuccessAgent',
                    'gpt-4o-mini',
                    'text'
                );

                const message = `Olá ${userName}! 🌟\n\nNotei que não tens gerado conteúdo recentemente na Conversio AI, e tens ${user.credits} créditos na conta a ganhar pó!\n\nEstava a pensar na tua marca e criei este *Prompt Mágico* especialmente para ti. Copia o texto abaixo e cola na plataforma para ver a magia:\n\n_${magicPrompt}_\n\n👉 Acede a https://conversio.ao e experimenta!`;

                // Enviar para a fila de tarefas do WhatsApp
                await query(`
                    INSERT INTO agent_tasks (agent_name, task_type, status, priority, payload)
                    VALUES ($1, $2, $3, $4, $5)
                `, ['Agente Envios', 'send_message', 'pending', 2, JSON.stringify({
                    userId: user.id,
                    phone: user.whatsapp,
                    message: message,
                    type: 'customer_success_magic_prompt'
                })]);

                // Registar que enviámos
                await query(`
                    INSERT INTO agent_logs (agent_name, action, result, metadata)
                    VALUES ($1, $2, $3, $4)
                `, ['Customer Success Agent', 'MAGIC_PROMPT_SENT', 'success', JSON.stringify({ user_id: user.id })]);

                sent++;
            } catch (e: any) {
                console.error(`[Customer Success Agent] Erro ao gerar prompt para ${user.id}:`, e.message);
            }
        }

        console.log(`[Customer Success Agent] ✅ Concluído. ${sent} Prompts Mágicos enfileirados.`);

    } catch (e) {
        console.error('[Customer Success Agent] Erro crítico:', e);
    }
};
