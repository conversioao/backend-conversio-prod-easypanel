import { query } from './db.js';

async function updateSkinToneRules() {
    console.log('[MIGRATION] Atualizando regras de tom de pele nos agentes...');

    try {
        // 1. ReelAngola (ugc-realistic)
        const ugcRes = await query('SELECT system_prompt FROM prompt_agents WHERE technical_id = $1', ['ugc-realistic']);
        if (ugcRes.rows[0]) {
            let prompt = ugcRes.rows[0].system_prompt;
            prompt = prompt.replace(/MODELS\s*•.*Beautiful Angolan women or handsome Angolan men\./s, 
`MODELS (MANDATORY)
• ALL MODELS MUST BE BLACK OR BROWN-SKINNED PEOPLE (PESSOAS NEGRAS E MORENAS).
• Naturally textured skin — zero beauty retouching.
• Beautiful Angolan women or handsome Angolan men with Angolan features.`);
            
            await query('UPDATE prompt_agents SET system_prompt = $1 WHERE technical_id = $2', [prompt, 'ugc-realistic']);
            console.log('✅ Regra aplicada ao ReelAngola UGC.');
        }

        // 2. GlowAngola (glow-angola)
        const glowRes = await query('SELECT system_prompt FROM prompt_agents WHERE technical_id = $1', ['glow-angola']);
        if (glowRes.rows[0]) {
            let prompt = glowRes.rows[0].system_prompt;
            prompt = prompt.replace(/MODELS\s*•.*Beautiful Angolan women and handsome Angolan men/s, 
`MODELS (MANDATORY)
• ALL MODELS MUST BE BLACK OR BROWN-SKINNED PEOPLE (PESSOAS NEGRAS E MORENAS).
• Naturally textured skin — zero beauty retouching.
• Beautiful Angolan women or handsome Angolan men with Angolan features.`);

            await query('UPDATE prompt_agents SET system_prompt = $1 WHERE technical_id = $2', [prompt, 'glow-angola']);
            console.log('✅ Regra aplicada ao GlowAngola PRO.');
        }

        // 3. LuandaLooks (boutique-fashion)
        const boutiqueRes = await query('SELECT system_prompt FROM prompt_agents WHERE technical_id = $1', ['boutique-fashion']);
        if (boutiqueRes.rows[0]) {
            let prompt = boutiqueRes.rows[0].system_prompt;
            prompt = prompt.replace(/MODELS & REPRESENTATION:.*not smiling generically/s, 
`MODELS & REPRESENTATION (MANDATORY):
- ALL MODELS MUST BE BLACK OR BROWN-SKINNED PEOPLE (PESSOAS NEGRAS E MORENAS).
- Reflect the Angolan market with pure African features.
- Models should have natural Black hairstyles (afros, braids, locs, curls, twists).
- Expressions: fierce, confident, editorial — not smiling generically.`);

            await query('UPDATE prompt_agents SET system_prompt = $1 WHERE technical_id = $2', [prompt, 'boutique-fashion']);
            console.log('✅ Regra aplicada ao LuandaLooks Agent.');
        }

        console.log('\n🚀 Regras de representação racial atualizadas com sucesso!');
    } catch (e) {
        console.error('❌ Erro ao atualizar regras de pele:', e);
    } finally {
        process.exit(0);
    }
}

updateSkinToneRules();
