import { query } from './db.js';

/**
 * Script para criar a tabela de gestão de mídias da Landing Page
 */
async function migrate() {
    console.log('🚀 Iniciando migração: landing_media...');
    
    try {
        await query(`
            CREATE TABLE IF NOT EXISTS landing_media (
                id SERIAL PRIMARY KEY,
                slot_id VARCHAR(50) UNIQUE NOT NULL,
                media_url TEXT NOT NULL,
                media_type VARCHAR(20) NOT NULL, -- 'image' or 'video'
                description TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('✅ Tabela landing_media criada ou já existente.');

        const seeds = [
            ['hero_video_ugc', '/videos/ugc.mp4', 'video', 'Vídeo UGC flutuante à esquerda no Hero'],
            ['hero_product_img', '/images/conv.png', 'image', 'Imagem de produto flutuante à direita no Hero'],
            ['core_ugc_video_1', '/videos/ugc_hero.mp4', 'video', 'Exemplo UGC 1'],
            ['core_ugc_video_2', '/videos/ugc2.mp4', 'video', 'Exemplo UGC 2'],
            ['core_ugc_video_3', '/videos/ugc_viral_1.mp4', 'video', 'Exemplo UGC 3'],
            ['comparison_before', 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?q=80&w=600&auto=format&fit=crop', 'image', 'Comparação - Antes'],
            ['comparison_after', 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?q=80&w=600&auto=format&fit=crop', 'image', 'Comparação - Depois'],
            ['login_video', '/videos/video_demo.mp4', 'video', 'Vídeo exibido na página de Login/Registo'],
            ['pipeline_video', '/videos/pipeline.mp4', 'video', 'Vídeo demonstrativo do Pipeline Mágico'],
            ['mentes_video', '/videos/mentes.mp4', 'video', 'Vídeo da secção Mentes de Escala'],
            ['musica_video', '/videos/musica.mp4', 'video', 'Vídeo da secção Música & Instrumentais']
        ];

        for (const [slot_id, media_url, media_type, description] of seeds) {
            await query(`
                INSERT INTO landing_media (slot_id, media_url, media_type, description)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (slot_id) DO NOTHING
            `, [slot_id, media_url, media_type, description]);
        }
        
        console.log('✅ Dados iniciais carregados.');
        process.exit(0);
    } catch (err: any) {
        console.error('❌ Erro na migração:', err.message);
        process.exit(1);
    }
}

migrate();
