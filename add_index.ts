import { query } from './src/db.js';

async function run() {
    try {
        console.log('Adding index to generations(created_at DESC)...');
        await query('CREATE INDEX IF NOT EXISTS idx_generations_created_at_desc ON generations(created_at DESC)');
        console.log('Index created successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Error creating index:', err);
        process.exit(1);
    }
}

run();
