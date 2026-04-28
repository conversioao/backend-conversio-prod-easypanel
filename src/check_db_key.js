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
    const res = await client.query("SELECT value FROM system_settings WHERE key = 'openai_api_key'");
    if (res.rows.length > 0) {
        console.log('DB_OPENAI_KEY=' + res.rows[0].value);
    } else {
        console.log('DB_OPENAI_KEY=NOT_FOUND');
    }
  } catch (err) {
    console.error('DB_ERROR:', err.message);
  } finally {
    await client.end();
  }
}

run();
