require('dotenv').config({path: './.env'});
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME, port: process.env.DB_PORT });
async function check() {
    try {
        const res = await pool.query("SELECT * FROM api_usage_stats WHERE provider = 'kie' ORDER BY created_at DESC LIMIT 10");
        console.log(JSON.stringify(res.rows, null, 2));
    } catch(e) { console.error(e.message); }
    pool.end();
}
check();
