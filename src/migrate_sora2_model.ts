import { query } from './db.js';

async function migrate() {
    console.log('🚀 Iniciando registro do modelo Sora 2...');
    
    try {
        // Obter o maior sort_order atual para colocar o Sora no fim (ou quase)
        const maxRes = await query('SELECT MAX(sort_order) as max FROM models');
        const nextSortOrder = (maxRes.rows[0].max || 0) + 1;

        const soraModel = {
            name: 'Sora 2 (OpenAI)',
            style_id: 'sora_2', // Crucial para o Engine ativar lógica de 15s
            type: 'video',
            category: 'model',
            credit_cost: 25,
            is_active: true,
            sort_order: nextSortOrder,
            description: 'Vídeos cinematográficos de alta fidelidade com 15 segundos e consistência visual superior.',
            kie_cost: '0.00'
        };

        const insertQuery = `
            INSERT INTO models (name, style_id, type, category, credit_cost, is_active, sort_order, description, kie_cost)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (style_id) DO UPDATE SET
                name = EXCLUDED.name,
                credit_cost = EXCLUDED.credit_cost,
                is_active = EXCLUDED.is_active,
                description = EXCLUDED.description
            RETURNING id;
        `;

        const res = await query(insertQuery, [
            soraModel.name,
            soraModel.style_id,
            soraModel.type,
            soraModel.category,
            soraModel.credit_cost,
            soraModel.is_active,
            soraModel.sort_order,
            soraModel.description,
            soraModel.kie_cost
        ]);

        console.log(`✅ Modelo Sora 2 registrado com ID: ${res.rows[0].id}`);
        
    } catch (error) {
        console.error('❌ Erro na migração:', error.message);
    } finally {
        process.exit(0);
    }
}

migrate();
