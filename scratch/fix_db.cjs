require('dotenv').config({path: './.env'});
const { Pool } = require('pg');
const pool = new Pool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME, port: process.env.DB_PORT });
async function migrate() {
    try {
        await pool.query('ALTER TABLE service_budgets ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT \'{}\'::jsonb;');
        console.log('Column metadata added successfully.');
    } catch(e) {
        console.error('DB Error:', e.message);
    } finally {
        await pool.end();
    }
}
migrate();
