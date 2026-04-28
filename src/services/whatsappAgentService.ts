import axios from 'axios';
import { query } from '../db.js';

export const whatsappAgentService = {
  async getAdminConfig() {
    const result = await query('SELECT key, value FROM admin_configs WHERE key LIKE $1', ['agent_evolution_%']);
    const config: any = {};
    result.rows.forEach(row => {
        config[row.key] = row.value;
    });
    return {
      url: config.agent_evolution_url,
      key: config.agent_evolution_key,
      instance: config.agent_evolution_instance,
      active: config.agent_evolution_active === 'true'
    };
  },

  async sendMessage(number: string, text: string, instanceName?: string) {
    const config = await this.getAdminConfig();
    const targetInstance = instanceName || config.instance;
    
    if (!config.url || !config.key || !targetInstance || !config.active) {
      console.error('[WhatsAppAgentService] Dedicated Evolution API config missing or inactive');
      return { success: false, error: 'Configuração global de agentes ausente' };
    }

    try {
      let formattedNumber = number.replace(/\D/g, '');
      
      const response = await axios.post(
        `${config.url}/message/sendText/${targetInstance}`,
        {
          number: formattedNumber,
          options: {
            delay: 1200,
            presence: "composing",
            linkPreview: false
          },
          text: text
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'apikey': config.key
          }
        }
      );

      return { success: true, data: response.data };
    } catch (error: any) {
      const errorMsg = error.response?.data?.message || error.message;
      console.error('[WhatsAppAgentService] Error sending message:', errorMsg);
      return { success: false, error: errorMsg };
    }
  }
};
