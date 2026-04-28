import { query } from './src/db.js';

async function checkPrompt() {
  try {
    const res = await query("SELECT * FROM prompt_agents WHERE technical_id = 'ugc-influencer-video'", []);
    console.log(JSON.stringify(res.rows, null, 2));
  } catch(e: any) {
    console.error(e.message);
  } finally {
    process.exit(0);
  }
}

checkPrompt();
