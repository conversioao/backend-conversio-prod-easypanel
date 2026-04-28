const { Pool } = require('pg');

const pool = new Pool({
    host: '161.97.77.110',
    port: 5432,
    user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
    database: 'conversioai',
    ssl: false
});

async function checkKie() {
    try {
        const res = await pool.query("SELECT key, value FROM system_settings WHERE key LIKE '%kie%'");
        console.log('--- KIE Settings ---');
        console.log(res.rows);
        await pool.end();
    } catch (e) {
        console.error(e);
        await pool.end();
    }
}

checkKie();
