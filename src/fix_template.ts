import { query } from './db.js';

async function fixTemplate() {
    console.log('Fixing Boutique Fashion user_prompt_template...');
    // Note: the template string has raw dollar signs, 
    // so we use a standard string without typescript interpolation
    const template = "PRODUCT ANALYSIS: ${analysis}\\nUSER INSTRUCTION: ${userPrompt}\\nSELECTED STYLE: ${style}";
    
    try {
        await query("UPDATE prompt_agents SET user_prompt_template = $1 WHERE technical_id = 'boutique-fashion'", [template]);
        console.log('✅ Template updated safely.');
    } catch (e) {
        console.error('❌ Error updating template:', e);
    } finally {
        process.exit(0);
    }
}

fixTemplate();
