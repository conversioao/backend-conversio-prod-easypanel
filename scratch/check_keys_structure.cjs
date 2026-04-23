require('dotenv').config({path: './.env'});
const { Pool } = require('pg');
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT
});

async function check() {
    try {
        const res = await pool.query("SELECT * FROM api_keys LIMIT 5");
        console.log("=== API KEYS SAMPLE ===");
        console.table(res.rows);
    } catch (e) {
        console.error("DB Check failed:", e.message);
    } finally {
        await pool.end();
    }
}
check();
