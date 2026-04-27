require('dotenv').config({path: './.env'});
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME, port: process.env.DB_PORT });

async function verify() {
    try {
        const res = await pool.query("SELECT id, provider, status, priority, is_active, substring(key_secret, 1, 15) as key_preview FROM api_keys WHERE provider = 'openai'");
        console.table(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

verify();
