import { query } from './src/db.js';

async function updateVeoFast() {
    try {
        const result = await query(
            "UPDATE models SET style_id = 'veo3_fast' WHERE name = 'Veo 3.1 Fast' AND type = 'video' RETURNING id, name, style_id"
        );
        if (result.rows.length > 0) {
            console.log('✅ Modelo atualizado:', JSON.stringify(result.rows[0], null, 2));
        } else {
            console.warn('⚠️ Modelo "Veo 3.1 Fast" não encontrado ou já atualizado.');
        }
    } catch (e) {
        console.error('❌ Erro na atualização:', e.message);
    } finally {
        process.exit(0);
    }
}

updateVeoFast();
