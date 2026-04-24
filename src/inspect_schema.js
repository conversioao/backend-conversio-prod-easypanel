import pg from 'pg';
const { Pool } = pg;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: false
});

const q = (text, params) => pool.query(text, params);

async function run() {
    try {
        // Check ai_models columns
        const cols = await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'ai_models' ORDER BY ordinal_position`);
        console.log('ai_models columns:', JSON.stringify(cols.rows, null, 2));

        // Check service_budgets columns
        const sb = await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'service_budgets' ORDER BY ordinal_position`);
        console.log('service_budgets columns:', JSON.stringify(sb.rows, null, 2));

        // Check current Kie.ai budget
        const budget = await q(`SELECT * FROM service_budgets WHERE service = 'kie'`);
        console.log('kie budget:', JSON.stringify(budget.rows, null, 2));

        // Sample models
        const models = await q(`SELECT id, name, type, credit_cost FROM ai_models LIMIT 5`);
        console.log('sample models:', JSON.stringify(models.rows, null, 2));

        process.exit(0);
    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    }
}

run();
