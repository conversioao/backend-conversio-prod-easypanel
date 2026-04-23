import pkg from 'pg';
const { Client } = pkg;

const client = new Client({
  host: '161.97.77.110',
  port: 5432,
  user: 'postgres',
  password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
  database: 'conversioai',
});

async function run() {
  try {
    await client.connect();
    const res = await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    console.log('Tables:', res.rows.map(r => r.table_name).join(', '));
  } catch (err) {
    console.error('DB_ERROR:', err.message);
  } finally {
    await client.end();
  }
}

run();
