
import pkg from 'pg';
const { Client } = pkg;

async function fixDb() {
    const client = new Client({
        connectionString: "postgresql://postgres:GSHCVcBgoA3Q5K4pnsqoU8eo@161.97.77.110:5432/conversioai"
    });

    try {
        await client.connect();
        console.log('Connected to database');
        
        // Ensure sort_order column exists
        await client.query("ALTER TABLE models ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 100");
        
        // Reset all to high number
        await client.query("UPDATE models SET sort_order = 100 + id");
        
        // Set priorities for Nano Banana variants
        await client.query("UPDATE models SET sort_order = 1 WHERE name = 'Nano Banana Lite' AND type = 'image'");
        await client.query("UPDATE models SET sort_order = 2 WHERE name = 'Nano Banana Pro' AND type = 'image'");
        await client.query("UPDATE models SET sort_order = 3 WHERE name = 'Nano Banana 2' AND type = 'image'");
        
        // Specifically check for GlowAngola Pro and make it high
        await client.query("UPDATE models SET sort_order = 105 WHERE name = 'GLOWANGOLA PRO' AND type = 'image'");

        console.log('Database updated successfully.');
        
        const models = await client.query("SELECT id, name, type, sort_order FROM models WHERE type = 'image' ORDER BY sort_order ASC, id ASC");
        console.log('Final image models with sort order:');
        console.table(models.rows);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await client.end();
    }
}

fixDb();
