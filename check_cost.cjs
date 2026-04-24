const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

async function run() {
  await client.connect();
  const res = await client.query(`SELECT metadata->>'kie_cost' as kie_cost, cost, metadata FROM generations ORDER BY created_at DESC LIMIT 5`);
  console.log(JSON.stringify(res.rows, null, 2));

  const statsRes = await client.query(`
    SELECT SUM((metadata->>'kie_cost')::numeric) as total_consumption
    FROM generations
    WHERE status = 'completed' AND metadata->>'kie_cost' IS NOT NULL
  `);
  console.log('Total Consumption:', statsRes.rows[0]);

  await client.end();
}
run();
