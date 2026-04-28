require('dotenv').config({path: './.env'});
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME, port: process.env.DB_PORT });
async function check() {
    try {
        const keysRes = await pool.query("SELECT id, provider, status, priority, substring(key_secret, 1, 15) as preview FROM api_keys");
        console.log("=== API_KEYS ===");
        console.table(keysRes.rows);

        const setRes = await pool.query("SELECT key, substring(value, 1, 15) as value FROM system_settings WHERE key = 'openai_api_key'");
        console.log("\n=== SYSTEM SETTINGS ===");
        console.table(setRes.rows);
    } catch(e) { console.error(e.message); }
    pool.end();
}
check();
