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

async function migrate() {
    console.log('🚀 Criando tabelas de gestão de serviços externos...');
    try {
        // Tabela de orçamentos/saldos dos serviços externos (atualizado manualmente)
        await q(`
            CREATE TABLE IF NOT EXISTS service_budgets (
                id SERIAL PRIMARY KEY,
                service VARCHAR(50) NOT NULL UNIQUE,
                credit_balance DECIMAL(12,4) DEFAULT 0,
                credit_purchased DECIMAL(12,4) DEFAULT 0,
                dollar_balance DECIMAL(12,4) DEFAULT 0,
                dollar_purchased DECIMAL(12,4) DEFAULT 0,
                token_budget BIGINT DEFAULT 0,
                tokens_purchased BIGINT DEFAULT 0,
                cost_per_unit DECIMAL(12,8) DEFAULT 0,
                platform_markup DECIMAL(5,4) DEFAULT 0,
                notes TEXT,
                updated_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // Seed inicial com Kie.ai e OpenAI
        await q(`
            INSERT INTO service_budgets (service, credit_balance, credit_purchased, dollar_balance, dollar_purchased, token_budget, tokens_purchased, cost_per_unit, platform_markup)
            VALUES 
                ('kie', 720.50, 720.50, 0, 0, 0, 0, 0.003, 0.30),
                ('openai', 0, 0, 50.00, 50.00, 10000000, 10000000, 0.00015, 0.20)
            ON CONFLICT (service) DO NOTHING;
        `);

        console.log('✅ service_budgets criada e inicializada.');

        // Garantir que api_usage_stats tem colunas necessárias
        await q(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='api_usage_stats' AND column_name='agent_name') THEN
                    ALTER TABLE api_usage_stats ADD COLUMN agent_name VARCHAR(100);
                END IF;
            END $$;
        `);

        console.log('✅ Migração concluída com sucesso!');
        process.exit(0);
    } catch (e) {
        console.error('❌ Erro:', e.message);
        process.exit(1);
    }
}

migrate();
