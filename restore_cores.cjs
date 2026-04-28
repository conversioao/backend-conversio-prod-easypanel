const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

const modelsToInsert = [
  // IMAGE CORES
  { type: 'image', name: 'UGC RealisticLife', style_id: 'ugc-realistic', category: 'core', credit_cost: 2, is_active: true },
  { type: 'image', name: 'Boutique Fashion', style_id: 'boutique-fashion', category: 'core', credit_cost: 4, is_active: true },
  { type: 'image', name: 'GLOWANGOLA PRO', style_id: 'glow-angola', category: 'core', credit_cost: 4, is_active: true },
  { type: 'image', name: 'ImpactAds Pro', style_id: 'impact-ads-pro', category: 'core', credit_cost: 5, is_active: true },

  // VIDEO CORES
  { type: 'video', name: 'REELANGOLA UGC', style_id: 'ugc-influencer-video', category: 'core', credit_cost: 2, is_active: true },
  { type: 'video', name: 'VIBRA PREMIUM', style_id: 'vibra-premium-video', category: 'core', credit_cost: 5, is_active: true },
  { type: 'video', name: 'CINEMATIC VFX', style_id: 'cinematic-vfx-video', category: 'core', credit_cost: 3, is_active: true },

  // IMAGE MODELS
  { type: 'image', name: 'Ideogram V3', style_id: 'ideogram/v3', category: 'model', credit_cost: 1, is_active: true },
  { type: 'image', name: 'Flux Pro 1.1', style_id: 'flux-pro-1.1-ultra', category: 'model', credit_cost: 2, is_active: true },
  { type: 'image', name: 'Nano Banana Pro', style_id: 'nano-banana-pro', category: 'model', credit_cost: 1, is_active: true },
  { type: 'image', name: 'Seedream 5.0', style_id: 'seedream/5-lite-text-to-image', category: 'model', credit_cost: 1, is_active: true },

  // VIDEO MODELS
  { type: 'video', name: 'Veo 3.1 Lite', style_id: 'veo3_lite', category: 'model', credit_cost: 10, is_active: true },
  { type: 'video', name: 'Veo 3.1 Fast', style_id: 'veo3.1', category: 'model', credit_cost: 15, is_active: true },
];

async function run() {
  await client.connect();

  for (const m of modelsToInsert) {
    const res = await client.query('SELECT id FROM models WHERE style_id = $1', [m.style_id]);
    if (res.rows.length === 0) {
      await client.query(
        'INSERT INTO models (type, name, style_id, category, credit_cost, is_active) VALUES ($1, $2, $3, $4, $5, $6)',
        [m.type, m.name, m.style_id, m.category, m.credit_cost, m.is_active]
      );
      console.log(`Inserted: ${m.name}`);
    } else {
      // Just update it
      await client.query(
        'UPDATE models SET name = $1, is_active = $2, type=$3, category=$4, credit_cost=$5 WHERE style_id = $6',
        [m.name, m.is_active, m.type, m.category, m.credit_cost, m.style_id]
      );
      console.log(`Updated: ${m.name}`);
    }
  }

  const all = await client.query('SELECT style_id, name, is_active FROM models WHERE is_active=true');
  console.table(all.rows);

  await client.end();
}
run().catch(console.error);
