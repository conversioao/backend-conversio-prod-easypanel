const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: false
});

async function updateModels() {
    try {
        console.log('🚀 Starting Database Alignment for Image Models...');

        // 1. Move all existing image models to a higher sort_order
        await pool.query("UPDATE models SET sort_order = id + 10 WHERE type = 'image' AND category = 'model'");
        console.log('✅ Reset existing model sort orders.');

        // 2. Update Nano Banana Lite (Priority 1)
        // Style ID: google/nano-banana-edit
        const liteRes = await pool.query(
            "UPDATE models SET sort_order = 1, name = 'Nano Banana Lite' WHERE style_id = 'google/nano-banana-edit' OR id = 165 RETURNING id"
        );
        if (liteRes.rows.length > 0) {
            console.log(`✅ Updated Nano Banana Lite (ID: ${liteRes.rows[0].id}) to Priority 1.`);
        } else {
            console.log('⚠️ Nano Banana Lite not found, inserting...');
            await pool.query(
                "INSERT INTO models (name, style_id, category, type, sort_order, credit_cost, kie_cost) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                ['Nano Banana Lite', 'google/nano-banana-edit', 'model', 'image', 1, 1, 0.05]
            );
        }

        // 3. Update Nano Banana Pro (Priority 2)
        const proRes = await pool.query(
            "UPDATE models SET sort_order = 2, name = 'Nano Banana Pro' WHERE style_id = 'nano-banana-pro' OR id = 121 RETURNING id"
        );
        if (proRes.rows.length > 0) {
            console.log(`✅ Updated Nano Banana Pro (ID: ${proRes.rows[0].id}) to Priority 2.`);
        } else {
            console.log('⚠️ Nano Banana Pro not found, inserting...');
            await pool.query(
                "INSERT INTO models (name, style_id, category, type, sort_order, credit_cost, kie_cost) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                ['Nano Banana Pro', 'nano-banana-pro', 'model', 'image', 2, 1, 0.1]
            );
        }

        // 4. Update or Insert Nano Banana 2 (Priority 3)
        const v2Res = await pool.query(
            "UPDATE models SET sort_order = 3, name = 'Nano Banana 2' WHERE style_id = 'nano-banana-2' RETURNING id"
        );
        if (v2Res.rows.length > 0) {
            console.log(`✅ Updated Nano Banana 2 (ID: ${v2Res.rows[0].id}) to Priority 3.`);
        } else {
            console.log('➕ Inserting Nano Banana 2 at Priority 3...');
            await pool.query(
                "INSERT INTO models (name, style_id, category, type, sort_order, credit_cost, kie_cost) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                ['Nano Banana 2', 'nano-banana-2', 'model', 'image', 3, 1, 0.15]
            );
        }

        console.log('🏁 Database Alignment Complete.');

    } catch (err) {
        console.error('❌ Error during update:', err.message);
    } finally {
        await pool.end();
    }
}

updateModels();
