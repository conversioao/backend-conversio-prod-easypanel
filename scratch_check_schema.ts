import { query } from './src/db.js';

async function checkSchema() {
    try {
        const result = await query("SELECT * FROM models LIMIT 1");
        console.log('Columns:', Object.keys(result.rows[0] || {}).join(', '));
        console.log('Sample Row:', JSON.stringify(result.rows[0], null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }
}

checkSchema();
