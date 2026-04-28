/**
 * ═══════════════════════════════════════════════════════════════════
 * AGENTE WATCHDOG — Evolution API / WhatsApp
 * Monitoriza a ligação da instância WhatsApp a cada ciclo.
 * Se detectar desconexão → reinicia automaticamente → testa envio.
 * ═══════════════════════════════════════════════════════════════════
 */

import { getAdminWhatsApp } from './configService.js';

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || '';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';

// Estado interno para anti-spam (não reiniciar em loop)
let lastRestartAt: number | null = null;
let consecutiveFailures = 0;
const MIN_RESTART_INTERVAL_MS = 3 * 60 * 1000; // 3 minutos entre restarts
const MAX_CONSECUTIVE_FAILURES = 3; // Após 3 falhas seguidas, alerta crítico

// ─── Função principal (chamada pelo CRON) ───────────────────────────────────
export const runEvolutionWatchdog = async (): Promise<void> => {
    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        console.warn('[Evolution Watchdog] ⚠️ Configurações da API em falta. Watchdog desativado.');
        return;
    }

    console.log(`[Evolution Watchdog] 🔍 Verificando instância "${EVOLUTION_INSTANCE}"...`);

    try {
        const state = await checkConnectionState();

        if (state === 'open') {
            console.log(`[Evolution Watchdog] ✅ Instância "${EVOLUTION_INSTANCE}" está CONECTADA (open).`);
            consecutiveFailures = 0;
            return;
        }

        console.warn(`[Evolution Watchdog] ⚠️ Instância "${EVOLUTION_INSTANCE}" reporta estado: "${state}". Iniciando recuperação...`);
        await handleDisconnection(state);

    } catch (err: any) {
        consecutiveFailures++;
        console.error(`[Evolution Watchdog] ❌ Erro ao verificar estado (falha ${consecutiveFailures}):`, err.message);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[Evolution Watchdog] 🚨 ${consecutiveFailures} falhas consecutivas! A API pode estar fora do ar.`);
            await sendCriticalAlert(
                `🚨 *ALERTA CRÍTICO — Evolution API*\n\n` +
                `A ligação WhatsApp falhou ${consecutiveFailures}x seguidas.\n` +
                `Último erro: ${err.message}\n\n` +
                `Verifique o painel da Evolution API manualmente.`
            );
            consecutiveFailures = 0; // Reset para não spammar
        }
    }
};

// ─── Verifica estado atual da instância ────────────────────────────────────
async function checkConnectionState(): Promise<string> {
    const url = `${EVOLUTION_API_URL}/instance/connectionState/${EVOLUTION_INSTANCE}`;
    const res = await fetch(url, {
        headers: { apikey: EVOLUTION_API_KEY },
        signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ao verificar estado da instância`);
    }

    const data = await res.json() as any;
    return data?.instance?.state || data?.state || 'unknown';
}

// ─── Lida com a desconexão: reinicia e testa ────────────────────────────────
async function handleDisconnection(state: string): Promise<void> {
    const now = Date.now();

    // Anti-loop: evitar restarts muito seguidos
    if (lastRestartAt && (now - lastRestartAt) < MIN_RESTART_INTERVAL_MS) {
        const waitSec = Math.round((MIN_RESTART_INTERVAL_MS - (now - lastRestartAt)) / 1000);
        console.log(`[Evolution Watchdog] 🕒 Último restart foi há menos de 3 minutos. Aguardando ${waitSec}s antes de tentar novamente.`);
        return;
    }

    // 1. Reiniciar instância
    console.log(`[Evolution Watchdog] 🔄 A reiniciar instância "${EVOLUTION_INSTANCE}"...`);
    const restarted = await restartInstance();

    if (!restarted) {
        console.error('[Evolution Watchdog] ❌ Falha ao reiniciar. Vai tentar no próximo ciclo.');
        return;
    }

    lastRestartAt = Date.now();
    console.log(`[Evolution Watchdog] ✅ Instância reiniciada com sucesso.`);

    // 2. Aguardar 8 segundos para a instância estabilizar
    await sleep(8000);

    // 3. Verificar novo estado após restart
    const newState = await checkConnectionState().catch(() => 'unknown');
    console.log(`[Evolution Watchdog] 📡 Novo estado após restart: "${newState}"`);

    // 4. Enviar alerta ao admin com resultado
    if (newState === 'open') {
        await sendCriticalAlert(
            `🔄 *Watchdog — Recuperação Automática*\n\n` +
            `A instância *${EVOLUTION_INSTANCE}* foi reiniciada com sucesso!\n\n` +
            `📌 Estado anterior: ${state}\n` +
            `✅ Estado atual: *Conectado (open)*\n\n` +
            `_O sistema WhatsApp está de volta ao normal._`
        );
    } else {
        await sendCriticalAlert(
            `⚠️ *Watchdog — Restart Sem Sucesso*\n\n` +
            `A instância *${EVOLUTION_INSTANCE}* foi reiniciada, mas o estado ainda não está normal.\n\n` +
            `📌 Estado anterior: ${state}\n` +
            `⚠️ Estado atual: *${newState}*\n\n` +
            `Pode ser necessário fazer login (QR Code) manualmente no painel da Evolution API.`
        );
    }
}

// ─── Reinicia a instância via API ──────────────────────────────────────────
async function restartInstance(): Promise<boolean> {
    try {
        const url = `${EVOLUTION_API_URL}/instance/restart/${EVOLUTION_INSTANCE}`;
        const res = await fetch(url, {
            method: 'PUT',
            headers: {
                apikey: EVOLUTION_API_KEY,
                'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(15000)
        });

        const data = await res.json() as any;
        console.log(`[Evolution Watchdog] Restart response:`, JSON.stringify(data));
        return res.ok;
    } catch (err: any) {
        console.error('[Evolution Watchdog] Erro no restart:', err.message);
        return false;
    }
}

// ─── Envia alerta direto ao admin (sem depender do whatsappService para não criar loop) ──
async function sendCriticalAlert(message: string): Promise<void> {
    try {
        const adminNumber = process.env.ADMIN_WHATSAPP || await getAdminWhatsApp();
        if (!adminNumber) {
            console.warn('[Evolution Watchdog] Número admin não configurado, alerta não enviado.');
            return;
        }

        const formattedNumber = adminNumber.replace(/\D/g, '');
        const url = `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`;

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                apikey: EVOLUTION_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                number: formattedNumber,
                options: { delay: 500 },
                text: message
            }),
            signal: AbortSignal.timeout(15000)
        });

        const data = await res.json() as any;
        if (res.ok) {
            console.log(`[Evolution Watchdog] 📲 Alerta enviado ao admin (${formattedNumber}).`);
        } else {
            console.error('[Evolution Watchdog] Falha ao enviar alerta:', JSON.stringify(data));
        }
    } catch (err: any) {
        console.error('[Evolution Watchdog] Erro ao enviar alerta ao admin:', err.message);
    }
}

// ─── Utilitário ────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
