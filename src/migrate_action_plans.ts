import { query } from './db.js';

async function migrate() {
    try {
        console.log('[MIGRATION] Criando tabelas do Orquestrador Inteligente...');

        // Tabela de Planos de Ação do Orquestrador
        await query(`
            CREATE TABLE IF NOT EXISTS orchestrator_action_plans (
                id SERIAL PRIMARY KEY,
                type VARCHAR(50) NOT NULL, -- campaign, nurture, followup, recovery, classification
                title VARCHAR(255) NOT NULL,
                description TEXT NOT NULL,
                priority INTEGER DEFAULT 3, -- 1=Urgente, 2=Alta, 3=Normal
                target_segment JSONB DEFAULT '{}',
                proposed_actions JSONB DEFAULT '[]',
                estimated_impact TEXT,
                status VARCHAR(50) DEFAULT 'pending_approval',
                -- pending_approval, approved, rejected, executing, completed, failed
                suggested_at TIMESTAMP DEFAULT now(),
                approved_at TIMESTAMP,
                approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
                executed_at TIMESTAMP,
                execution_report TEXT,
                notified_admin BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT now()
            );
        `);
        console.log('[MIGRATION] ✅ Tabela "orchestrator_action_plans" criada.');

        // Índices para performance
        await query(`CREATE INDEX IF NOT EXISTS idx_action_plans_status ON orchestrator_action_plans(status);`);
        await query(`CREATE INDEX IF NOT EXISTS idx_action_plans_type ON orchestrator_action_plans(type);`);
        await query(`CREATE INDEX IF NOT EXISTS idx_action_plans_priority ON orchestrator_action_plans(priority);`);

        console.log('[MIGRATION] ✅ Índices criados.');
        console.log('[MIGRATION] Migração de Planos de Ação concluída com sucesso.');
        process.exit(0);
    } catch (e) {
        console.error('[MIGRATION ERROR]', e);
        process.exit(1);
    }
}

migrate();
