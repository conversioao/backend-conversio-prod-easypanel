const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.join(__dirname, '../.env') });
const pool = new Pool({ 
  host: process.env.DB_HOST, 
  port: parseInt(process.env.DB_PORT || '5432'), 
  database: process.env.DB_NAME, 
  user: process.env.DB_USER, 
  password: process.env.DB_PASS, 
  ssl: false 
});

Promise.all([
  pool.query('SELECT COUNT(*) as c FROM users'),
  pool.query('SELECT status, COUNT(*) as c FROM generations GROUP BY status'),
  pool.query("SELECT provider, COUNT(*) as total, SUM(CASE WHEN is_active = true AND status = 'working' THEN 1 ELSE 0 END) as ok FROM api_keys GROUP BY provider"),
  pool.query("SELECT key, value FROM system_settings WHERE key IN ('financial_initial_credits','generation_engine_url','composition_surcharge')"),
  pool.query('SELECT technical_id, name, is_active FROM prompt_agents ORDER BY technical_id'),
  pool.query('SELECT style_id, name, type, category, is_active, credit_cost FROM models WHERE is_active = true ORDER BY type, sort_order'),
  pool.query('SELECT name, price FROM plans ORDER BY price'),
]).then(([u, g, k, s, a, m, p]) => {
  console.log('USERS:', JSON.stringify(u.rows));
  console.log('GEN_STATUS:', JSON.stringify(g.rows));
  console.log('API_KEYS:', JSON.stringify(k.rows));
  console.log('SETTINGS:', JSON.stringify(s.rows));
  console.log('AGENTS:', JSON.stringify(a.rows));
  console.log('MODELS:', JSON.stringify(m.rows));
  console.log('PLANS:', JSON.stringify(p.rows));
  pool.end();
}).catch(e => { 
  console.error('DB AUDIT ERROR:', e.message); 
  pool.end(); 
  process.exit(1);
});
