require('dotenv').config({path: './.env'});
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME, port: process.env.DB_PORT });
async function sync() {
    try {
        await pool.query("UPDATE api_keys SET status = 'working', is_active = true, last_error = NULL WHERE provider = 'openai';");
        console.log('Keys fully reactivated.');
    } catch(e) { console.error(e.message); }
    pool.end();
}
sync();
