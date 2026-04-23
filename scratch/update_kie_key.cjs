const { Pool } = require('pg');

const pool = new Pool({
    host: '161.97.77.110',
    port: 5432,
    user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
    database: 'conversioai',
    ssl: false
});

async function updateKey() {
    try {
        const key = '178b44adfc95ff2a46a6fd4b60092c7a';
        await pool.query("UPDATE system_settings SET value = $1, updated_at = NOW() WHERE key = 'kie_ai_api_key'", [key]);
        console.log('✅ KIE API Key updated successfully in DB.');
        
        // Verify
        const res = await pool.query("SELECT key, value FROM system_settings WHERE key = 'kie_ai_api_key'");
        console.log('Current Value in DB:', res.rows[0].value);
        
        await pool.end();
    } catch (e) {
        console.error('❌ Failed to update key:', e);
        await pool.end();
    }
}

updateKey();
