import { query } from './src/db.ts';

async function run() {
    try {
        const res = await query("SELECT id, type, prompt, metadata->>'core_name' as core_name, metadata->>'core_id' as core_id, style FROM generations ORDER BY created_at DESC LIMIT 5");
        console.log("RECENT GENERATIONS:\n", JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}
run();
