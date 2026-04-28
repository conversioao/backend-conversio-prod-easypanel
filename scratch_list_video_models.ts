import { query } from './src/db.js';

async function listVideoModels() {
    try {
        const result = await query("SELECT * FROM models WHERE type = 'video'");
        console.table(result.rows);
    } catch (e) {
        console.error('Error:', e.message);
    }
}

listVideoModels();
