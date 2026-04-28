import { query } from '../db.js';
import { triggerAlert } from './monitorAgent.js';
import { runFullBackup } from '../backup_database.js';

/**
 * Agente de Monitorização Financeira e Operational Conversio AI
 */

export const runFinancialMonitor = async () => {
    console.log('[Financial Agent] 🔍 Iniciando monitorização financeira e operacional...');

    try {
        // 1. Verificar Balanços de Serviços (OpenAI e Kie.ai)
        const budgetsRes = await query(`SELECT * FROM service_budgets`);
        const budgets = budgetsRes.rows;

        for (const budget of budgets) {
            let consumption = 0;
            let label = '';
            let balance = 0;

            if (budget.service === 'openai') {
                if (Number(budget.dollar_purchased) > 0) {
                    consumption = (Number(budget.dollar_purchased) - Number(budget.dollar_balance)) / Number(budget.dollar_purchased);
                }
                label = 'OpenAI (Dólares)';
                balance = Number(budget.dollar_balance);
            } else if (budget.service === 'kie') {
                if (Number(budget.credit_purchased) > 0) {
                    consumption = (Number(budget.credit_purchased) - Number(budget.credit_balance)) / Number(budget.credit_purchased);
                }
                label = 'Kie.ai (Créditos)';
                balance = Number(budget.credit_balance);
            }

            // Regra: Alerta se consumo > 80%
            if (consumption >= 0.8) {
                const alertType = `budget_threshold_${budget.service}`;
                
                // Verificar se já alertamos nas últimas 24h para este nível de consumo
                const recentAlert = await query(`
                    SELECT id FROM alerts 
                    WHERE type = $1 AND created_at > NOW() - INTERVAL '24 hours'
                `, [alertType]);

                if (recentAlert.rowCount === 0) {
                    const pct = (consumption * 100).toFixed(1);
                    console.warn(`[Financial Agent] ⚠️ Alerta de Consumo: ${label} em ${pct}%`);
                    
                    await triggerAlert(
                        alertType,
                        'critical',
                        `💰 ALERTA FINANCEIRO: ${label}`,
                        `O consumo do serviço ${label} atingiu ${pct}%. \nSaldo Restante: ${balance.toFixed(2)}. \n\nAcção Automatizada: Iniciando Backup Preventivo da Base de Dados.`,
                        { service: budget.service, consumption, balance }
                    );

                    // GATILHO DE BACKUP AUTOMÁTICO
                    console.log(`[Financial Agent] 💾 Gatilho de Backup atingido (${pct}% consumo). Iniciando...`);
                    await runFullBackup().catch(e => console.error('[Financial Agent] Erro no backup automático:', e));
                }
            }
        }

        // 2. Verificar Saúde das APIs (Chaves falhadas)
        const failedKeysRes = await query(`
            SELECT provider, name, last_error 
            FROM api_keys 
            WHERE status = 'failed' AND updated_at > NOW() - INTERVAL '1 hour'
        `);

        if (failedKeysRes.rowCount! > 0) {
            for (const key of failedKeysRes.rows) {
                await triggerAlert(
                    'api_key_failure_detected',
                    'critical',
                    `🚨 FALHA DE API: ${key.provider.toUpperCase()}`,
                    `A chave "${key.name}" do provedor ${key.provider} falhou recentemente.\nErro: ${key.last_error}`,
                    { provider: key.provider, name: key.name, error: key.last_error }
                );
            }
        }

    } catch (error: any) {
        console.error('[Financial Agent] Erro na monitorização:', error.message);
    }
};
