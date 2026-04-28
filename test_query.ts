import { query, pool } from './src/db.js';

async function run() {
    try {
        const plans = await query(`
            SELECT 
                oap.*,
                u.name as approved_by_name
            FROM orchestrator_action_plans oap
            LEFT JOIN users u ON u.id = oap.approved_by
            WHERE status != 'executing'
            ORDER BY priority ASC, suggested_at DESC
            LIMIT 50
        `);
        console.log("Success plans:", plans.rowCount);
    } catch (e) {
        console.error("ERROR plans:", e.message);
    }
    
    try {
        const cols = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'id'
        `);
        console.log("Users.id type:", cols.rows[0]);
    } catch (e) {
        console.error(e);
    }
    pool.end();
}

run();
