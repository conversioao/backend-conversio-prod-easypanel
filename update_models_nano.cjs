const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

async function run() {
  await client.connect();

  // Remove Flux and Ideogram
  await client.query(`DELETE FROM models WHERE name ILIKE '%Flux%' OR name ILIKE '%Ideogram%'`);

  // Ensure Nano Banana Pro and Lite exist
  const liteRes = await client.query(`SELECT id FROM models WHERE name ILIKE '%Nano Banana Lite%'`);
  if (liteRes.rows.length === 0) {
    await client.query(
      `INSERT INTO models (type, name, style_id, category, credit_cost, is_active) VALUES ('image', 'Nano Banana Lite', 'google/nano-banana-edit', 'model', 1, true)`
    );
  }

  const proRes = await client.query(`SELECT id FROM models WHERE name ILIKE '%Nano Banana Pro%'`);
  if (proRes.rows.length === 0) {
      await client.query(
        `INSERT INTO models (type, name, style_id, category, credit_cost, is_active) VALUES ('image', 'Nano Banana Pro', 'nano-banana-pro', 'model', 1, true)`
      );
  }

  // Renaming Video Cores if necessary base on user prompt?
  // Let's make sure the models in the db have category = 'core' vs 'model' correctly.
  
  const all = await client.query(`SELECT * FROM models ORDER BY type, category`);
  console.table(all.rows);

  await client.end();
}
run().catch(console.error);
