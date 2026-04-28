import { query } from './src/db.js';

async function checkSora() {
    try {
        const result = await query("SELECT * FROM models WHERE name ILIKE '%Sora%' OR style_id ILIKE '%sora%'");
        console.log('Sora Models Found:', JSON.stringify(result.rows, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

checkSora();
