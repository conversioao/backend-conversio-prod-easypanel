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
        const res = await pool.query("SELECT id, provider, is_active, last_failure_reason FROM api_keys WHERE provider IN ('openai', 'kie')");
        console.log("=== API KEYS STATUS ===");
        console.table(res.rows);
        
        // Check if any keys are inactive and why
        const inactive = res.rows.filter(r => !r.is_active);
        if (inactive.length > 0) {
            console.log("\nFound inactive keys. Attempting to reactivate for testing if they were just temporarily glitched.");
            // Actually, I'll just report first.
        }
    } catch (e) {
        console.error("DB Check failed:", e.message);
    } finally {
        await pool.end();
    }
}
check();
