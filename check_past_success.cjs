const { Pool } = require('pg');
const pool = new Pool({
    host: '161.97.77.110', port: 5432, user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo', database: 'conversioai', ssl: false
});

async function checkPastSuccess() {
    console.log('--- BUSCANDO MODELOS QUE FUNCIONARAM NO PASSADO ---');
    const res = await pool.query(`
        SELECT DISTINCT metadata->>'model' as model, metadata->>'taskId' as task_id
        FROM agent_logs 
        WHERE result = 'success' AND action = 'MODEL_TEST_OK'
        ORDER BY model
    `);
    console.log('Modelos de MODEL_TEST_OK:', res.rows);

    const res2 = await pool.query(`
        SELECT DISTINCT metadata->>'model' as model
        FROM generations 
        WHERE status = 'completed'
        ORDER BY model
    `);
    console.log('Modelos de gerações concluídas:', res2.rows);
    
    await pool.end();
}

checkPastSuccess();
