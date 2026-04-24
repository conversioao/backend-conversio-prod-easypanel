import { query } from './db.js';

async function checkTemplate() {
    try {
        const res = await query("SELECT user_prompt_template FROM prompt_agents WHERE technical_id = 'boutique-fashion'");
        console.log('--- USER PROMPT TEMPLATE IN DB ---');
        console.log(res.rows[0]?.user_prompt_template);
        console.log('----------------------------------');
    } catch (error) {
        console.error('Error:', error);
    } finally {
        process.exit(0);
    }
}

checkTemplate();
