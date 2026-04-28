import { query } from '../db.js';

interface AgentResolution {
    userId: string;
    agentConfig: any;
    catalog: any;
}

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache: { [key: string]: { data: AgentResolution | null, expires: number } } = {};

/**
 * resolveAgent
 * 1. Recebe o número de destino da mensagem WhatsApp
 * 2. Consulta agent_routing WHERE whatsapp_number = toNumber AND is_active = true
 * 3. Se não encontrar: retorna null (mensagem ignorada)
 * 4. Se encontrar: carrega agent_configs + agent_catalogs do user_id
 * 5. Retorna { userId, agentConfig, catalog }
 */
export async function resolveAgent(toNumber: string): Promise<AgentResolution | null> {
    const now = Date.now();
    
    // Check Cache
    if (cache[toNumber] && cache[toNumber].expires > now) {
        console.log(`[AgentRouter] Cache hit for ${toNumber}`);
        return cache[toNumber].data;
    }

    try {
        console.log(`[AgentRouter] Resolving agent for number: ${toNumber}`);
        
        // 1. Get routing info
        const routingResult = await query(
            `SELECT r.user_id, r.agent_config_id 
             FROM agent_routing r
             JOIN agent_configs c ON r.agent_config_id = c.id
             WHERE (r.whatsapp_number = $1 OR c.agent_name = $1) 
             AND r.is_active = true`,
            [toNumber]
        );

        if (routingResult.rows.length === 0) {
            console.log(`[AgentRouter] No active agent found for ${toNumber}`);
            cache[toNumber] = { data: null, expires: now + CACHE_TTL };
            return null;
        }

        const { user_id, agent_config_id } = routingResult.rows[0];

        // 2. Get agent config
        const configResult = await query(
            'SELECT * FROM agent_configs WHERE id = $1 AND is_active = true',
            [agent_config_id]
        );

        if (configResult.rows.length === 0) {
            console.log(`[AgentRouter] Agent config ${agent_config_id} is not active or missing.`);
            cache[toNumber] = { data: null, expires: now + CACHE_TTL };
            return null;
        }

        const agentConfig = configResult.rows[0];

        // 3. Get latest catalog
        const catalogResult = await query(
            'SELECT * FROM agent_catalogs WHERE agent_config_id = $1 ORDER BY uploaded_at DESC LIMIT 1',
            [agent_config_id]
        );

        const catalog = catalogResult.rows[0] || null;

        const resolution: AgentResolution = {
            userId: user_id,
            agentConfig,
            catalog
        };

        // Update Cache
        cache[toNumber] = { data: resolution, expires: now + CACHE_TTL };
        
        console.log(`[AgentRouter] Successfully resolved agent for ${toNumber} (User: ${user_id})`);
        return resolution;

    } catch (err: any) {
        console.error(`[AgentRouter] Error resolving agent for ${toNumber}:`, err.message);
        return null;
    }
}
