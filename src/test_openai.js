import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config(); // Loads .env from current dir

async function testKey(key, name) {
    if (!key) {
        console.log(`[${name}] No key provided.`);
        return;
    }
    const openai = new OpenAI({ apiKey: key });
    try {
        const response = await openai.models.list();
        console.log(`[${name}] ✅ Success!`);
    } catch (err) {
        console.log(`[${name}] ❌ Failed: ${err.message}`);
    }
}

async function run() {
    const key = process.env.OPENAI_API_KEY;
    console.log(`Testing key: ${key ? key.substring(0, 10) + '...' : 'NONE'}`);
    await testKey(key, 'Local .env');
}

run();
