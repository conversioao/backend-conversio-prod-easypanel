const { Pool } = require('pg');

const pool = new Pool({
    host: '161.97.77.110',
    port: 5432,
    user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
    database: 'conversioai',
    ssl: false
});

async function listVideoModels() {
    try {
        const res = await pool.query("SELECT id, name, type, style_id FROM models WHERE type = 'video'");
        console.table(res.rows);
        await pool.end();
    } catch (e) {
        console.error(e);
        await pool.end();
    }
}

listVideoModels();
