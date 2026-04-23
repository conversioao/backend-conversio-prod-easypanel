const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

const pool = new Pool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

const MODELS = [
    {
        name: 'Veo 3.1 Lite',
        type: 'video',
        category: 'model',
        style_id: 'veo3_fast',
        credit_cost: 15,
        is_active: true
    },
    {
        name: 'Sora 2',
        type: 'video',
        category: 'model',
        style_id: 'sora-2',
        credit_cost: 25,
        is_active: true
    }
];

async function sync() {
    console.log('🚀 Syncing Video Models...');
    const client = await pool.connect();
    try {
        for (const m of MODELS) {
            console.log(`📝 Syncing model: ${m.name}...`);
            
            // Manual Check since ON CONFLICT is missing a unique index
            const check = await client.query(
                'SELECT id FROM models WHERE name = $1 AND type = $2',
                [m.name, m.type]
            );

            if (check.rows.length > 0) {
                await client.query(`
                    UPDATE models 
                    SET style_id = $1, credit_cost = $2, is_active = $3, category = $4 
                    WHERE id = $5
                `, [m.style_id, m.credit_cost, m.is_active, m.category, check.rows[0].id]);
            } else {
                await client.query(`
                    INSERT INTO models (name, type, category, style_id, credit_cost, is_active)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `, [m.name, m.type, m.category, m.style_id, m.credit_cost, m.is_active]);
            }
        }
        console.log('✅ Video models synced!');
    } catch (err) {
        console.error('❌ Error:', err);
    } finally {
        client.release();
        await pool.end();
    }
}

sync();
