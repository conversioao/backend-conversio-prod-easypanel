import { query } from '../db.js';
import { sendWhatsAppMessage, sendWhatsAppVideo } from './whatsappService.js';
import { keyManager } from './KeyManager.js';
import { processWithOpenAI } from '../utils/openai.js';

/**
 * Agente de Qualificação de Leads WhatsApp
 */
export class WhatsAppLeadAgent {
    
    /**
     * Processa uma mensagem recebida da Evolution API
     */
    static async handleIncomingMessage(remoteJid: string, pushName: string, text: string) {
        try {

            const phone = remoteJid.split('@')[0];
            console.log(`[LeadAgent] 📩 Mensagem de ${phone} (${pushName}): ${text}`);

            // 0. Ensure Memory and Promo Code tables exist
            await query(`
                CREATE TABLE IF NOT EXISTS whatsapp_memory (
                    id SERIAL PRIMARY KEY,
                    lead_id INTEGER,
                    fact TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                );
                CREATE TABLE IF NOT EXISTS promo_codes (
                    id SERIAL PRIMARY KEY,
                    code VARCHAR(50) UNIQUE NOT NULL,
                    discount_percentage INTEGER NOT NULL,
                    expires_at TIMESTAMP,
                    created_at TIMESTAMP DEFAULT NOW()
                );
            `).catch(() => {});

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
                const insertRes = await query(
                    'INSERT INTO whatsapp_leads (phone, name, status) VALUES ($1, $2, $3) RETURNING *',
                    [phone, pushName, 'new']
                );
                lead = insertRes.rows[0];
            } else {
                lead = leadRes.rows[0];
            }

            // 3. Verificar se a IA está ativa para este lead
            if (!lead.agent_active) {
                console.log(`[LeadAgent] 😴 Agente inativo para este lead (modo humano).`);
                return;
            }

            // 4. Salvar mensagem do utilizador no histórico
            await query(
                'INSERT INTO whatsapp_messages (lead_id, role, content) VALUES ($1, $2, $3)',
                [lead.id, 'user', text]
            );

            // 5. Obter histórico recente para contexto
            const historyRes = await query(
                'SELECT role, content FROM whatsapp_messages WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 15',
                [lead.id]
            );
            const historyMessages = historyRes.rows.reverse();

            // 5.1 Obter Memória de Longo Prazo
            const memoryRes = await query(
                'SELECT fact FROM whatsapp_memory WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 20',
                [lead.id]
            );
            const longTermMemory = memoryRes.rows.map(r => r.fact).join('\n');
            
            const systemPromptRes = await query("SELECT value FROM system_settings WHERE key = 'whatsapp_agent_prompt'");
            const mediaRes = await query(`SELECT slot_id, media_url FROM landing_media WHERE slot_id LIKE 'wa_%'`);
            const mediaSlots = mediaRes.rows.reduce((acc: any, row: any) => ({ ...acc, [row.slot_id]: row.media_url }), {});

            const basePrompt = systemPromptRes.rows[0]?.value || `Você é o Alex, especialista em sucesso do cliente da Conversio AI. Seu tom de voz é de Angola (informal-profissional). É caloroso, especialista e focado em converter leads angolanos.`;
            
            // CONHECIMENTO ADICIONAL SOBRE AGENTES (Video Cores & Image Cores)
            const knowledgeCores = `
AGENTES DE VÍDEO (Video Cores):
- REELANGOLA UGC: Estilo Reels/TikTok, altamente autêntico, parece filmado por uma pessoa real. Ideal para confiança.
- VIBRA PREMIUM: Estilo luxo, editorial, macros cinematográficos. Para marcas de elite.
- CINEMATIC VFX: Épico, com efeitos visuais e movimento dinâmico. Para parar o scroll.

AGENTES DE IMAGEM (Image Cores):
- REELANGOLA UGC: Fotos reais, lifestyle urbano em Luanda.
- LUANDALOOKS AGENT: Editorial de moda, street style premium.
- GLOWANGOLA PRO: Foco em beleza, cosmética e detalhes de pele.
- VIBRA ANGOLA: Design de alto impacto, 3D e surrealismo tecnológico.
`;

            const systemContext = `
${basePrompt}

━━━ EXPERTISE ADICIONAL ━━━
${knowledgeCores}

━━━ MEMÓRIA DE LONGO PRAZO DO CLIENTE ━━━
${longTermMemory || 'Ainda não há dados antigos guardados.'}

━━━ DADOS ATUAIS DO LEAD (PARA MEMÓRIA) ━━━
- Nome: ${lead.name || 'Desconhecido'}
- Negócio: ${lead.business_info || 'Ainda não identificado'}
- Necessidade: ${lead.needs || 'Ainda não identificado'}

INSTRUÇÕES DE RESPOSTA (JSON):
Responda APENAS com um JSON no formato:
{
  "reply": "Texto para o WhatsApp (seja natural, use a memória e o histórico)",
  "extracted_data": {
    "name": "nome se identificado",
    "business_info": "ramo se identificado",
    "needs": "necessidade se identificada"
  },
  "new_memories_to_save": ["facto importante 1", "facto importante 2"],
  "is_qualified": boolean,
  "trigger_discount_negotiation": true/false,
  "trigger_social_media_publish": true/false,
  "trigger_wa_video_account": true/false,
  "trigger_wa_video_ads": true/false,
  "trigger_wa_video_credits": true/false,
  "trigger_wa_img_pricing": true/false,
  "trigger_wa_img_support": true/false
}

GATILHOS AVANÇADOS (CLOSER & SOCIAL MEDIA):
- trigger_discount_negotiation: ative APENAS se o lead reclamar do preço, disser que está caro ou pedir um desconto.
- trigger_social_media_publish: ative APENAS se o lead perguntar se dá para publicar/postar diretamente no Instagram/TikTok.

GATILHOS DE VÍDEO E IMAGEM (MÍDIA DINÂMICA):
ATENÇÃO: VOCÊ SÓ DEVE ATIVAR ESTES GATILHOS SE O UTILIZADOR PEDIR EXPLICITAMENTE. NÃO ENVIE VÍDEOS OU IMAGENS EM CONVERSAS CASUAIS OU DE BOAS VINDAS.
- trigger_wa_video_account: ativar APENAS se o lead usar termos como "como criar a conta", "como me registar", "como acessar".
- trigger_wa_video_ads: ativar APENAS se o lead usar termos como "como gerar anúncios", "como gerar imagens", "como usar a plataforma".
- trigger_wa_video_credits: ativar APENAS se o lead usar termos como "como comprar créditos", "como carregar a conta", "como pagar em kwanzas".
- trigger_wa_img_pricing: ativar APENAS se o lead pedir diretamente "quais são os planos", "tabela de preços", "quanto custa".
- trigger_wa_img_support: ativar APENAS se o lead disser que quer "falar com humano", "falar com suporte" ou reportar um problema técnico grave.
Para qualquer outra situação, deixe os gatilhos como false.
`;

            // Formatar histórico para OpenAI
            const messages = historyMessages.map(m => ({
                role: m.role === 'agent' ? 'assistant' : 'user',
                content: m.content
            }));
            
            // Adicionar a mensagem atual se não estiver no histórico (LIMIT 10 pode ter cortado)
            // Mas handleIncomingMessage já salvou no histórico acima (passo 4)
            // Então historyRes terá a mensagem atual se for executado depois do INSERT? 
            // Não, historyRes foi executado antes do INSERT da resposta do agente, mas depois do INSERT do user.
            
            const { content: rawResult } = await processWithOpenAI(
                systemContext,
                messages, // Passando o array de histórico completo
                'whatsappLeadAgent:chat',
                'gpt-4o',
                'json_object'
            );

            const result = JSON.parse(rawResult || '{}');

            let finalReply = result.reply;
            const { 
                extracted_data, is_qualified, new_memories_to_save,
                trigger_discount_negotiation, trigger_social_media_publish,
                trigger_wa_video_account, trigger_wa_video_ads, trigger_wa_video_credits, 
                trigger_wa_img_pricing, trigger_wa_img_support 
            } = result;

            // 6.1 Salvar novas memórias
            if (new_memories_to_save && Array.isArray(new_memories_to_save)) {
                for (const memory of new_memories_to_save) {
                    await query('INSERT INTO whatsapp_memory (lead_id, fact) VALUES ($1, $2)', [lead.id, memory]).catch(() => {});
                }
            }

            // 6.2 Agente Closer: Gerar Desconto
            if (trigger_discount_negotiation) {
                const discountCode = `FLASH-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
                await query("INSERT INTO promo_codes (code, discount_percentage, expires_at) VALUES ($1, $2, NOW() + INTERVAL '2 hours')", [discountCode, 15]).catch(() => {});
                finalReply += `\n\n🎁 *BÓNUS EXCLUSIVO*: Falei com a minha gerência (IA) e consegui um desconto de 15% para ti! Usa o código *${discountCode}* no painel nas próximas 2 horas.`;
            }

            // 6.3 Social Media Agent Hook
            if (trigger_social_media_publish) {
                finalReply += `\n\n📱 *Aviso*: A publicação direta no Instagram/TikTok está em versão Beta e ficará disponível em breve. Por agora, podes gerar e baixar o vídeo no nosso painel e postar manualmente!`;
            }

            // 7. Atualizar dados do Lead
            await query(
                `UPDATE whatsapp_leads SET 
                    name = COALESCE($1, name),
                    business_info = COALESCE($2, business_info),
                    needs = COALESCE($3, needs),
                    status = $4,
                    last_interaction = NOW()
                WHERE id = $5`,
                [extracted_data?.name, extracted_data?.business_info, extracted_data?.needs, is_qualified ? 'qualified' : 'in_progress', lead.id]
            );

            // 8. Salvar resposta
            await query(
                'INSERT INTO whatsapp_messages (lead_id, role, content) VALUES ($1, $2, $3)',
                [lead.id, 'agent', finalReply]
            );

            // 9. Enviar mensagem
            // Delay mais humano: 8-15 segundos para dar tempo de "digitar" uma resposta curta a média
            const typingDelayMs = Math.floor(Math.random() * (15000 - 8000 + 1)) + 8000;
            await sendWhatsAppMessage(phone, finalReply, 'agent_action', typingDelayMs);

            const getFinalUrl = async (url: string) => {
                if (url && url.includes('contabostorage.com')) {
                    try {
                        const { getSignedS3UrlForKey } = await import('../storage.js');
                        return await getSignedS3UrlForKey(url, 3600);
                    } catch(e) { return url; }
                }
                if (url && url.startsWith('/')) {
                    return `https://conversio.ao${url}`;
                }
                return url;
            };

