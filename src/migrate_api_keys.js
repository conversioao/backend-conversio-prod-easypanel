import pkg from 'pg';
const { Client } = pkg;

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || process.env.DB_PASS,
  database: process.env.DB_NAME || 'conversioai',
});

async function run() {
  try {
    await client.connect();
    console.log('Connected to database to create new tables...');

    // 1. Create api_keys table
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        provider VARCHAR(50) NOT NULL, -- 'openai', 'kie'
        key_secret TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 1, -- 1=Primary, 2=Secondary, 3=Tertiary
        is_active BOOLEAN DEFAULT true,
        status VARCHAR(20) DEFAULT 'working', -- 'working', 'failed'
        last_error TEXT,
        last_used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Table api_keys created/verified.');

    // 2. Create api_usage_stats table
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_usage_stats (
        id SERIAL PRIMARY KEY,
        provider VARCHAR(50) NOT NULL,
        key_id INTEGER REFERENCES api_keys(id),
        agent_name VARCHAR(100),
        tokens_prompt INTEGER DEFAULT 0,
        tokens_completion INTEGER DEFAULT 0,
        cost_estimated DECIMAL(10, 6) DEFAULT 0,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Table api_usage_stats created/verified.');

    // 3. Add index for faster lookup
    await client.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_provider_priority ON api_keys(provider, priority) WHERE is_active = true`);
    
    // 4. Seed with the working OpenAI key provided by the user
    const workingKey = process.env.OPENAI_API_KEY;
    
    if (workingKey) {
        // Check if it already exists
        const checkKey = await client.query("SELECT id FROM api_keys WHERE key_secret = $1", [workingKey]);
        if (checkKey.rows.length === 0) {
            await client.query(`
                INSERT INTO api_keys (provider, key_secret, priority, is_active)
                VALUES ('openai', $1, 1, true)
            `, [workingKey]);
            console.log('Seeded initial OpenAI working key.');
        }
    }

    // 5. Seed Kie API key from current engine .env if present
    const kieKey = process.env.KIE_AI_API_KEY; 
    if (kieKey) {
        const checkKieKey = await client.query("SELECT id FROM api_keys WHERE key_secret = $1", [kieKey]);
        if (checkKieKey.rows.length === 0) {
            await client.query(`
                INSERT INTO api_keys (provider, key_secret, priority, is_active)
                VALUES ('kie', $1, 1, true)
            `, [kieKey]);
            console.log('Seeded initial Kie.ai working key.');
        }
    }

  } catch (err) {
    console.error('DB_ERROR:', err.message);
  } finally {
    await client.end();
  }
}

run();
