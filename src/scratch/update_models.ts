import pkg from 'pg';
const { Client } = pkg;
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../../.env') });

const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

async function main() {
    try {
        await client.connect();
        
        console.log('--- ATUALIZANDO MODELOS NA BD ---');

        // 1. GPT Image 2
        await client.query(`
            INSERT INTO models (name, type, style_id, category, credit_cost, is_active, sort_order, kie_cost)
            VALUES ('GPT Image 2', 'image', 'gpt-image-2-image-to-image', 'model', 15, true, 1, '20.00')
            ON CONFLICT (style_id) DO UPDATE SET 
                name = EXCLUDED.name,
                is_active = true,
                credit_cost = 15;
        `);
        console.log('✅ GPT Image 2 adicionado/atualizado.');

        // 2. Veo 3.1 Quality
        await client.query(`
            INSERT INTO models (name, type, style_id, category, credit_cost, is_active, sort_order, kie_cost)
            VALUES ('Veo 3.1 Quality', 'video', 'veo3', 'model', 64, true, 260, '120.00')
            ON CONFLICT (style_id) DO UPDATE SET 
                name = EXCLUDED.name,
                is_active = true,
                credit_cost = 64;
        `);
        console.log('✅ Veo 3.1 Quality adicionado/atualizado.');

        // 3. Veo 3.1 Fast
        await client.query(`
            UPDATE models SET 
                name = 'Veo 3.1 Fast',
                is_active = true,
                credit_cost = 32,
                kie_cost = '60.00'
            WHERE style_id = 'veo3_fast';
        `);
        console.log('✅ Veo 3.1 Fast ativado e atualizado.');

        // 4. Veo 3.1 Lite
        await client.query(`
            UPDATE models SET 
                name = 'Veo 3.1 Lite',
                is_active = true,
                credit_cost = 16,
                kie_cost = '30.00'
            WHERE style_id = 'veo3_lite';
        `);
        console.log('✅ Veo 3.1 Lite atualizado.');

        console.log('--- SUCESSO ---');
    } catch (err) {
        console.error('❌ Erro ao atualizar BD:', err);
    } finally {
        await client.end();
    }
}

main();