            const { sendWhatsAppImage } = await import('./whatsappService.js');
            if (trigger_wa_video_account && mediaSlots['wa_video_account']) {
                await sendWhatsAppVideo(phone, await getFinalUrl(mediaSlots['wa_video_account']), 'Aqui tens um vídeo rápido explicando como te cadastrar na plataforma! 🎥');
            } else if (trigger_wa_video_ads && mediaSlots['wa_video_ads']) {
                await sendWhatsAppVideo(phone, await getFinalUrl(mediaSlots['wa_video_ads']), 'Fizemos este guia rápido para te mostrar como gerar criativos na Conversio AI! 🚀');
            } else if (trigger_wa_video_credits && mediaSlots['wa_video_credits']) {
                await sendWhatsAppVideo(phone, await getFinalUrl(mediaSlots['wa_video_credits']), 'Vê como é simples carregar a tua conta com Kwanzas pelo nosso portal:');
            } else if (trigger_wa_img_pricing && mediaSlots['wa_img_pricing']) {
                await sendWhatsAppImage(phone, await getFinalUrl(mediaSlots['wa_img_pricing']), 'Tabela de Créditos baseada no que gera mais lucro para a tua operação.');
            } else if (trigger_wa_img_support && mediaSlots['wa_img_support']) {
                await sendWhatsAppImage(phone, await getFinalUrl(mediaSlots['wa_img_support']), 'Nossa equipe de suporte humanizado está pronta para intervir quando precisares.');
            }

