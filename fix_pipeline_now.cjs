/**
 * DIAGNÓSTICO E CORREÇÃO COMPLETA DO PIPELINE DE GERAÇÃO
 */
const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
    host: '161.97.77.110',
    port: 5432,
    user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
    database: 'conversioai',
    ssl: false
});

async function q(sql, params = []) {
    return pool.query(sql, params);
}

function get(url, headers) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers, timeout: 8000 }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, data }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => reject(new Error('Timeout')));
    });
}

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', B = '\x1b[1m', X = '\x1b[0m';

async function main() {
    console.log(`\n${B}${C}══════════════════════════════════════════════════════${X}`);
    console.log(`${B}  CONVERSIO AI - DIAGNÓSTICO COMPLETO DO PIPELINE${X}`);
    console.log(`${B}${C}══════════════════════════════════════════════════════${X}\n`);

    // ─── 1. Tabela api_keys ──────────────────────────────────────────
    console.log(`${C}🔍 PASSO 1: Todas as chaves API...${X}`);
    const allKeys = await q(`SELECT id, provider, status, is_active, priority, LEFT(key_secret, 10) as preview, last_error FROM api_keys ORDER BY provider, priority`);
    
    if (allKeys.rows.length === 0) {
        console.log(`${R}  ❌ NENHUMA chave encontrada na tabela api_keys!${X}`);
    } else {
        allKeys.rows.forEach(r => {
            const ok = r.is_active && r.status === 'working';
            console.log(`  ${ok ? G+'✅' : R+'❌'} [${r.provider}] ID:${r.id} Prio:${r.priority} Status:${r.status} Active:${r.is_active} Key:${r.preview}***${X}`);
            if (r.last_error) console.log(`       ${Y}Erro: ${String(r.last_error).substring(0, 100)}${X}`);
        });
    }

    // ─── 2. Corrigir 'kie-ai' → 'kie' ───────────────────────────────
    console.log(`\n${C}🔍 PASSO 2: Verificando registos 'kie-ai'...${X}`);
    const kieAiRes = await q(`SELECT COUNT(*) as cnt FROM api_keys WHERE provider = 'kie-ai'`);
    if (parseInt(kieAiRes.rows[0].cnt) > 0) {
        await q(`UPDATE api_keys SET provider = 'kie' WHERE provider = 'kie-ai'`);
        console.log(`${G}  ✅ Migrados ${kieAiRes.rows[0].cnt} registos de 'kie-ai' → 'kie'${X}`);
    } else {
        console.log(`${G}  ✅ Nenhum registo 'kie-ai' (já está correto)${X}`);
    }

    // ─── 3. Garantir chave KIE ativa ────────────────────────────────
    console.log(`\n${C}🔍 PASSO 3: Verificando chave KIE ativa...${X}`);
    const activeKie = await q(`SELECT id, key_secret, priority FROM api_keys WHERE provider = 'kie' AND is_active = true AND status = 'working' ORDER BY priority LIMIT 1`);
    
    let kieKey = null;
    if (activeKie.rows.length === 0) {
        console.log(`${Y}  ⚠️  Nenhuma chave KIE ativa. Tentando reativar...${X}`);
        const react = await q(`UPDATE api_keys SET status = 'working', is_active = true, last_error = NULL, updated_at = NOW() WHERE provider = 'kie' RETURNING id, priority, key_secret`);
        if (react.rows.length > 0) {
            kieKey = react.rows[0].key_secret;
            console.log(`${G}  ✅ ${react.rows.length} chave(s) KIE reativadas!${X}`);
        } else {
            console.log(`${R}  ❌ Nenhuma chave KIE na base de dados!${X}`);
            // Check system_settings
            const sysKey = await q(`SELECT value FROM system_settings WHERE key = 'KIE_AI_API_KEY' OR key = 'kie_ai_api_key' LIMIT 1`);
            if (sysKey.rows.length > 0) {
                console.log(`${Y}  ℹ️  Chave em system_settings: ${sysKey.rows[0].value.substring(0,10)}***${X}`);
                console.log(`${Y}  → A inserir na tabela api_keys...${X}`);
                await q(`INSERT INTO api_keys (provider, key_secret, status, is_active, priority) VALUES ('kie', $1, 'working', true, 1) ON CONFLICT DO NOTHING`, [sysKey.rows[0].value]);
                kieKey = sysKey.rows[0].value;
                console.log(`${G}  ✅ Chave inserida na tabela api_keys!${X}`);
            }
        }
    } else {
        kieKey = activeKie.rows[0].key_secret;
        console.log(`${G}  ✅ Chave KIE ativa: ID ${activeKie.rows[0].id}, Prio ${activeKie.rows[0].priority}${X}`);
    }

    // ─── 4. Testar KIE.ai API ────────────────────────────────────────
    if (kieKey) {
        console.log(`\n${C}🔍 PASSO 4: Testando chave KIE.ai na API real...${X}`);
        try {
            const res = await get('https://api.kie.ai/api/v1/credit/balance', { 'Authorization': `Bearer ${kieKey}` });
            if (res.status === 200) {
                console.log(`${G}  ✅ KIE.ai FUNCIONAL! Resposta: ${JSON.stringify(res.data).substring(0, 150)}${X}`);
            } else if (res.status === 401) {
                console.log(`${R}  ❌ Chave KIE INVÁLIDA (401)! Precisa de uma nova chave válida.${X}`);
                await q(`UPDATE api_keys SET status = 'failed', is_active = false, last_error = '401 Unauthorized' WHERE provider = 'kie'`);
            } else {
                console.log(`${Y}  ⚠️  KIE.ai Status ${res.status}: ${JSON.stringify(res.data).substring(0, 150)}${X}`);
            }
        } catch (err) {
            console.log(`${Y}  ⚠️  Não foi possível testar KIE.ai: ${err.message}${X}`);
        }
    } else {
        console.log(`\n${R}  ❌ PASSO 4 IGNORADO: Sem chave KIE para testar.${X}`);
    }

    // ─── 5. Gerações recentes com erro ──────────────────────────────
    console.log(`\n${C}🔍 PASSO 5: Últimas gerações com erro (24h)...${X}`);
    const failed = await q(`SELECT id, type, status, created_at, metadata->>'error' as err FROM generations WHERE status = 'failed' AND created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 5`);
    if (failed.rows.length > 0) {
        failed.rows.forEach(r => console.log(`  ${R}❌ ${r.id.substring(0,8)}... | ${r.type} | ${r.err || 'sem erro'}${X}`));
    } else {
        console.log(`${G}  ✅ Nenhuma geração falhada nas últimas 24h${X}`);
    }

    // ─── 6. Gerações stuck ───────────────────────────────────────────
    console.log(`\n${C}🔍 PASSO 6: Gerações presas em 'processing'...${X}`);
    const stuck = await q(`SELECT id, type, cost, user_id, created_at FROM generations WHERE status = 'processing' AND created_at < NOW() - INTERVAL '10 minutes'`);
    if (stuck.rows.length > 0) {
        console.log(`${Y}  ⚠️  ${stuck.rows.length} geração(ões) presas. Limpando...${X}`);
        for (const g of stuck.rows) {
            await q(`UPDATE generations SET status = 'failed', metadata = metadata || '{"error":"Timeout manual cleanup"}' WHERE id = $1`, [g.id]);
            if (g.cost && g.user_id) await q(`UPDATE users SET credits = credits + $1 WHERE id = $2`, [g.cost, g.user_id]);
            console.log(`    → ${g.id.substring(0,8)}... (${g.type}) limpa, créditos devolvidos.`);
        }
    } else {
        console.log(`${G}  ✅ Nenhuma geração presa${X}`);
    }

    // ─── RESUMO ─────────────────────────────────────────────────────
    console.log(`\n${B}${C}══════════════════════════════════════════════════════${X}`);
    const finalKeys = await q(`SELECT provider, COUNT(*) as total, COUNT(*) FILTER(WHERE is_active AND status='working') as active FROM api_keys GROUP BY provider ORDER BY provider`);
    console.log(`${B}  ESTADO FINAL DAS CHAVES:${X}`);
    finalKeys.rows.forEach(r => {
        const ok = parseInt(r.active) > 0;
        console.log(`  ${ok ? G+'✅' : R+'❌'} ${r.provider}: ${r.active}/${r.total} ativas${X}`);
    });
    
    const kieOk = finalKeys.rows.find(r => r.provider === 'kie' && parseInt(r.active) > 0);
    const openaiOk = finalKeys.rows.find(r => r.provider === 'openai' && parseInt(r.active) > 0);
    
    console.log(`\n${B}  DIAGNÓSTICO:${X}`);
    if (kieOk) console.log(`${G}  ✅ Pipeline de Imagem/Vídeo/Música: DEVE FUNCIONAR${X}`);
    else console.log(`${R}  ❌ Sem chave KIE ativa - Imagem/Vídeo/Música vão falhar!${X}`);
    
    if (openaiOk) console.log(`${G}  ✅ Análise de Imagem (OpenAI): DEVE FUNCIONAR${X}`);
    else console.log(`${Y}  ⚠️  Sem chave OpenAI ativa - Análise de imagem pode falhar${X}`);
    
    console.log(`${B}${C}══════════════════════════════════════════════════════${X}\n`);
    
    await pool.end();
}

main().catch(err => {
    console.error('\x1b[31m❌ Erro fatal:\x1b[0m', err.message);
    pool.end();
});
