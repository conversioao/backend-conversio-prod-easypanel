import { query } from './db.js';

async function migrate() {
    try {
        console.log('[MIGRATION] Criando tabelas de Contas Bancárias e atualizando Transações...');

        // Tabela de Contas Bancárias Cadastradas
        await query(`
            CREATE TABLE IF NOT EXISTS bank_accounts (
                id SERIAL PRIMARY KEY,
                bank_name VARCHAR(100) NOT NULL,
                account_holder VARCHAR(255) NOT NULL,
                iban VARCHAR(100),
                account_number VARCHAR(100),
                multicaixa_reference VARCHAR(100),
                multicaixa_entity VARCHAR(50),
                is_active BOOLEAN DEFAULT true,
                notes TEXT,
                created_at TIMESTAMP DEFAULT now(),
                updated_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[MIGRATION] ✅ Tabela "bank_accounts" criada.');

        // Adicionar colunas de verificação na tabela transactions
        await query(`
            ALTER TABLE transactions
            ADD COLUMN IF NOT EXISTS verification_status VARCHAR(50) DEFAULT 'pending',
            ADD COLUMN IF NOT EXISTS verification_data JSONB DEFAULT '{}',
            ADD COLUMN IF NOT EXISTS verification_notes TEXT,
            ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP,
            ADD COLUMN IF NOT EXISTS verified_by_ai BOOLEAN DEFAULT false;
        `);
        console.log('[MIGRATION] ✅ Colunas de verificação adicionadas em "transactions".');

        // Índices
        await query(`CREATE INDEX IF NOT EXISTS idx_bank_accounts_iban ON bank_accounts(iban);`);
        await query(`CREATE INDEX IF NOT EXISTS idx_bank_accounts_multicaixa ON bank_accounts(multicaixa_reference);`);
        await query(`CREATE INDEX IF NOT EXISTS idx_transactions_verification ON transactions(verification_status);`);

        console.log('[MIGRATION] ✅ Índices criados.');
        console.log('[MIGRATION] Migração de Contas Bancárias concluída com sucesso.');
        process.exit(0);
    } catch (e) {
        console.error('[MIGRATION ERROR]', e);
        process.exit(1);
    }
}

migrate();
