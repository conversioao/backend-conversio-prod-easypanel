import OpenAI from 'openai';
import { getOpenAIKey, GPT4O_MINI_PRICING } from '../config.js';
import { query } from '../db.js';
import { keyManager } from './KeyManager.js';
import { agentRealtimeService } from './agentRealtime.service.js';

export class AgentCore {
  /**
   * processMessage
   * Gera a resposta do agente usando OpenAI GPT-4o mini e processa tags de intenção.
   */
  static async processMessage(params: {
    agentConfig: any;
    catalog: any;
    conversationHistory: any[];
    messageText: string;
    contactId: number;
    userId: string;
  }): Promise<string> {
    const { agentConfig, catalog, conversationHistory, messageText, contactId, userId } = params;
    
    // 0. Verificar créditos e assinatura
    const creditsRes = await query('SELECT message_credits, subscription_status, paid_until FROM agent_configs WHERE user_id = $1', [userId]);
    const userCredits = creditsRes.rows[0];
    
    if (!userCredits || userCredits.message_credits <= 0) {
        return "⚠️ O seu agente está sem créditos de mensagens. Por favor, recarregue no painel Conversio.";
    }
    
    const now = new Date();
    if (userCredits.subscription_status !== 'active' || (userCredits.paid_until && new Date(userCredits.paid_until) < now)) {
        return "⚠️ A assinatura do seu agente expirou. Por favor, regularize no painel Conversio.";
    }

    const apiKeyObj = await getOpenAIKey();
    if (!apiKeyObj) {
      throw new Error('[AgentCore] No working OpenAI API key available.');
    }

    const openai = new OpenAI({
      apiKey: apiKeyObj.key_secret,
      timeout: 30000
    });

    // Formatar catálogo para texto
    const catalogText = (catalog?.processed_data || []).map((p: any) => 
        `- ${p.name}: ${p.price ? p.price + ' ' + (p.unit || 'AOA') : 'Preço sob consulta'} (${p.category || 'Geral'})`
    ).join('\n');

    const systemPrompt = `
És ${agentConfig.agent_name}, um assistente de atendimento WhatsApp altamente eficiente e focado em vendas.
${agentConfig.custom_prompt}
Tom de voz: ${agentConfig.tone}
Idioma: ${agentConfig.language}
Palavras proibidas: ${agentConfig.forbidden_words && agentConfig.forbidden_words.length > 0 ? agentConfig.forbidden_words.join(', ') : 'Nenhuma'}

### CATÁLOGO DE PRODUTOS DISPONÍVEIS:
${catalogText || 'Nenhum produto cadastrado no momento.'}

### INSTRUÇÕES DE COMPORTAMENTO:
1. Responde APENAS sobre os produtos e serviços no catálogo acima.
2. Se o cliente pedir algo fora do catálogo, informa gentilmente que não trabalhas com esse item.
3. Quando identificares intenção clara de compra (o cliente escolheu um produto e quantidade), inclui obrigatoriamente no FIM da tua resposta a tag: [PURCHASE_INTENT: produto=NOME_PRODUTO, qty=QUANTIDADE, price=PRECO_TOTAL]
4. Quando o cliente solicitar falar com um humano ou estiver muito insatisfeito: inclui no fim a tag: [ESCALATE]
5. Classifica o cliente no fim de cada resposta com: [LEAD_STATUS: cold|warm|hot|negotiation|closed]
   - cold: curiosidade inicial
   - warm: demonstrou interesse real
   - hot: pronto para comprar
   - negotiation: a discutir detalhes/preço
   - closed: venda finalizada ou desistência definitiva

### REGRAS DE WHATSAPP:
- Sê curto e direto.
- Usa emojis para ser amigável.
- Nunca inventes informações que não estão no catálogo.

Hoje é ${new Date().toLocaleDateString('pt-PT')}.
`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory.map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.content
      })).slice(-20),
      { role: 'user', content: messageText }
    ];

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messages as any,
        temperature: 0.7,
        max_tokens: 1024
      });

      if (response.usage) {
        await keyManager.logUsage(
            apiKeyObj.id, 'openai', 'AgentCore',
            response.usage.prompt_tokens, response.usage.completion_tokens,
            (response.usage.prompt_tokens * GPT4O_MINI_PRICING.input) + (response.usage.completion_tokens * GPT4O_MINI_PRICING.output)
        );
      }

      let rawResponse = response.choices[0].message.content || '';
      
      // PÓS-PROCESSAMENTO
      
      // 1. Extrair PURCHASE_INTENT
      const purchaseMatch = rawResponse.match(/\[PURCHASE_INTENT: (.*?)\]/);
      if (purchaseMatch) {
          const content = purchaseMatch[1];
          const data: any = {};
          
          // Regex mais robusto para extrair k=v mesmo com vírgulas/espaços
          content.split(',').forEach(part => {
              const [k, v] = part.trim().split('=');
              if (k && v) data[k] = v;
          });
          
          if (data.produto) {
              // Criar Ordem Pendente
              const orderRes = await query(`
                  INSERT INTO agent_orders (contact_id, user_id, agent_config_id, product_name, quantity, price, status)
                  VALUES ($1, $2, $3, $4, $5, $6, 'pending')
                  RETURNING id
              `, [contactId, userId, agentConfig.id, data.produto, parseInt(data.qty) || 1, parseFloat(data.price) || 0]);

              agentRealtimeService.pushEvent(userId, {
                  type: 'new_order_alert',
                  orderId: orderRes.rows[0].id,
                  productName: data.produto,
                  quantity: parseInt(data.qty) || 1,
                  totalValue: parseFloat(data.price) || 0,
                  clientName: agentConfig.agent_name
              });
          }
          
          rawResponse = rawResponse.replace(purchaseMatch[0], '');
      }

      // 2. Extrair LEAD_STATUS
      const statusMatch = rawResponse.match(/\[LEAD_STATUS: (.*?)\]/);
      if (statusMatch) {
          const newStatus = statusMatch[1].trim();
          await query(`UPDATE agent_contacts SET status = $1, last_message_at = now() WHERE id = $2`, [newStatus, contactId]);
          
          agentRealtimeService.pushEvent(userId, {
              type: 'lead_updated',
              contactId,
              newStatus
          });

          rawResponse = rawResponse.replace(statusMatch[0], '');
      }

      // 3. Extrair ESCALATE
      const escalateMatch = rawResponse.match(/\[ESCALATE\]/);
      if (escalateMatch) {
          await query(`UPDATE agent_contacts SET needs_human = true WHERE id = $1`, [contactId]);
          rawResponse = rawResponse.replace(escalateMatch[0], '');
      }

      // 4. Descontar créditos
      await query('UPDATE agent_configs SET message_credits = message_credits - 1 WHERE user_id = $1', [userId]);

      return rawResponse.trim();

    } catch (err: any) {
      console.error('[AgentCore] OpenAI Error:', err.message);
      throw err;
    }
  }
}
