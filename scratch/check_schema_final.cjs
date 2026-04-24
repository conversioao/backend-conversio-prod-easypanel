const { Client } = require('pg');

const config = {
  user: 'postgres',
  host: '161.97.77.110',
  database: 'conversioai',
  password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
  port: 5432,
};

async function check() {
  const client = new Client(config);
  try {
    await client.connect();
    console.log('Connected!');

    // Check generations
    const genRes = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'generations'
    `);
    console.log('Generations columns:', genRes.rows.map(r => r.column_name).join(', '));

    // Check system_settings
    const setRes = await client.query('SELECT * FROM system_settings');
    console.log('System settings rows:', setRes.rows.length);
    console.log('Available keys:', setRes.rows.map(r => r.key).join(', '));

    await client.end();
  } catch (err) {
    console.error('Connection Error:', err.stack);
  }
}

check();
