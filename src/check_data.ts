import { query } from './db.js';

async function check() {
    try {
        const res = await query('SELECT * FROM credit_packages WHERE is_active = true');
        console.log('Active Credit Packages:', res.rows.length);
        console.log(JSON.stringify(res.rows, null, 2));
        
        const media = await query('SELECT * FROM landing_media');
        console.log('Landing Media Slots:', media.rows.length);
    } catch (e) {
        console.error(e);
    }
}

check();
