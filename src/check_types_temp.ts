import { query } from './db.js';

async function checkTypes() {
    try {
        const res = await query('SELECT DISTINCT type FROM generations');
        console.log('Types found:', res.rows.map(r => r.type));
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}

checkTypes();
