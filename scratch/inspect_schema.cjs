const { Pool } = require('pg');

const pool = new Pool({
    host: '161.97.77.110',
    port: 5432,
    user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
    database: 'conversioai',
    ssl: false
});

async function inspectSchema() {
    try {
        const tables = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
        console.log('--- Tables ---');
        console.log(tables.rows.map(r => r.table_name).join(', '));
        
        console.log('\n--- Generations Table Columns ---');
        const genCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'generations'");
        console.log(genCols.rows.map(r => r.column_name).join(', '));

        console.log('\n--- Transactions Table Columns (if exists) ---');
        try {
            const transCols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions'");
            console.log(transCols.rows.map(r => r.column_name).join(', '));
        } catch(e) { console.log('transactions table does not exist'); }
        
        await pool.end();
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

inspectSchema();
