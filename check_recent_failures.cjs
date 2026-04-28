const { Pool } = require('pg');
const pool = new Pool({
    host: '161.97.77.110',
    port: 5432,
    user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
    database: 'conversioai',
    ssl: false
});

async function run() {
    const res = await pool.query(`
        SELECT id, type, status, metadata->>'error' as error, metadata->>'apiResponse' as resp 
        FROM generations 
        WHERE status = 'failed' 
        ORDER BY created_at DESC 
        LIMIT 5
    `);
    console.log(JSON.stringify(res.rows, null, 2));
    await pool.end();
}

run().catch(console.error);
