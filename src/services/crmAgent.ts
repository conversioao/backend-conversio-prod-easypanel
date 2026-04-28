import { query } from '../db.js';
import { keyManager } from './KeyManager.js';
import { processWithOpenAI } from '../utils/openai.js';

export const generateCampaginWithAI = async (usersContext: any[], promptInput?: string) => {
    try {
        const contextString = usersContext.map(u => `ID: ${u.id}, Nome: ${u.name}, Histórico: ${u.interactions}`).join('\n');
        const systemPrompt = `Você é um estrategista de CRM. Contexto: ${contextString}. Orientações: ${promptInput || 'Nenhuma'}.`;
        
        const { content: reply } = await processWithOpenAI(systemPrompt, 'Gere a campanha de CRM.', 'crmAgent:campaign');
        
        if (!reply) throw new Error('Falha ao gerar campanha de CRM.');

        let cleanJson = reply;
        if (cleanJson.startsWith('```json')) {
            cleanJson = cleanJson.replace('```json', '').replace('```', '').trim();
        } else if (cleanJson.startsWith('```')) {
            cleanJson = cleanJson.replace('```', '').replace('```', '').trim();
        }

        return JSON.parse(cleanJson);
    } catch (e: any) {
        console.error('AI Campaign Error:', e);
        throw new Error('Erro ao comunicar com o servidor da OpenAI para gerar a campanha.');
    }
};

export const generateFollowUpWithAI = async (userName: string, stageName: string, interactionHistory: string) => {
    try {
        const systemPrompt = `Você é o Flavio. Usuário: ${userName}, Estágio: ${stageName}, Histórico: ${interactionHistory}.`;
        const { content: followUpReply } = await processWithOpenAI(systemPrompt, 'Gere acompanhamento.', 'crmAgent:followup');
        
        return JSON.parse(followUpReply || '{}');
    } catch (e: any) {
        console.error('AI Follow-up Error:', e);
        return { message: `Olá ${userName}, notamos que está parado no estágio ${stageName}. Tem alguma dúvida na qual possamos ajudar?` };
    }
};


/**
 * MÓDULO C — CRM Actualizado
 */

export async function updateCRMProfile(userId: string) {
    try {
        console.log(`[CRM Agent] 🔄 Atualizando perfil CRM para ${userId}...`);

        // 1. Calcular LTV e compras
        const statsRes = await query(`
            SELECT 
                COUNT(*) as total_purchases,
                SUM(amount) as lifetime_value,
                AVG(amount) as avg_purchase_value
            FROM transactions
            WHERE user_id = $1 AND status = 'completed'
        `, [userId]);

        const stats = statsRes.rows[0];
        const ltv = parseFloat(stats.lifetime_value || 0);
        const count = parseInt(stats.total_purchases || 0);
        const avg = parseFloat(stats.avg_purchase_value || 0);

        // 2. Determinar canal preferido (baseado em interações)
        const channelRes = await query(`
            SELECT type, COUNT(*) as count 
            FROM crm_interactions 
            WHERE user_id = $1 
            GROUP BY type 
            ORDER BY count DESC 
            LIMIT 1
        `, [userId]);
        const preferredChannel = channelRes.rows[0]?.type || 'whatsapp';

        // 3. Upsert no crm_profiles
        await query(`
            INSERT INTO crm_profiles (user_id, lifetime_value, total_purchases, avg_purchase_value, preferred_channel, last_updated)
            VALUES ($1, $2, $3, $4, $5, NOW())
            ON CONFLICT (user_id) DO UPDATE SET
                lifetime_value = EXCLUDED.lifetime_value,
                total_purchases = EXCLUDED.total_purchases,
                avg_purchase_value = EXCLUDED.avg_purchase_value,
                preferred_channel = EXCLUDED.preferred_channel,
                last_updated = NOW()
        `, [userId, ltv, count, avg, preferredChannel]);

        // 4. Auto-tagging básico
        let tags: string[] = [];
        if (ltv > 50000) tags.push('vip');
        if (count > 5) tags.push('power_user');
        
        const userRes = await query(`SELECT created_at FROM users WHERE id = $1`, [userId]);
        const createdAt = new Date(userRes.rows[0].created_at);
        const daysSinceSignup = (Date.now() - createdAt.getTime()) / (1000 * 3600 * 24);
        if (daysSinceSignup < 7) tags.push('early_adopter');

        if (tags.length > 0) {
            await query(`
                UPDATE crm_profiles 
                SET tags = (SELECT jsonb_agg(DISTINCT x) FROM jsonb_array_elements(tags || $1::jsonb) x)
                WHERE user_id = $2
            `, [JSON.stringify(tags), userId]);
        }

        return { success: true, ltv, tags };
    } catch (error) {
        console.error('[CRM Agent] Erro ao atualizar perfil:', error);
        throw error;
    }
}

export async function enrichProfile(userId: string) {
    try {
        console.log(`[CRM Agent] 🧠 Enriquecendo perfil para ${userId} com IA...`);
        const systemPrompt = `Você é um analista comportamental para o usuário ${userId}.`;
        const { content: enrichReply } = await processWithOpenAI(systemPrompt, 'Enriqueça o perfil.', 'crmAgent:enrich');
        
        const insights = JSON.parse(enrichReply || '{}');

        // Salvar insights nas notas do perfil
        await query(`
            UPDATE crm_profiles 
            SET notes = $1, last_updated = NOW() 
            WHERE user_id = $2
        `, [JSON.stringify(insights), userId]);

        return insights;
    } catch (e: any) {
        console.error('[CRM Agent] AI Enrichment Error:', e);
        return null;
    }
}


