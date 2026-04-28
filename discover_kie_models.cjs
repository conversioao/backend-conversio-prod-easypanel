/**
 * DESCOBRIR MODELOS CORRETOS DO KIE.AI
 */
const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
    host: '161.97.77.110', port: 5432, user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo', database: 'conversioai', ssl: false
});

function httpsReq(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const bodyStr = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: u.hostname, path: u.pathname + u.search,
            method, headers: { ...headers, ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}) },
            timeout: 20000
        };
        const req = https.request(opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
                catch { resolve({ status: res.statusCode, data }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', B = '\x1b[1m', X = '\x1b[0m';

// A real public image URL for testing
const TEST_IMAGE = 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400';

async function testModel(apiKey, modelName, payload, label) {
    try {
        const res = await httpsReq('POST', 'https://api.kie.ai/api/v1/jobs/createTask',
            { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            { model: modelName, input: payload }
        );
        if (res.data?.success && res.data?.data?.taskId) {
            console.log(`  ${G}✅ FUNCIONA: ${label || modelName} → taskId: ${res.data.data.taskId}${X}`);
            return { ok: true, taskId: res.data.data.taskId };
        } else {
            const msg = res.data?.msg || res.data?.message || JSON.stringify(res.data).substring(0, 120);
            const icon = msg.includes('not supported') ? R+'❌' : Y+'⚠️ ';
            console.log(`  ${icon} ${label || modelName}: ${msg}${X}`);
            return { ok: false, error: msg };
        }
    } catch (err) {
        console.log(`  ${R}❌ ${label || modelName}: ${err.message}${X}`);
        return { ok: false, error: err.message };
    }
}

async function main() {
    console.log(`\n${B}${C}════════════════════════════════════════════════════${X}`);
    console.log(`${B}  KIE.AI - DESCOBERTA DE MODELOS VÁLIDOS${X}`);
    console.log(`${B}${C}════════════════════════════════════════════════════${X}\n`);

    const keyRes = await pool.query(`SELECT key_secret FROM api_keys WHERE provider = 'kie' AND is_active = true AND status = 'working' ORDER BY priority LIMIT 1`);
    if (!keyRes.rows.length) { console.log(`${R}❌ Sem chave KIE!${X}`); await pool.end(); return; }
    const apiKey = keyRes.rows[0].key_secret;
    console.log(`${G}✅ Usando chave: ${apiKey.substring(0, 10)}***${X}\n`);

    // ─── MODELOS DE IMAGEM ──────────────────────────────────────────
    console.log(`${B}${C}── MODELOS DE IMAGEM ──────────────────────────────${X}`);
    const imagePayload = {
        prompt: 'Professional product photo of a skincare cream bottle on white background',
        image_urls: [TEST_IMAGE],
        output_format: 'png',
        image_size: '1:1',
        quality: 'basic'
    };
    const imageModels = [
        'google/nano-banana-edit',
        'google/nano-banana-lite',
        'nano-banana-edit',
        'nano-banana-pro',
        'nano-banana-lite',
        'seedream/4.5-edit',
        'seedream/4.5',
        'seedream/3.0',
        'kling/v2.1-image',
        'kling/v1.5-image',
    ];
    
    const workingImageModels = [];
    for (const m of imageModels) {
        const r = await testModel(apiKey, m, imagePayload);
        if (r.ok) workingImageModels.push(m);
        await new Promise(r => setTimeout(r, 300));
    }

    // ─── MODELOS DE VÍDEO ──────────────────────────────────────────
    console.log(`\n${B}${C}── MODELOS DE VÍDEO ───────────────────────────────${X}`);
    const videoPayload = {
        prompt: 'A beautiful product commercial video, cinematic quality',
        image_urls: [TEST_IMAGE],
        output_format: 'mp4',
        image_size: '16:9',
        quality: 'basic'
    };
    const videoModels = [
        'google/veo-3.1-generate',
        'google/veo-2.0',
        'kling/v2.1',
        'kling/v1.5',
        'kling/v2.1-pro',
        'luma/ray-2',
        'wan/2.1',
    ];
    
    const workingVideoModels = [];
    for (const m of videoModels) {
        const r = await testModel(apiKey, m, videoPayload);
        if (r.ok) workingVideoModels.push(m);
        await new Promise(r => setTimeout(r, 300));
    }

    // ─── MODELOS DE MÚSICA ────────────────────────────────────────
    console.log(`\n${B}${C}── MODELOS DE MÚSICA ──────────────────────────────${X}`);
    const musicPayload = {
        gpt_description_prompt: 'A happy upbeat commercial jingle in Portuguese',
        make_instrumental: true,
        prompt: 'Happy commercial jingle'
    };
    const musicModels = [
        'suno/v4',
        'suno-v4',
        'suno/v3.5',
        'suno-v3.5',
        'suno/v3',
        'suno',
        'V4',
        'V3.5',
        'chirp-v4',
        'chirp-v3-5',
        'udio/v1.5',
    ];
    
    const workingMusicModels = [];
    for (const m of musicModels) {
        const r = await testModel(apiKey, m, musicPayload);
        if (r.ok) workingMusicModels.push(m);
        await new Promise(r => setTimeout(r, 300));
    }

    // ─── RESUMO ──────────────────────────────────────────────────
    console.log(`\n${B}${C}════════════════════════════════════════════════════${X}`);
    console.log(`${B}  RESUMO DOS MODELOS FUNCIONAIS${X}`);
    console.log(`${C}════════════════════════════════════════════════════${X}`);
    
    console.log(`\n${G}📸 Imagem (${workingImageModels.length} funcionais):${X}`);
    if (workingImageModels.length) workingImageModels.forEach(m => console.log(`   → ${m}`));
    else console.log(`   ${R}Nenhum modelo de imagem funcional!${X}`);
    
    console.log(`\n${G}🎬 Vídeo (${workingVideoModels.length} funcionais):${X}`);
    if (workingVideoModels.length) workingVideoModels.forEach(m => console.log(`   → ${m}`));
    else console.log(`   ${R}Nenhum modelo de vídeo funcional!${X}`);
    
    console.log(`\n${G}🎵 Música (${workingMusicModels.length} funcionais):${X}`);
    if (workingMusicModels.length) workingMusicModels.forEach(m => console.log(`   → ${m}`));
    else console.log(`   ${R}Nenhum modelo de música funcional!${X}`);
    
    if (workingImageModels.length + workingVideoModels.length + workingMusicModels.length === 0) {
        console.log(`\n${R}${B}⚠️  NENHUM MODELO FUNCIONAL! Possíveis causas:${X}`);
        console.log(`   1. A chave KIE.ai não tem créditos`);
        console.log(`   2. A conta KIE.ai está suspensa`);
        console.log(`   3. A API do KIE.ai mudou de URL`);
        console.log(`   4. É necessário consultar a documentação atualizada: https://kie.ai/api-doc`);
    }
    
    console.log(`\n${B}${C}════════════════════════════════════════════════════${X}\n`);
    await pool.end();
}

main().catch(err => { console.error(R+'❌'+X, err.message); pool.end(); });
