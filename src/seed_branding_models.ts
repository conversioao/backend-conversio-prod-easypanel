import { query } from './db.js';

async function seedBrandingModels() {
    console.log('Seeding Branding Models...');
    const cores = [
        { name: 'Branding Identity Kit', style_id: 'branding-kit', type: 'core', credit_cost: 20 },
        { name: 'Social Ads Factory', style_id: 'social-ads-kit', type: 'core', credit_cost: 25 },
    ];

    for (const c of cores) {
        // Verifica se existe
        const res = await query('SELECT id FROM models WHERE style_id = $1', [c.style_id]);
        if (res.rows.length === 0) {
            await query(`
                INSERT INTO models (name, style_id, type, credit_cost, is_active)
                VALUES ($1, $2, $3, $4, true)
            `, [c.name, c.style_id, c.type, c.credit_cost]);
            console.log(`Inserted ${c.name}`);
        } else {
            console.log(`${c.name} already exists`);
        }
    }
    console.log('Done!');
    process.exit(0);
}
seedBrandingModels();
