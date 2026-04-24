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
        console.log('Checking models table...');
        const cols = await q(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'models' ORDER BY ordinal_position`);
        console.log('models columns:', JSON.stringify(cols.rows, null, 2));

        const sampleModels = await q(`SELECT id, name, type, credit_cost, kie_cost FROM models LIMIT 5`);
        console.log('sample models:', JSON.stringify(sampleModels.rows, null, 2));

        console.log('\nChecking service_budgets table...');
        const kieBudget = await q(`SELECT * FROM service_budgets WHERE service = 'kie'`);
        console.log('kie budget:', JSON.stringify(kieBudget.rows, null, 2));

        process.exit(0);
    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    }
}

run();
