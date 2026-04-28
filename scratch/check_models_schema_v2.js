
import pkg from 'pg';
const { Client } = pkg;

async function checkSchema() {
    const client = new Client({
        connectionString: "postgresql://postgres:GSHCVcBgoA3Q5K4pnsqoU8eo@161.97.77.110:5432/conversioai"
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
        
        const models = await client.query("SELECT id, name, type, sort_order FROM models WHERE type = 'image' ORDER BY sort_order ASC, id ASC");
        console.log('Current image models with sort order:');
        console.table(models.rows);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

checkSchema();
