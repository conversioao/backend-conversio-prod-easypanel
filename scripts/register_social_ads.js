import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '../.env') });

const { Client } = pg;
const client = new Client({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME
});

async function main() {
    console.log('Connecting to DB:', process.env.DB_HOST);
    await client.connect();
    
    const sql = `
        INSERT INTO models (name, style_id, type, description, credit_cost, is_active, category)
        VALUES (
            'Social Ads Kit', 
            'social-ads-kit', 
            'core', 
            'Gera 6 anúncios variados para redes sociais com consistência visual e textos em português.', 
            25, 
            true, 
            'Marketing'
        )
        ON CONFLICT (style_id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            credit_cost = EXCLUDED.credit_cost,
            category = EXCLUDED.category;
    `;
    
    await client.query(sql);
    console.log('✅ Social Ads Kit registered successfully!');
    await client.end();
}

main().catch(err => {
    console.error('❌ Error registering Social Ads Kit:', err);
    process.exit(1);
});
