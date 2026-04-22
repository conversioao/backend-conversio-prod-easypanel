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

const query = (text, params) => pool.query(text, params);

async function migrate() {
    console.log('🚀 Migrando api_keys via script ESM...');
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS api_keys (
                id SERIAL PRIMARY KEY,
                provider VARCHAR(50) NOT NULL,
                name VARCHAR(100) NOT NULL,
                key_secret TEXT NOT NULL,
                priority INTEGER DEFAULT 1,
                is_active BOOLEAN DEFAULT true,
                status VARCHAR(20) DEFAULT 'working',
                last_error TEXT,
                last_used_at TIMESTAMP,
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_keys' AND column_name='name') THEN
                    ALTER TABLE api_keys ADD COLUMN name VARCHAR(100) DEFAULT 'Main';
                END IF;
            END $$;
        `);

        await query(`
            ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS unique_provider_name;
            ALTER TABLE api_keys ADD CONSTRAINT unique_provider_name UNIQUE (provider, name);
        `);

        console.log('✅ Migração concluída.');

        const keys = [
            { provider: 'openai', name: 'Principal', key: process.env.OPENAI_API_KEY, priority: 1 },
            { provider: 'openai', name: 'Redundante', key: process.env.OPENAI_API_KEY_ALT, priority: 2 },
            { provider: 'kie', name: 'Fluxo Extra', key: process.env.KIE_AI_API_KEY, priority: 3 }
        ].filter(k => k.key); // Only insert if key exists

        for (const k of keys) {
            await query(`
                INSERT INTO api_keys (provider, name, key_secret, priority, status, is_active, updated_at)
                VALUES ($1, $2, $3, $4, 'working', true, NOW())
                ON CONFLICT (provider, name) 
                DO UPDATE SET key_secret = EXCLUDED.key_secret, priority = EXCLUDED.priority, status = 'working', is_active = true, updated_at = NOW()
            `, [k.provider, k.name, k.key, k.priority]);
        }

        console.log('✅ Chaves pré-configuradas com sucesso.');
        process.exit(0);
    } catch (e) {
        console.error('❌ Erro na migração:', e);
        process.exit(1);
    }
}

migrate();
