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
    console.log('Adicionando kie_cost à tabela models...');
    try {
        await q(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='models' AND column_name='kie_cost') THEN
                    ALTER TABLE models ADD COLUMN kie_cost DECIMAL(10,2) DEFAULT 0;
                END IF;
            END $$;
        `);
        console.log('Sucesso!');
        process.exit(0);
    } catch (e) {
        console.error('Erro:', e.message);
        process.exit(1);
    }
}

run();
