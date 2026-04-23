const { Client } = require('pg');

const config = {
  user: 'postgres',
  host: '161.97.77.110',
  database: 'conversioai',
  password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
  port: 5432,
};

async function migrate() {
  const client = new Client(config);
  try {
    await client.connect();
    console.log('Connected!');

    console.log('Adding updated_at to generations...');
    await client.query(`
      ALTER TABLE generations ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    `);
    console.log('Column added successfully.');

    await client.end();
  } catch (err) {
    console.error('Migration Error:', err.message);
  }
}

migrate();
