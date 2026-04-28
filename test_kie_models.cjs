/**
 * CORREÇÃO: Desativar chave inválida e testar criação de tarefa KIE.ai
 */
const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
    host: '161.97.77.110', port: 5432, user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo', database: 'conversioai', ssl: false
});

function httpsReq(url, method, headers, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const opts = { hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: 15000 };
        const req = https.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch (e) { resolve({ status: res.statusCode, data }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => reject(new Error('Timeout')));
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', B = '\x1b[1m', X = '\x1b[0m';

async function main() {
    console.log(`\n${B}${C}════════════════════════════════════════════════${X}`);
    console.log(`${B}  CORREÇÃO E TESTE KIE.AI${X}`);
    console.log(`${B}${C}════════════════════════════════════════════════${X}\n`);

    // 1. Desativar chave ID 6 (conhecida como inválida - 401)
    console.log(`${C}🔧 Desativando chave ID 6 (inválida - 401)...${X}`);
    await pool.query(`UPDATE api_keys SET status = 'failed', is_active = false, last_error = 'Manually disabled: 401 history' WHERE id = 6`);
    console.log(`${G}✅ Chave ID 6 desativada${X}`);

    // 2. Listar chaves KIE restantes
    const keys = await pool.query(`SELECT id, LEFT(key_secret, 15) as preview, key_secret, priority, status, is_active FROM api_keys WHERE provider = 'kie' ORDER BY priority, id`);
    console.log(`\n${C}📋 Chaves KIE disponíveis:${X}`);
    keys.rows.forEach(r => {
        const ok = r.is_active && r.status === 'working';
        console.log(`  ${ok ? G+'✅' : R+'❌'} ID:${r.id} Prio:${r.priority} Status:${r.status} Active:${r.is_active} - ${r.preview}***${X}`);
    });

    // 3. Pegar a melhor chave disponível
    const bestKey = keys.rows.find(r => r.is_active && r.status === 'working');
    if (!bestKey) {
        console.log(`${R}❌ Nenhuma chave KIE ativa!${X}`);
        await pool.end();
        return;
    }
    
    const apiKey = bestKey.key_secret;
    console.log(`\n${C}🔑 Usando chave ID:${bestKey.id} para testes${X}`);

    // 4. Testar endpoint de user info
    console.log(`\n${C}🔍 Testando autenticação KIE.ai...${X}`);
    try {
        const res = await httpsReq('https://api.kie.ai/api/v1/user/info', 'GET', {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        });
        if (res.status === 200) {
            console.log(`${G}✅ Auth OK! User info: ${JSON.stringify(res.data).substring(0, 200)}${X}`);
        } else {
            console.log(`${Y}⚠️  Status ${res.status}: ${JSON.stringify(res.data).substring(0, 200)}${X}`);
        }
    } catch (err) {
        console.log(`${Y}⚠️  user/info: ${err.message}${X}`);
    }

    // 5. Testar criação de tarefa de imagem com modelo correto
    console.log(`\n${C}🔍 Testando criação de tarefa de IMAGEM...${X}`);
    const imageModels = ['google/nano-banana-lite', 'google/nano-banana-edit', 'kling/v2.1', 'seedream/3.0'];
    
    for (const model of imageModels) {
        try {
            console.log(`  Testando modelo: ${model}`);
            const res = await httpsReq('https://api.kie.ai/api/v1/jobs/createTask', 'POST', {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }, {
                model,
                input: {
                    prompt: 'A professional product photo of a bottle of cream on a clean white background, commercial photography style',
                    image_urls: [],
                    output_format: 'png',
                    image_size: '1:1',
                    quality: 'basic'
                }
            });
            
            if (res.status === 200 && res.data?.success && res.data?.data?.taskId) {
                console.log(`  ${G}✅ MODELO FUNCIONAL: ${model} → taskId: ${res.data.data.taskId}${X}`);
                
                // Update model mapping in our code recommendation
                await pool.query(`INSERT INTO agent_logs (agent_name, action, result, metadata) VALUES ('KieAiTest', 'MODEL_TEST_OK', 'success', $1)`,
                    [JSON.stringify({ model, taskId: res.data.data.taskId })]).catch(() => {});
                    
            } else {
                const msg = res.data?.message || JSON.stringify(res.data).substring(0, 100);
                console.log(`  ${R}❌ ${model}: ${msg}${X}`);
            }
        } catch (err) {
            console.log(`  ${R}❌ ${model}: ${err.message}${X}`);
        }
        // Small delay between requests
        await new Promise(r => setTimeout(r, 500));
    }

    // 6. Testar criação de tarefa de MÚSICA
    console.log(`\n${C}🔍 Testando criação de tarefa de MÚSICA...${X}`);
    const musicModels = ['suno/v4', 'suno-v4', 'suno/v3.5'];
    
    for (const model of musicModels) {
        try {
            console.log(`  Testando modelo: ${model}`);
            const res = await httpsReq('https://api.kie.ai/api/v1/jobs/createTask', 'POST', {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }, {
                model,
                input: {
                    gpt_description_prompt: 'A happy upbeat jingle for a product advertisement, Portuguese language',
                    make_instrumental: true,
                    prompt: 'Happy advertising jingle'
                }
            });
            
            if (res.status === 200 && res.data?.success && res.data?.data?.taskId) {
                console.log(`  ${G}✅ MODELO FUNCIONAL: ${model} → taskId: ${res.data.data.taskId}${X}`);
            } else {
                const msg = res.data?.message || JSON.stringify(res.data).substring(0, 100);
                console.log(`  ${R}❌ ${model}: ${msg}${X}`);
            }
        } catch (err) {
            console.log(`  ${R}❌ ${model}: ${err.message}${X}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }

    console.log(`\n${B}${C}════════════════════════════════════════════════${X}`);
    console.log(`${B}  TESTE CONCLUÍDO${X}`);
    console.log(`${B}${C}════════════════════════════════════════════════${X}\n`);
    
    await pool.end();
}

main().catch(err => {
    console.error(`${R}❌ Erro:${X}`, err.message);
    pool.end();
});
