
import pkg from 'pg';
const { Client } = pkg;

async function checkStyleIds() {
    const client = new Client({
        connectionString: "postgresql://postgres:GSHCVcBgoA3Q5K4pnsqoU8eo@161.97.77.110:5432/conversioai"
    });

    try {
        await client.connect();
        
        const models = await client.query("SELECT id, name, style_id, sort_order FROM models WHERE name LIKE 'Nano Banana%' ORDER BY sort_order ASC");
        console.table(models.rows);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

checkStyleIds();
