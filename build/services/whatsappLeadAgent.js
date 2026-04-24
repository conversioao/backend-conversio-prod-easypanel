import { query } from '../db.js';
import { sendWhatsAppMessage, sendWhatsAppVideo } from './whatsappService.js';
import { processWithOpenAI } from '../utils/openai.js';
/**
 * Agente de Qualificação de Leads WhatsApp
 */
export class WhatsAppLeadAgent {
    /**
     * Processa uma mensagem recebida da Evolution API
     */
    static async handleIncomingMessage(remoteJid, pushName, text) {
        try {
            const phone = remoteJid.split('@')[0];
            console.log(`[LeadAgent] 📩 Mensagem de ${phone} (${pushName}): ${text}`);
            // 1. Verificar se o número já é um utilizador registado
            const userRes = await query('SELECT id, name, context_briefing FROM users WHERE whatsapp = $1', [phone]);
            const isRegisteredUser = userRes.rows.length > 0;
            if (isRegisteredUser) {
                console.log(`[LeadAgent] Utilizador já registado (${userRes.rows[0].name}). O Agente vai prestar suporte.`);
            }
            // 2. Localizar ou criar o Lead
            let leadRes = await query('SELECT * FROM whatsapp_leads WHERE phone = $1', [phone]);
            let lead;
            if (leadRes.rows.length === 0) {
                const insertRes = await query('INSERT INTO whatsapp_leads (phone, name, status) VALUES ($1, $2, $3) RETURNING *', [phone, pushName, 'new']);
                lead = insertRes.rows[0];
            }
            else {
                lead = leadRes.rows[0];
            }
            // 3. Verificar se a IA está ativa para este lead
            if (!lead.agent_active) {
                console.log(`[LeadAgent] 😴 Agente inativo para este lead (modo humano).`);
                return;
            }
            // 4. Salvar mensagem do utilizador no histórico
            await query('INSERT INTO whatsapp_messages (lead_id, role, content) VALUES ($1, $2, $3)', [lead.id, 'user', text]);
            // 5. Obter histórico recente para contexto
            const historyRes = await query('SELECT role, content FROM whatsapp_messages WHERE lead_id = $1 ORDER BY created_at ASC LIMIT 10', [lead.id]);
            const systemPromptRes = await query("SELECT value FROM system_settings WHERE key = 'whatsapp_agent_prompt'");
            const mediaRes = await query(`SELECT slot_id, media_url FROM landing_media WHERE slot_id LIKE 'wa_%'`);
            const mediaSlots = mediaRes.rows.reduce((acc, row) => ({ ...acc, [row.slot_id]: row.media_url }), {});
            const basePrompt = systemPromptRes.rows[0]?.value || `Você é o Alex, especialista em sucesso do cliente da Conversio AI. Seu tom de voz é inspirado no Flavio: natural, humano, caloroso e focado em converter leads angolanos.
            
            DIRETRIZES:
            1. Frise que a Conversio é Angolana e aceita pagamentos em Kwanza (Kz).
            2. Ofereça 50 Créditos Grátis para testar (gera 10+ mídias).
            3. Use o link www.conversio.ao para cadastro.
            4. Se o usuário tiver dúvidas ou dificuldades específicas, use os gatilhos (triggers) de mídia correspondentes.`;
            const systemContext = `
${basePrompt}

Dados Actuais do Lead:
- Nome: ${lead.name || 'Desconhecido'}
- Negócio: ${lead.business_info || 'Ainda não identificado'}
- Necessidade: ${lead.needs || 'Ainda não identificado'}

INSTRUÇÕES DE RESPOSTA (JSON):
Responda APENAS com um JSON no formato:
{
  "reply": "Texto para o WhatsApp",
  "extracted_data": {
    "name": "nome se identificado",
    "business_info": "ramo se identificado",
    "needs": "necessidade se identificada"
  },
  "is_qualified": boolean,
  "trigger_wa_video_account": true/false,
  "trigger_wa_video_ads": true/false,
  "trigger_wa_video_credits": true/false,
  "trigger_wa_img_pricing": true/false,
  "trigger_wa_img_support": true/false
}

GATILHOS (MÍDIA DINÂMICA):
- trigger_wa_video_account: ativar se o lead estiver com dúvidas sobre como criar uma conta.
- trigger_wa_video_ads: ativar se o lead precisar de um guia em como usar ou como gerar anúncios/vídeos na plataforma.
- trigger_wa_video_credits: ativar se o lead quiser saber as formas, como ou onde carregar referências para pagamentos (em Kwanza).
- trigger_wa_img_pricing: ativar se o lead pedir diretamente a tabela de preços detalhada ou os planos.
- trigger_wa_img_support: ativar se o lead precisar de falar com suporte ou mencionar assistência humana.
`;
            const { content: rawResult } = await processWithOpenAI(systemContext, text, 'whatsappLeadAgent:chat', 'gpt-4o', 'json_object');
            const result = JSON.parse(rawResult || '{}');
            const { reply, extracted_data, is_qualified, trigger_wa_video_account, trigger_wa_video_ads, trigger_wa_video_credits, trigger_wa_img_pricing, trigger_wa_img_support } = result;
            // 7. Atualizar dados do Lead
            await query(`UPDATE whatsapp_leads SET 
                    name = COALESCE($1, name),
                    business_info = COALESCE($2, business_info),
                    needs = COALESCE($3, needs),
                    status = $4,
                    last_interaction = NOW()
                WHERE id = $5`, [extracted_data?.name, extracted_data?.business_info, extracted_data?.needs, is_qualified ? 'qualified' : 'in_progress', lead.id]);
            // 8. Salvar resposta
            await query('INSERT INTO whatsapp_messages (lead_id, role, content) VALUES ($1, $2, $3)', [lead.id, 'agent', reply]);
            // 9. Enviar mensagem
            const typingDelayMs = Math.floor(Math.random() * (60000 - 40000 + 1)) + 40000;
            await sendWhatsAppMessage(phone, reply, 'agent_action', typingDelayMs);
            const getFinalUrl = async (url) => {
                if (url && url.includes('contabostorage.com')) {
                    try {
                        const { getSignedS3UrlForKey } = await import('../storage.js');
                        return await getSignedS3UrlForKey(url, 3600);
                    }
                    catch (e) {
                        return url;
                    }
                }
                if (url && url.startsWith('/')) {
                    return `https://conversio.ao${url}`;
                }
                return url;
            };
            const { sendWhatsAppImage } = await import('./whatsappService.js');
            if (trigger_wa_video_account && mediaSlots['wa_video_account']) {
                await sendWhatsAppVideo(phone, await getFinalUrl(mediaSlots['wa_video_account']), 'Aqui tens um vídeo rápido explicando como te cadastrar na plataforma! 🎥');
            }
            else if (trigger_wa_video_ads && mediaSlots['wa_video_ads']) {
                await sendWhatsAppVideo(phone, await getFinalUrl(mediaSlots['wa_video_ads']), 'Fizemos este guia rápido para te mostrar como gerar criativos na Conversio AI! 🚀');
            }
            else if (trigger_wa_video_credits && mediaSlots['wa_video_credits']) {
                await sendWhatsAppVideo(phone, await getFinalUrl(mediaSlots['wa_video_credits']), 'Vê como é simples carregar a tua conta com Kwanzas pelo nosso portal:');
            }
            else if (trigger_wa_img_pricing && mediaSlots['wa_img_pricing']) {
                await sendWhatsAppImage(phone, await getFinalUrl(mediaSlots['wa_img_pricing']), 'Tabela de Créditos baseada no que gera mais lucro para a tua operação.');
            }
            else if (trigger_wa_img_support && mediaSlots['wa_img_support']) {
                await sendWhatsAppImage(phone, await getFinalUrl(mediaSlots['wa_img_support']), 'Nossa equipe de suporte humanizado está pronta para intervir quando precisares.');
            }
            if (is_qualified) {
                await this.performHandover(lead, extracted_data);
            }
        }
        catch (error) {
            console.error('[LeadAgent] Erro crítico ao processar lead:', error.message || error);
        }
    }
    static async performHandover(lead, data) {
        console.log(`[LeadAgent] 🎯 Lead Qualificado: ${lead.phone}. Iniciando Handover...`);
        try {
            const briefingPrompt = `Resuma em uma frase o que o cliente ${data.name} da empresa ${data.business_info} precisa (Foco: ${data.needs}).`;
            const { content: briefing } = await processWithOpenAI("Você é um assistente de briefing.", briefingPrompt, 'whatsappLeadAgent:handover', 'gpt-4o-mini', 'text');
            await query(`INSERT INTO admin_notifications (type, title, message, icon, color, reference_id, reference_type)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`, ['lead_qualified', '🎯 Novo Lead Qualificado', `O lead ${data.name} (${lead.phone}) foi qualificado automaticamente pela IA.`, '🎯', 'green', lead.id, 'whatsapp_lead']);
            await query(`UPDATE whatsapp_leads SET business_info = $1 WHERE id = $2`, [briefing, lead.id]);
            await query(`INSERT INTO agent_tasks (agent_name, task_type, payload, priority) VALUES ($1, $2, $3, $4)`, ['FunnelAgent', 'engage_lead', JSON.stringify({ leadId: lead.id, action: 'start_campaign', source: 'whatsapp', briefing }), 1]).catch(e => console.error('[LeadAgent] Erro ao agendar tarefa de Funil:', e.message));
            console.log(`[LeadAgent] ✅ Handover concluído com briefing: ${briefing}`);
        }
        catch (e) {
            console.error('[LeadAgent] Handover Error:', e.message);
        }
    }
}
