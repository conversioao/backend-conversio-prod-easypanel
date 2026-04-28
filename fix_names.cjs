const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

const renameMap = {
  // Image Cores
  'ugc-realistic': 'REELANGOLA UGC',
  'boutique-fashion': 'LUANDALOOKS AGENT',
  'glow-angola': 'GLOWANGOLA PRO',
  'impact-ads-pro': 'VIBRA ANGOLA',
  
  // Video Cores
  'ugc-influencer-video': 'REELANGOLA UGC',
  'vibra-premium-video': 'VIBRA PREMIUM',
  'cinematic-vfx-video': 'CINEMATIC VFX',
};

async function run() {
  await client.connect();

  for (const [styleId, newName] of Object.entries(renameMap)) {
    await client.query(`UPDATE models SET name = $1 WHERE style_id = $2`, [newName, styleId]);
    console.log(`Renamed ${styleId} to ${newName}`);
  }

  const all = await client.query(`SELECT id, name, type, category FROM models ORDER BY type, category`);
  console.table(all.rows);

  await client.end();
}
run().catch(console.error);
