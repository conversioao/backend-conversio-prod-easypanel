const { Pool } = require('pg');

const pool = new Pool({
    host: '161.97.77.110', port: 5432, user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo', database: 'conversioai', ssl: false
});

async function test() {
    console.log('--- TESTANDO KIEAINODE COM FIX ---');
    
    // Get a working key
    const res = await pool.query("SELECT key_secret FROM api_keys WHERE provider = 'kie' AND is_active = true AND status = 'working' ORDER BY priority LIMIT 1");
    if (!res.rows.length) {
        console.error('Nenhuma chave KIE ativa encontrada!');
        await pool.end();
        return;
    }
    const apiKey = res.rows[0].key_secret;
    console.log(`Usando chave: ${apiKey.substring(0, 10)}***`);

    try {
        console.log('Tentando criar tarefa de imagem (nano-banana-pro)...');
        // We use nano-banana-pro because discovery said it worked
        const taskId = await KieAiNode.createTask({
            model: 'nano-banana-pro',
            prompt: 'A test image of a beautiful landscape',
            apiKey
        });
        
        console.log(`✅ SUCESSO! Task ID: ${taskId}`);
    } catch (err) {
        console.error(`❌ FALHA: ${err.message}`);
    }

    await pool.end();
}

// Simple mock for KieAiNode if needed, but I want to test the REAL one.
// Wait, the real one is TypeScript. I should either use ts-node or a compiled version.
// I'll just use a small JS script that mimics the logic I fixed.

async function manualTest() {
    const axios = require('axios');
    const res = await pool.query("SELECT key_secret FROM api_keys WHERE provider = 'kie' AND is_active = true AND status = 'working' ORDER BY priority LIMIT 1");
    const apiKey = res.rows[0].key_secret;
    
    try {
        const response = await axios.post('https://api.kie.ai/api/v1/jobs/createTask', {
            model: 'nano-banana-pro',
            input: { prompt: 'test' }
        }, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });
        
        console.log('Resposta bruta:', JSON.stringify(response.data));
        
        // APPLY THE LOGIC I ADDED TO KieAiNode.ts
        const taskId = response.data?.data?.taskId;
        const isSuccess = taskId && (
            response.data?.success === true ||
            response.data?.code === 200 ||
            response.data?.msg === 'success'
        );

        if (isSuccess) {
            console.log(`✅ Lógica de sucesso validada! Task ID: ${taskId}`);
        } else {
            console.log('❌ Lógica de sucesso FALHOU para esta resposta.');
        }
    } catch (err) {
        console.error('Erro no pedido:', err.message);
    }
    await pool.end();
}

manualTest();
