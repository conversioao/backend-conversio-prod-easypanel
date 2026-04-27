require('dotenv').config({path: './.env'});
const { Pool } = require('pg');

async function run() {
    const pool = new Pool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT
    });
    const res = await pool.query("SELECT id, provider, left(key_secret, 20) as key_prefix, status, is_active FROM api_keys WHERE provider IN ('openai', 'kie') ORDER BY provider, priority");
    console.log(JSON.stringify(res.rows, null, 2));
    await pool.end();
}
run();
