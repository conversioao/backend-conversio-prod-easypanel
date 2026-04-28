/**
 * ═══════════════════════════════════════════════════════════════════
 * AGENTE WATCHDOG — Evolution API / WhatsApp
 * Monitoriza a ligação da instância WhatsApp a cada ciclo.
 * Se detectar desconexão → reinicia automaticamente → testa envio.
 * ═══════════════════════════════════════════════════════════════════
 */

import { getAdminWhatsApp } from './configService.js';
import { getConfig } from '../config.js';

// Estado interno para anti-spam (não reiniciar em loop)
let lastRestartAt: number | null = null;
let consecutiveFailures = 0;
const MIN_RESTART_INTERVAL_MS = 3 * 60 * 1000; // 3 minutos entre restarts
const MAX_CONSECUTIVE_FAILURES = 3; // Após 3 falhas seguidas, alerta crítico

interface EvoConfig {
    apiUrl: string;
    apiKey: string;
    instance: string;
}

// ─── Função principal (chamada pelo CRON) ───────────────────────────────────
export const runEvolutionWatchdog = async (): Promise<void> => {
    const EVOLUTION_API_URL = await getConfig('EVOLUTION_API_URL');
    const EVOLUTION_API_KEY = await getConfig('EVOLUTION_API_KEY');
    const EVOLUTION_INSTANCE = await getConfig('EVOLUTION_INSTANCE');

    if (!EVOLUTION_API_URL || !EVOLUTION_API_KEY || !EVOLUTION_INSTANCE) {
        console.warn('[Evolution Watchdog] ⚠️ Configurações da API em falta. Watchdog desativado.');
        return;
    }

    const config: EvoConfig = {
        apiUrl: EVOLUTION_API_URL,
        apiKey: EVOLUTION_API_KEY,
        instance: EVOLUTION_INSTANCE
    };

    console.log(`[Evolution Watchdog] 🔍 Verificando instância "${config.instance}"...`);

    try {
        const state = await checkConnectionState(config);

        if (state === 'open') {
            console.log(`[Evolution Watchdog] ✅ Instância "${config.instance}" está CONECTADA (open).`);
            consecutiveFailures = 0;
            return;
        }

        console.warn(`[Evolution Watchdog] ⚠️ Instância "${config.instance}" reporta estado: "${state}". Iniciando recuperação...`);
        await handleDisconnection(state, config);

    } catch (err: any) {
        consecutiveFailures++;
        console.error(`[Evolution Watchdog] ❌ Erro ao verificar estado (falha ${consecutiveFailures}):`, err.message);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            console.error(`[Evolution Watchdog] 🚨 ${consecutiveFailures} falhas consecutivas! A API pode estar fora do ar.`);
            await sendCriticalAlert(
                `🚨 *ALERTA CRÍTICO — Evolution API*\n\n` +
                `A ligação WhatsApp falhou ${consecutiveFailures}x seguidas.\n` +
                `Último erro: ${err.message}\n\n` +
                `Verifique o painel da Evolution API manualmente.`,
                config
            );
            consecutiveFailures = 0; // Reset para não spammar
        }
    }
};

// ─── Verifica estado atual da instância ────────────────────────────────────
async function checkConnectionState(config: EvoConfig): Promise<string> {
    const url = `${config.apiUrl}/instance/connectionState/${config.instance}`;
    const res = await fetch(url, {
        headers: { apikey: config.apiKey },
        signal: AbortSignal.timeout(10000)
    });

    if (!res.ok) {
        throw new Error(`HTTP ${res.status} ao verificar estado da instância`);
    }

    const data = await res.json() as any;
    return data?.instance?.state || data?.state || 'unknown';
}

// ─── Lida com a desconexão: reinicia e testa ────────────────────────────────
async function handleDisconnection(state: string, config: EvoConfig): Promise<void> {
    const now = Date.now();

    // Anti-loop: evitar restarts muito seguidos
    if (lastRestartAt && (now - lastRestartAt) < MIN_RESTART_INTERVAL_MS) {
        const waitSec = Math.round((MIN_RESTART_INTERVAL_MS - (now - lastRestartAt)) / 1000);
        console.log(`[Evolution Watchdog] 🕒 Último restart foi há menos de 3 minutos. Aguardando ${waitSec}s antes de tentar novamente.`);
        return;
    }

    // 1. Reiniciar instância
    console.log(`[Evolution Watchdog] 🔄 A reiniciar instância "${config.instance}"...`);
    const restarted = await restartInstance(config);

    if (!restarted) {
        console.error('[Evolution Watchdog] ❌ Falha ao reiniciar. Vai tentar no próximo ciclo.');
        return;
    }

    lastRestartAt = Date.now();
    console.log(`[Evolution Watchdog] ✅ Instância reiniciada com sucesso.`);

    // 2. Aguardar 8 segundos para a instância estabilizar
    await sleep(8000);

    // 3. Verificar novo estado após restart
    const newState = await checkConnectionState(config).catch(() => 'unknown');
    console.log(`[Evolution Watchdog] 📡 Novo estado após restart: "${newState}"`);

    // 4. Enviar alerta ao admin com resultado
    if (newState === 'open') {
        await sendCriticalAlert(
            `🔄 *Watchdog — Recuperação Automática*\n\n` +
            `A instância *${config.instance}* foi reiniciada com sucesso!\n\n` +
            `📌 Estado anterior: ${state}\n` +
            `✅ Estado atual: *Conectado (open)*\n\n` +
            `_O sistema WhatsApp está de volta ao normal._`,
            config
        );
    } else {
        await sendCriticalAlert(
            `⚠️ *Watchdog — Restart Sem Sucesso*\n\n` +
            `A instância *${config.instance}* foi reiniciada, mas o estado ainda não está normal.\n\n` +
            `📌 Estado anterior: ${state}\n` +
            `⚠️ Estado atual: *${newState}*\n\n` +
            `Pode ser necessário fazer login (QR Code) manualmente no painel da Evolution API.`,
            config
        );
    }
}

// ─── Reinicia a instância via API ──────────────────────────────────────────
async function restartInstance(config: EvoConfig): Promise<boolean> {
    try {
        const url = `${config.apiUrl}/instance/restart/${config.instance}`;
        const res = await fetch(url, {
            method: 'PUT',
            headers: {
                apikey: config.apiKey,
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
async function sendCriticalAlert(message: string, config: EvoConfig): Promise<void> {
    try {
        const adminNumber = process.env.ADMIN_WHATSAPP || await getAdminWhatsApp();
        if (!adminNumber) {
            console.warn('[Evolution Watchdog] Número admin não configurado, alerta não enviado.');
            return;
        }

        const formattedNumber = adminNumber.replace(/\D/g, '');
        const url = `${config.apiUrl}/message/sendText/${config.instance}`;

        const res = await fetch(url, {
            method: 'POST',
            headers: {
                apikey: config.apiKey,
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
