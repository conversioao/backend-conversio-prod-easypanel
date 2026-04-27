
import pkg from 'pg';
const { Client } = pkg;

async function checkSchema() {
    const client = new Client({
        connectionString: "postgresql://postgres:987654321@161.97.77.110:5432/conversio_ao",
    });

    try {
        await client.connect();
        console.log('Connected to database');
        
        const res = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'models'
        `);
        
        console.log('Models table columns:');
        console.table(res.rows);
        
        const models = await client.query('SELECT name, sort_order FROM models ORDER BY sort_order ASC');
        console.log('Current models with sort order:');
        console.table(models.rows);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

checkSchema();
