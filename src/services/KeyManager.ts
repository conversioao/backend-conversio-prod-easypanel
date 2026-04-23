import { query } from '../db.js';
import { sendWhatsAppMessage } from './whatsappService.js';
import { getAdminWhatsApp } from './configService.js';

export interface ApiKey {
    id: number;
    provider: 'openai' | 'kie';
    key_secret: string;
    priority: number;
    status: 'working' | 'failed';
}

export class KeyManager {
    private static instance: KeyManager;
    private keyCache: Map<string, ApiKey[]> = new Map();

    private constructor() {}

    public static getInstance(): KeyManager {
        if (!KeyManager.instance) {
            KeyManager.instance = new KeyManager();
        }
        return KeyManager.instance;
    }

    /**
     * Gets the best available working key for a provider
     */
    public async getWorkingKey(provider: 'openai' | 'kie'): Promise<ApiKey | null> {
        try {
            const res = await query(
                `SELECT id, provider, key_secret, priority, status 
                 FROM api_keys 
                 WHERE provider = $1 AND is_active = true AND status = 'working'
                 ORDER BY priority ASC, updated_at DESC
                 LIMIT 1`,
                [provider]
            );

            if (res.rows.length === 0) {
                console.error(`[KeyManager] ❌ No working keys found for provider: ${provider}`);
                await this.notifyCriticalFailure(provider);
                return null;
            }

            const key = res.rows[0];
            
            // Record usage (async)
            query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [key.id]).catch(() => {});
            
            return key;
        } catch (error: any) {
            console.error(`[KeyManager] Error fetching key:`, error.message);
            return null;
        }
    }

    /**
     * Reports a failure for a key and triggers failover
     */
    public async reportFailure(keyId: number, error: string) {
        try {
            const res = await query(
                `UPDATE api_keys 
                 SET status = 'failed', is_active = false, last_error = $1, updated_at = NOW() 
                 WHERE id = $2 
                 RETURNING provider, priority`,
                [error, keyId]
            );

            if (res.rows.length > 0) {
                const { provider, priority } = res.rows[0];
                console.warn(`[KeyManager] ⚠️ Key ${keyId} (Priority ${priority}) for ${provider} marked as FAILED: ${error}`);
                
                // Notify via WhatsApp
                const adminPhone = await getAdminWhatsApp();
                if (adminPhone) {
                    await sendWhatsAppMessage(
                        adminPhone,
                        `⚠️ *Alerta de Redundância API*\n\nA chave *${provider.toUpperCase()}* de prioridade ${priority} falhou!\n\n*Erro:* ${error.substring(0, 100)}\n\nO sistema tentou alternar para a chave seguinte automaticamente.`
                    );
                }
            }
        } catch (err: any) {
            console.error(`[KeyManager] Error reporting failure:`, err.message);
        }
    }

    /**
     * Records usage stats for cost tracking and deducts from service budget
     */
    public async logUsage(keyId: number | null, provider: string, agentName: string, tokensPrompt: number, tokensCompletion: number, cost: number) {
        try {
            // Convert Kie.ai credits to estimated USD cost for reports (1 credit = $0.005)
            const KIE_USD_RATE = 0.005;
            const costEstimatedDollar = provider === 'kie' ? cost * KIE_USD_RATE : cost;

            // 1. Log to history table
            await query(
                `INSERT INTO api_usage_stats (key_id, provider, agent_name, tokens_prompt, tokens_completion, cost_estimated)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [keyId, provider, agentName, tokensPrompt, tokensCompletion, costEstimatedDollar]
            );

            // 2. Deduct from service balance
            if (provider === 'openai') {
                await query(
                    `UPDATE service_budgets 
                     SET dollar_balance = dollar_balance - $1, 
                         updated_at = NOW() 
                     WHERE service = 'openai'`,
                    [cost]
                );
            } else if (provider === 'kie') {
                // Kie.ai costs are in credits (cost parameter here is credits)
                await query(
                    `UPDATE service_budgets 
                     SET credit_balance = credit_balance - $1, 
                         updated_at = NOW() 
                     WHERE service = 'kie'`,
                    [cost]
                );
            }
        } catch (err: any) {
            console.error(`[KeyManager] Error logging usage and updating budget:`, err.message);
        }
    }

    private async notifyCriticalFailure(provider: string) {
        const adminPhone = await getAdminWhatsApp();
        if (adminPhone) {
            await sendWhatsAppMessage(
                adminPhone,
                `🚨 *ERRO CRÍTICO: SEM CHAVES API*\n\nTodas as chaves da *${provider.toUpperCase()}* falharam ou estão desativadas!\n\nA plataforma está agora sem capacidade de processar tarefas de IA.`
            );
        }
    }
}

export const keyManager = KeyManager.getInstance();
