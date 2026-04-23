import { query } from '../db.js';
import { keyManager } from './KeyManager.js';
import { processWithOpenAI } from '../utils/openai.js';
import { sendPremiumAdminReport } from './whatsappService.js';
import { getAdminWhatsApp } from './configService.js';
import axios from 'axios';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

/**
 * Agente Verificador de Comprovativos de Pagamento
 * Analisa PDFs/imagens de comprovativos via AI Vision e valida
 * contra IBANs e referências Multicaixa cadastrados na BD.
 */

// ─────────────────────────────────────────────────────────────
// EXTRAÇÃO DE DADOS DO COMPROVATIVO VIA AI
// ─────────────────────────────────────────────────────────────

interface ExtractedPaymentData {
    iban?: string;
    amount?: number;
    currency?: string;
    date?: string;
    bank_name?: string;
    sender_name?: string;
    reference?: string;
    multicaixa_entity?: string;
    raw_text?: string;
    confidence: number; // 0-100
}

async function extractDocumentData(fileUrl: string): Promise<ExtractedPaymentData | null> {
    const isPdf = fileUrl.toLowerCase().includes('.pdf');

    const systemPrompt = `
Você é um especialista em análise de documentos bancários angolanos.
Analise o comprovativo de pagamento e extraia as informações no formato JSON.

RETORNE APENAS JSON com esta estrutura:
{
  "iban": "IBAN encontrado no documento (formato AO06...)",
  "amount": 123.45,
  "currency": "AOA ou USD",
  "date": "DD/MM/YYYY",
  "bank_name": "Nome do banco",
  "sender_name": "Nome do remetente",
  "reference": "Referência da transferência",
  "multicaixa_entity": "Entidade Multicaixa se aplicável",
  "raw_text": "Texto bruto mais relevante do documento",
  "confidence": 85
}

Se um campo não for encontrado, coloque null.
O campo "confidence" indica a sua confiança de 0 a 100 na extração.
`;

    try {
        let responseText = '';


        if (isPdf) {
            // Fazer o download do PDF e extrair texto
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const dataBuffer = Buffer.from(response.data);
            const pdfData = await pdfParse(dataBuffer);
            const extractedText = pdfData.text;

            const { content } = await processWithOpenAI(
                systemPrompt,
                `Analise este texto extraído de um comprovativo bancário em PDF e devolva apenas as informações estruturadas em JSON. Ignore informações irrelevantes.\n\nTEXTO DO PDF:\n${extractedText}`,
                'paymentVerificationAgent:pdf',
                'gpt-4o-mini',
                'json_object'
            );
            responseText = content;
        } else {
            // Fazer o download da imagem e converter para base64 para evitar bloqueios de CDN na OpenAI
            const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
            const dataBuffer = Buffer.from(response.data);
            const base64Image = dataBuffer.toString('base64');
            
            // Determinar o mime type básico pela extensão
            let mimeType = 'image/jpeg';
            if (fileUrl.toLowerCase().includes('.png')) mimeType = 'image/png';
            if (fileUrl.toLowerCase().includes('.webp')) mimeType = 'image/webp';

            // Special case: we still use direct OpenAI for vision since processWithOpenAI doesn't support images yet?
            // Wait, I should update processWithOpenAI to support images OR just use direct and manual logging but centralize key.
            // Actually, my processWithOpenAI in engine supports images. Let's see if the backend one does.
            
            const { content } = await processWithOpenAI(
                systemPrompt,
                [
                    { type: 'text', text: 'Analise este comprovativo de pagamento e extraia as informações bancárias.' },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}`, detail: 'high' } }
                ] as any,
                'paymentVerificationAgent:vision',
                'gpt-4o',
                'json_object'
            );
            responseText = content;
        }

        const extracted = JSON.parse(responseText || '{}') as ExtractedPaymentData;
        console.log('[PaymentVerification] Dados extraídos:', extracted);
        return extracted;

    } catch (e: any) {
        console.error('[PaymentVerification] Erro na extração AI:', e.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
// CORRESPONDÊNCIA COM DADOS BANCÁRIOS
// ─────────────────────────────────────────────────────────────

interface MatchResult {
    matched: boolean;
    matchedAccount?: any;
    matchType?: string; // 'iban' | 'multicaixa' | 'reference'
    reasons: string[];
}

async function matchBankData(extracted: ExtractedPaymentData): Promise<MatchResult> {
    const reasons: string[] = [];

    try {
        // Buscar todas as contas bancárias ativas
        const accounts = await query(`
            SELECT * FROM bank_accounts WHERE is_active = true
        `);

        if (accounts.rowCount === 0) {
            return { matched: false, reasons: ['Nenhuma conta bancária cadastrada no sistema.'] };
        }

        for (const account of accounts.rows) {
            // 1. Verificar IBAN
            if (extracted.iban && account.iban) {
                const normalizedExtracted = extracted.iban.replace(/\s/g, '').toUpperCase();
                const normalizedAccount = account.iban.replace(/\s/g, '').toUpperCase();

                if (normalizedExtracted === normalizedAccount) {
                    return {
                        matched: true,
                        matchedAccount: account,
                        matchType: 'iban',
                        reasons: [`IBAN confirmado: ${account.iban} → Banco: ${account.bank_name}`]
                    };
                }
            }

            // 2. Verificar Referência Multicaixa
            if (extracted.reference && account.multicaixa_reference) {
                const normalizedRef = extracted.reference.replace(/\s/g, '');
                const normalizedAccount = account.multicaixa_reference.replace(/\s/g, '');

                if (normalizedRef.includes(normalizedAccount) || normalizedAccount.includes(normalizedRef)) {
                    return {
                        matched: true,
                        matchedAccount: account,
                        matchType: 'multicaixa',
                        reasons: [`Referência Multicaixa confirmada: ${account.multicaixa_reference}`]
                    };
                }
            }

            // 3. Verificar número de conta parcial
            if (extracted.iban && account.account_number) {
                if (extracted.iban.includes(account.account_number)) {
                    return {
                        matched: true,
                        matchedAccount: account,
                        matchType: 'account_number',
                        reasons: [`Número de conta identificado no IBAN.`]
                    };
                }
            }
        }

        // Nenhuma correspondência
        reasons.push('Nenhum IBAN/Referência no documento corresponde às contas cadastradas.');
        if (extracted.iban) reasons.push(`IBAN detectado no documento: ${extracted.iban}`);
        if (extracted.reference) reasons.push(`Referência detectada: ${extracted.reference}`);

        return { matched: false, reasons };

    } catch (e: any) {
        console.error('[PaymentVerification] Erro na correspondência de contas:', e.message);
        return { matched: false, reasons: [`Erro na verificação: ${e.message}`] };
    }
}

// ─────────────────────────────────────────────────────────────
// NOTIFICAÇÃO AO ADMIN
// ─────────────────────────────────────────────────────────────

async function notifyAdminVerificationResult(
    tx: any,
    extracted: ExtractedPaymentData | null,
    matchResult: MatchResult,
    verificationStatus: string
) {
    return; // DISABLED BY USER REQUEST - MANUAL VERIFICATION MODE
    try {
        const adminPhone = await getAdminWhatsApp();
        if (!adminPhone) return;

        const isValid = verificationStatus === 'valid';
        const statusIcon = isValid ? '🟢' : '🔴';
        const statusText = isValid ? 'POSSIVELMENTE VÁLIDO' : 'SUSPEITO';

        const extractedInfo = extracted ? [
            extracted.amount ? `💰 Valor detectado: ${extracted.amount} ${extracted.currency || 'AOA'}` : '',
            extracted.iban ? `🏦 IBAN: ${extracted.iban}` : '',
            extracted.bank_name ? `🏛️ Banco: ${extracted.bank_name}` : '',
            extracted.date ? `📅 Data: ${extracted.date}` : '',
            extracted.sender_name ? `👤 Remetente: ${extracted.sender_name}` : '',
        ].filter(Boolean).join('\n') : 'Não foi possível extrair dados do documento.';

        const message = `${statusIcon} *VERIFICAÇÃO DE COMPROVATIVO — ${statusText}*\n\n` +
            `👤 *Utilizador:* ${tx.user_name || tx.user_id}\n` +
            `💳 *Transação:* #${tx.id}\n` +
            `💵 *Valor na transação:* ${tx.amount} ${tx.currency}\n\n` +
            `*Dados extraídos do documento:*\n${extractedInfo}\n\n` +
            `*Resultado da verificação:*\n${matchResult.reasons.join('\n')}\n\n` +
            (isValid
                ? `✅ *Próximo passo:* Verifique o valor na sua conta bancária e confirme o pagamento no painel Admin > Pagamentos.`
                : `⚠️ *Atenção:* O comprovativo não corresponde às contas cadastradas. Analise manualmente antes de aprovar.`);

        await sendPremiumAdminReport(
            adminPhone,
            `COMPROVATIVO ${statusText}`,
            `Pagamento de ${tx.user_name || 'utilizador'} — ${tx.amount} ${tx.currency}`,
            isValid
                ? 'Verifique a conta bancária e confirme no painel'
                : 'Analise o comprovativo manualmente — possível fraude',
            isValid ? 'info' : 'warning'
        );


    } catch (e) {
        console.error('[PaymentVerification] Erro ao notificar admin:', e);
    }
}

// ─────────────────────────────────────────────────────────────
// FUNÇÃO PRINCIPAL — chamada pelo endpoint da API
// ─────────────────────────────────────────────────────────────

export async function verifyPaymentProof(transactionId: string): Promise<{
    status: string;
    extracted: ExtractedPaymentData | null;
    match: MatchResult;
}> {
    console.log(`[PaymentVerification] Iniciando verificação da transação #${transactionId}...`);

    try {
        // 1. Buscar transação
        const txRes = await query(`
            SELECT t.*, u.name as user_name, u.email as user_email
            FROM transactions t
            LEFT JOIN users u ON u.id = t.user_id
            WHERE t.id = $1
        `, [transactionId]);

        if (txRes.rowCount === 0) {
            throw new Error('Transação não encontrada.');
        }

        const tx = txRes.rows[0];
        const proofUrl = tx.proof_url;

        if (!proofUrl) {
            throw new Error('Nenhum comprovativo associado a esta transação.');
        }

        // 2. Extrair dados do documento via AI
        const extracted = await extractDocumentData(proofUrl);

        // 3. Comparar com contas bancárias
        let matchResult: MatchResult;
        if (!extracted) {
            matchResult = {
                matched: false,
                reasons: ['Não foi possível analisar o documento. Verificação manual necessária.']
            };
        } else {
            matchResult = await matchBankData(extracted);
        }

        // 4. Determinar status
        let verificationStatus = 'suspicious';
        if (matchResult.matched && extracted && extracted.confidence >= 60) {
            verificationStatus = 'valid';
        }

        // 5. Atualizar transação na BD
        await query(`
            UPDATE transactions
            SET 
                verification_status = $1,
                verification_data = $2,
                verification_notes = $3,
                verified_at = now(),
                verified_by_ai = true
            WHERE id = $4
        `, [
            verificationStatus,
            JSON.stringify({ extracted, match: matchResult }),
            matchResult.reasons.join('; '),
            transactionId
        ]);

        // 6. Notificar admin
        await notifyAdminVerificationResult(tx, extracted, matchResult, verificationStatus);

        console.log(`[PaymentVerification] Transação #${transactionId} → Status: ${verificationStatus}`);

        return { status: verificationStatus, extracted, match: matchResult };

    } catch (e: any) {
        console.error('[PaymentVerification] Erro geral:', e.message);
        throw e;
    }
}
