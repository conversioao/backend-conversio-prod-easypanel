import pg from 'pg';

const pool = new pg.Pool({
    connectionString: "postgresql://postgres:caesarmac123@localhost:5432/conversio",
});

async function run() {
    try {
        const res = await pool.query("SELECT id, category, style_id, name FROM models WHERE category = 'core'");
        console.log("RESULTS:", JSON.stringify(res.rows, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        pool.end();
    }
}
run();
