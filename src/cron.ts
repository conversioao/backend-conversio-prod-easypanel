import cron from 'node-cron';
import { query } from './db.js';
import * as agentService from './services/agentService.js';
import * as orchestrator from './services/orchestrator.js';
import * as funnelAgent from './services/funnelAgent.js';
import * as campaignsAgent from './services/campaignsAgent.js';
import * as recoveryAgent from './services/recoveryAgent.js';
import * as monitorAgent from './services/monitorAgent.js';
import * as reportService from './services/reportService.js';
import * as retargetingService from './services/retargetingService.js';
import * as smartOrchestrator from './services/smartOrchestrator.js';
import * as postSaleAgent from './services/postSaleAgent.js';
import * as customerSuccessAgent from './services/customerSuccessAgent.js';
import * as abTestingAgent from './services/abTestingAgent.js';
import * as evolutionWatchdog from './services/evolutionWatchdog.js';

// ─────────────────────────────────────────────────────────────
// CRON PIPELINE — Equipa Autónoma Conversio AI
// Todos os horários em fuso de Angola (UTC+1)
// ─────────────────────────────────────────────────────────────

const SERVICE_TYPE = process.env.SERVICE_TYPE || 'BACKEND';

if (SERVICE_TYPE !== 'BACKEND') {
    console.log('[CRON] ⚠️ Ignorando inicialização de agentes (Não é o BACKEND).');
} else {

// ── AGENTE 1 (Boas-Vindas): todos os dias às 08:00
// Processa utilizadores que se registaram hoje
cron.schedule('0 8 * * *', async () => {
    console.log('[CRON 08:00] 👋 Agente de Boas-Vindas (Day 0)...');
    await agentService.runWelcomeAgent().catch(e => console.error('[CRON] Welcome error:', e));
});

// ── AGENTE 2 (Ativação): todos os dias às 09:00
// Processa utilizadores que se registaram há exactamente 1 dia
cron.schedule('0 9 * * *', async () => {
    console.log('[CRON 09:00] ⚡ Agente de Ativação (Day 1)...');
    await agentService.runDayNAgent(1).catch(e => console.error('[CRON] Day1 error:', e));
});

// ── AGENTE 3 (Conversão): todos os dias às 10:00
// Processa utilizadores que se registaram há exactamente 3 dias
cron.schedule('0 10 * * *', async () => {
    console.log('[CRON 10:00] 💎 Agente de Conversão (Day 3)...');
    await agentService.runDayNAgent(3).catch(e => console.error('[CRON] Day3 error:', e));
});

// ── AGENTE 4 (Urgência): todos os dias às 11:00
// Utilizadores em plano gratuito há ≥ 5 dias
cron.schedule('0 11 * * *', async () => {
    console.log('[CRON 11:00] 🔥 Agente de Urgência (Free Day 5)...');
    await agentService.runFreePlanDay5Agent().catch(e => console.error('[CRON] Day5 error:', e));
});

// ── AGENTE 5 (Retenção): todos os dias às 11:30
// Utilizadores em plano gratuito há ≥ 10 dias
cron.schedule('30 11 * * *', async () => {
    console.log('[CRON 11:30] 🤝 Agente de Retenção (Free Day 10)...');
    await agentService.runFreePlanDay10Agent().catch(e => console.error('[CRON] Day10 error:', e));
});

// ── Boas-vindas em tempo real: também roda a cada hora
// Para apanhar utilizadores que se registaram durante o dia
cron.schedule('0 * * * *', async () => {
    await agentService.runWelcomeAgent().catch(e => console.error('[CRON] Hourly welcome error:', e));
});

// ── ORQUESTRADOR CENTRAL ──
// Distribui as tarefas de the queue consoante a prioridade e previne overlap (cada 5 min)
cron.schedule('*/5 * * * *', async () => {
    await orchestrator.runOrchestrator().catch(e => console.error('[CRON] Orchestrator error:', e));
});


// Reseta agentes pausados e falhas diariamente às 06:00
cron.schedule('0 6 * * *', async () => {
    await orchestrator.resumeAllAgents().catch(e => console.error('[CRON] Rescue error:', e));
});

// ── AGENTE FUNIL (Hourly Scan) ──
// Varrimento de Leads para nutrição contínua
cron.schedule('0 * * * *', async () => {
    await funnelAgent.runFunnelAgent().catch(e => console.error('[CRON] Funnel scan error:', e));
});

// ── AGENTE FUNIL (Daily Recalculate) ──
// Recálculo global do Score (madrugada)
cron.schedule('30 2 * * *', async () => {
    await funnelAgent.recalculateAllActiveLeads().catch(e => console.error('[CRON] Funnel recalculate error:', e));
});

// ── AGENTE CAMPANHAS (Batch Processing) ──
// Processa lotes de campanhas activas a cada 10 minutos
cron.schedule('*/10 * * * *', async () => {
    await campaignsAgent.runCampaignsAgent().catch(e => console.error('[CRON] Campaigns agent error:', e));
});


// ── AGENTE RECUPERAÇÃO (Monitoring & Sequences) ──
// Processa sequências de recuperação a cada 6 horas
cron.schedule('0 */6 * * *', async () => {
    await recoveryAgent.runRecoveryAgent().catch(e => console.error('[CRON] Recovery agent error:', e));
});

// Reavaliação Diária de Risco de Churn às 01:00 AM
cron.schedule('0 1 * * *', async () => {
    await recoveryAgent.updateAllChurnRisks().catch(e => console.error('[CRON] Daily churn risk update error:', e));
});

// ── AGENTE MONITOR (Health & Surveillance) ──
// Ciclo de monitorização a cada 5 minutos (ajustado para resposta rápida - Saldo/Instabilidade)
cron.schedule('*/5 * * * *', async () => {
    await monitorAgent.runMonitorAgent().catch(e => console.error('[CRON] Monitor agent error:', e));
});

// Resumo Diário para o Admin às 08:00 AM
cron.schedule('0 8 * * *', async () => {
    await monitorAgent.sendDailySummary().catch(e => console.error('[CRON] Daily summary error:', e));
    await reportService.generateDailyDigest().catch(e => console.error('[CRON] Daily digest error:', e));
});

// ── RELATÓRIO SEMANAL ──
// Toda segunda-feira às 07:00 AM
cron.schedule('0 7 * * 1', async () => {
    console.log('[CRON 07:00] 📊 Gerando Relatório Semanal...');
    await reportService.generateWeeklyReport().catch(e => console.error('[CRON] Weekly report error:', e));
});

// ── RETARGETING SYNC ──
// Monitoramento e sincronização de audiências diariamente à meia-noite
cron.schedule('0 0 * * *', async () => {
    console.log('[CRON 00:00] 🎯 Sincronizando audiências de retargeting...');
    await retargetingService.updateRetargetingAudiences().catch(e => console.error('[CRON] Retargeting sync error:', e));
});

// ── ORQUESTRADOR INTELIGENTE (Análise + Planos de Ação) ──
// Análise do sistema e geração de novos planos a cada 6 horas
cron.schedule('0 */6 * * *', async () => {
    console.log('[CRON */6h] 🧠 Orquestrador Inteligente — Análise e Planos de Ação...');
    await smartOrchestrator.runSmartOrchestrator().catch(e => console.error('[CRON] Smart Orchestrator error:', e));
});

// Execução de planos aprovados — verificação a cada 5 min (como fallback do trigger em tempo real)
cron.schedule('*/5 * * * *', async () => {
    await smartOrchestrator.executeApprovedPlans().catch(e => console.error('[CRON] Execute approved plans error:', e));
});

// ── AGENTE PÓS-VENDA (Post-Sale) ──
// Activação de clientes pagos, marcos de sucesso e upsell de créditos baixos
// Roda 2x por dia: às 09:30 e às 15:30
cron.schedule('30 9 * * *', async () => {
    console.log('[CRON 09:30] 🎯 Agente Pós-Venda (Ciclo Manhã)...');
    await postSaleAgent.runPostSaleAgent().catch(e => console.error('[CRON] Post-Sale Agent error:', e));
});
cron.schedule('30 15 * * *', async () => {
    console.log('[CRON 15:30] 🎯 Agente Pós-Venda (Ciclo Tarde)...');
    await postSaleAgent.runPostSaleAgent().catch(e => console.error('[CRON] Post-Sale Agent error:', e));
});

// ── CUSTOMER SUCCESS AGENT (Magia Proactiva) ──
// Roda diariamente às 14:00
cron.schedule('0 14 * * *', async () => {
    console.log('[CRON 14:00] 🌟 Agente Customer Success...');
    await customerSuccessAgent.runCustomerSuccessAgent().catch(e => console.error('[CRON] Customer Success error:', e));
});

// ── AB TESTING AGENT (Optimização) ──
// Roda a cada 6 horas (desfasado do orquestrador)
cron.schedule('0 1,7,13,19 * * *', async () => {
    console.log('[CRON] 🧪 Agente A/B Testing...');
    await abTestingAgent.runABTestingAgent().catch(e => console.error('[CRON] AB Testing error:', e));
});

// ── WATCHDOG EVOLUTION API (WhatsApp) ──
// Verifica o estado da ligação WhatsApp a cada 5 minutos
// Se desconectada → reinicia automaticamente → envia alerta ao admin
cron.schedule('*/5 * * * *', async () => {
    console.log('[CRON */5m] 📡 Watchdog Evolution API — Verificando ligação WhatsApp...');
    await evolutionWatchdog.runEvolutionWatchdog().catch(e => console.error('[CRON] Evolution Watchdog error:', e));
});

console.log('[CRON] ✅ Equipa de Agentes Autónomos (v3.1 + WhatsApp Watchdog) inicializada.');

// ── ARRANQUE IMEDIATO DO WATCHDOG ──
// Verificação ao iniciar o servidor para detectar problemas desde o início
setTimeout(() => {
    evolutionWatchdog.runEvolutionWatchdog().catch(e => console.error('[Startup] Evolution Watchdog error:', e));
}, 10000); // 10s após arranque para o servidor estabilizar
}
