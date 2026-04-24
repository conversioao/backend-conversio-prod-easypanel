import { query } from './src/db.js';

async function run() {
    try {
        const res = await query("SELECT id, category, style_id, name FROM models WHERE category = 'core'");
        console.log("RESULTS:", JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
run();
