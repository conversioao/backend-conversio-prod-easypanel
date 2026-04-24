const { Client } = require('pg');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

async function check() {
    const config = {
        user: process.env.DB_USER,
        host: process.env.DB_HOST || '161.97.77.110',
        database: process.env.DB_NAME || 'conversioai',
        password: process.env.DB_PASS,
        port: parseInt(process.env.DB_PORT || '5432'),
        ssl: { rejectUnauthorized: false }
    };
    
    console.log('Connecting with config:', { ...config, password: '***' });
    const client = new Client(config);

    try {
        await client.connect();
        
        // Check generations table
        const res = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'generations'
        `);
        console.log('Generations Table Columns:');
        console.table(res.rows);

    } catch (err) {
        console.error('Connection Error:', err.message);
    } finally {
        await client.end();
    }
}

check();