            if (is_qualified) {
                await this.performHandover(lead, extracted_data);
            }

        } catch (error: any) {
            console.error('[LeadAgent] Erro crítico ao processar lead:', error.message || error);
        }

    }

    static async performHandover(lead: any, data: any) {
        console.log(`[LeadAgent] 🎯 Lead Qualificado: ${lead.phone}. Iniciando Handover...`);

        try {
            const briefingPrompt = `Resuma em uma frase o que o cliente ${data.name} da empresa ${data.business_info} precisa (Foco: ${data.needs}).`;
            const { content: briefing } = await processWithOpenAI(
                "Você é um assistente de briefing.",
                briefingPrompt,
                'whatsappLeadAgent:handover',
                'gpt-4o-mini',
                'text'
            );

            await query(
                `INSERT INTO admin_notifications (type, title, message, icon, color, reference_id, reference_type)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                ['lead_qualified', '🎯 Novo Lead Qualificado', `O lead ${data.name} (${lead.phone}) foi qualificado automaticamente pela IA.`, '🎯', 'green', lead.id, 'whatsapp_lead']
            );

            await query(
                `UPDATE whatsapp_leads SET business_info = $1 WHERE id = $2`,
                [briefing, lead.id]
            );

            // Inject into main CRM Funnel
            const crmLeadRes = await query(
                `INSERT INTO leads (user_id, status, temperature, score, needs, next_action_date, tags)
                 VALUES (
                    (SELECT id FROM users WHERE whatsapp LIKE '%' || $1 || '%' LIMIT 1),
                    'novo', 'hot', 80, $2, NOW(), '["whatsapp_inbound"]'
                 )
                 RETURNING id`,
                [lead.phone, briefing]
            );
            const crmLeadId = crmLeadRes.rows[0]?.id;

            await query(
                `INSERT INTO agent_tasks (agent_name, task_type, payload, priority) VALUES ($1, $2, $3, $4)`,
                ['FunnelAgent', 'engage_lead', JSON.stringify({ leadId: crmLeadId, waLeadId: lead.id, phone: lead.phone, action: 'start_campaign', source: 'whatsapp', briefing }), 1]
            ).catch(e => console.error('[LeadAgent] Erro ao agendar tarefa de Funil:', e.message));

            console.log(`[LeadAgent] ✅ Handover concluído com CRM Lead ID: ${crmLeadId} e briefing: ${briefing}`);
        } catch (e: any) {
            console.error('[LeadAgent] Handover Error:', e.message);
        }
    }
}

