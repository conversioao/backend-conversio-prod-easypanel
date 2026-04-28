const { Pool } = require('pg');
const axios = require('axios');

const pool = new Pool({
    host: '161.97.77.110', port: 5432, user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo', database: 'conversioai', ssl: false
});

async function testMusic() {
    const res = await pool.query("SELECT key_secret FROM api_keys WHERE provider = 'kie' AND is_active = true AND status = 'working' ORDER BY priority LIMIT 1");
    const apiKey = res.rows[0].key_secret;
    
    const variants = ['suno/v4', 'suno/v3.5', 'suno-v4', 'suno-v3.5', 'suno-v3', 'suno/v3', 'V4', 'V3.5'];
    
    for (const v of variants) {
        try {
            const response = await axios.post('https://api.kie.ai/api/v1/jobs/createTask', {
                model: v,
                input: { prompt: 'Happy upbeat jingle', make_instrumental: true }
            }, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
            console.log(`Modelo ${v}:`, JSON.stringify(response.data));
        } catch (err) {
            console.log(`Modelo ${v} ERRO:`, err.response?.data?.msg || err.message);
        }
    }
    await pool.end();
}

testMusic();
