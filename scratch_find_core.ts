import { query } from './src/db.js';

async function findCore() {
    try {
        const result = await query("SELECT id, name, style_id, type FROM models WHERE type = 'video'");
        console.log('Video Models:', JSON.stringify(result.rows, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

findCore();
