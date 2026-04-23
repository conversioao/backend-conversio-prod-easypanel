const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: 'backend/.env' });

const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

async function check() {
    try {
        const models = await pool.query("SELECT id, name, type, credit_cost FROM models WHERE type = 'audio'");
        console.log('--- MODELS ---');
        console.table(models.rows);
        
        const schema = await pool.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'credits'");
        console.log('--- USERS CREDITS SCHEMA ---');
        console.table(schema.rows);
        
        const topUser = await pool.query("SELECT id, name, credits FROM users ORDER BY credits DESC LIMIT 1");
        console.log('--- TOP USER (CREDITS) ---');
        console.table(topUser.rows);

    } catch (e) {
        console.error(e);
    } finally {
        await pool.end();
    }
}

check();
