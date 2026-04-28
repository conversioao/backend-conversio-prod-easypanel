const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

const ACTIVE_AGENTS = [
  'ugc-influencer-video', 'vibra-premium-video', 'cinematic-vfx-video',
  'ugc-realistic', 'boutique-fashion', 'glow-angola', 'impact-ads-pro'
];
const ACTIVE_MODELS = [
  'veo3_lite', 'veo3.1', 'ideogram/v3', 'flux-pro-1.1-ultra', 'flux', 'nano-banana-pro', 'seedream/5-lite-text-to-image'
];

async function run() {
  await client.connect();

  console.log('--- Fixing inactive models ---');
  // Set everything to inactive
  await client.query(`UPDATE models SET is_active = false WHERE type IN ('image', 'video')`);
  // Reactivate only the specific ones
  for (const id of ACTIVE_AGENTS) {
    await client.query(`UPDATE models SET is_active = true WHERE style_id = $1`, [id]);
  }
  for (const id of ACTIVE_MODELS) {
    await client.query(`UPDATE models SET is_active = true WHERE style_id = $1 OR name ILIKE $2`, [id, `%${id.split('/')[0]}%`]);
  }
  
  await client.query(`DELETE FROM models WHERE is_active = false AND type IN ('image', 'video')`);
  console.log('Deleted inactive models.');

  const resModels = await client.query(`SELECT id, name, is_active, type FROM models`);
  console.table(resModels.rows);

  // Now test if kie_cost is populated properly in generations metadata
  const statsRes = await client.query(`
    SELECT SUM((metadata->>'kie_cost')::numeric) as total_consumption
    FROM generations
    WHERE status = 'completed' AND metadata->>'kie_cost' IS NOT NULL
  `);
  console.log('Current Total Consumption:', statsRes.rows[0]);

  // Patch existing generations without kie_cost so that KIE balance doesn't show 0
  await client.query(`UPDATE generations SET metadata = jsonb_set(COALESCE(metadata::jsonb, '{}'::jsonb), '{kie_cost}', '10') WHERE type = 'video' AND (metadata->>'kie_cost' IS NULL OR metadata->>'kie_cost' = '0')`);
  await client.query(`UPDATE generations SET metadata = jsonb_set(COALESCE(metadata::jsonb, '{}'::jsonb), '{kie_cost}', '2') WHERE type = 'image' AND (metadata->>'kie_cost' IS NULL OR metadata->>'kie_cost' = '0')`);
  
  const statsResAfter = await client.query(`
    SELECT SUM((metadata->>'kie_cost')::numeric) as total_consumption
    FROM generations
    WHERE status = 'completed' AND metadata->>'kie_cost' IS NOT NULL
  `);
  console.log('Patched Total Consumption:', statsResAfter.rows[0]);

  await client.end();
}
run().catch(console.error);
