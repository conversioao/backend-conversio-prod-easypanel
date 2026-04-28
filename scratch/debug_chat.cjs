const { query } = require('../dist/db.js');
const { keyManager } = require('../dist/services/KeyManager.js');
require('dotenv').config();

async function testChat() {
    console.log('--- Testing Orchestrator Chat Logic ---');
    try {
        // Mock user (assuming there's a user in the DB)
        const userRes = await query('SELECT id FROM users LIMIT 1');
        const userId = userRes.rows[0]?.id;
        
        if (!userId) {
            console.error('No user found in DB to test with.');
            return;
        }

        console.log('Testing with userId:', userId);

        const message = "Olá Orquestrador, como está o sistema?";

        // 1. Fetch Chat History
        console.log('Fetching history...');
        const historyRes = await query(`
            SELECT role, content FROM orchestrator_chat_messages 
            WHERE user_id = $1 
            ORDER BY created_at DESC 
            LIMIT 10
        `, [userId]).catch(e => { console.error('History Query Failed:', e.message); throw e; });
        console.log('History fetched:', historyRes.rows.length);

        // 2. Build Context
        console.log('Building context...');
        const agentsCount = await query(`SELECT COUNT(*) FROM agents`).catch(e => ({ rows: [{ count: 0 }] }));
        const pendingTasks = await query(`SELECT COUNT(*) FROM agent_tasks WHERE status = 'pending'`).catch(e => ({ rows: [{ count: 0 }] }));
        const recentErrors = await query(`SELECT COUNT(*) FROM agent_logs WHERE result = 'error' AND created_at > NOW() - INTERVAL '24 hours'`).catch(e => ({ rows: [{ count: 0 }] }));
        
        console.log('Context built.');

        // 3. OpenAI
        console.log('Getting OpenAI key...');
        const apiKeyObj = await keyManager.getWorkingKey('openai');
        if (!apiKeyObj) {
            console.error('No OpenAI key available.');
            return;
        }
        console.log('Key found.');

        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: apiKeyObj.key_secret });
        
        console.log('Calling OpenAI...');
        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [{ role: 'user', content: message }],
        });
        console.log('OpenAI Reply:', completion.choices[0].message.content);

        // 4. Persistence
        console.log('Persisting message...');
        await query(`INSERT INTO orchestrator_chat_messages (user_id, role, content) VALUES ($1, $2, $3)`, [userId, 'user', message]);
        console.log('Success!');

    } catch (e) {
        console.error('TEST FAILED:', e.stack);
    }
}

testChat();
