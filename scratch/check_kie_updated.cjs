const { Pool } = require('pg');

const pool = new Pool({
    host: '161.97.77.110',
    port: 5432,
    user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
    database: 'conversioai',
    ssl: false
});

async function checkKieUpdated() {
    try {
        const res = await pool.query("SELECT key, value, updated_at FROM system_settings WHERE key = 'kie_ai_api_key'");
        console.log('--- KIE Key Status ---');
        console.log(res.rows);
        await pool.end();
    } catch (e) {
        console.error(e);
        await pool.end();
    }
}

checkKieUpdated();
