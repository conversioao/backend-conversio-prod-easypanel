import { query } from './src/db.js';

async function checkModels() {
    try {
        const result = await query("SELECT * FROM models WHERE type = 'video'");
        console.log('Video Models:', JSON.stringify(result.rows, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

checkModels();
