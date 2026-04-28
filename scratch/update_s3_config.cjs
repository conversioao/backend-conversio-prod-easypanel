const { Pool } = require('pg');

const pool = new Pool({
    host: '161.97.77.110',
    port: 5432,
    user: 'postgres',
    password: 'GSHCVcBgoA3Q5K4pnsqoU8eo',
    database: 'conversioai',
    ssl: false
});

async function updateS3() {
    try {
        await pool.query("UPDATE system_settings SET value = 'auto', updated_at = NOW() WHERE key = 'storage_region'");
        console.log('Successfully updated storage_region to auto in DB');
        await pool.end();
    } catch (e) {
        console.error('Error updating S3 config:', e);
        await pool.end();
        process.exit(1);
    }
}

updateS3();
