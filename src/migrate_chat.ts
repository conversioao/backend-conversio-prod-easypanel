import { query } from './db.js';

async function migrate() {
    console.log('--- MIGRATION: orchestrator_chat_messages ---');
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS orchestrator_chat_messages (
                id SERIAL PRIMARY KEY,
                user_id UUID REFERENCES users(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_orchestrator_chat_user ON orchestrator_chat_messages(user_id);`);
        console.log('✅ Table created or already exists.');
    } catch (e) {
        console.error('❌ Migration failed:', e);
    } finally {
        process.exit(0);
    }
}

migrate();
