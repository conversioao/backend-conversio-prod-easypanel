const { Pool } = require('pg');

const pool = new Pool({
    host: '161.97.77.110',
    port: 5432,
    user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
    database: 'conversioai',
    ssl: false
});

async function checkAllSettings() {
    try {
        const res = await pool.query("SELECT key, value FROM system_settings WHERE key ILIKE '%kie%' OR key ILIKE '%api%'");
        console.log('--- KIE/API Settings in DB ---');
        console.log(res.rows);
        await pool.end();
    } catch (e) {
        console.error(e);
        await pool.end();
    }
}

checkAllSettings();
