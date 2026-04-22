import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || `postgres://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`
});

async function check() {
  const res = await pool.query("SELECT id, status, metadata->>'title' as title, metadata->>'lyrics' as lyrics, metadata FROM generations WHERE type IN ('musica', 'music') ORDER BY created_at DESC LIMIT 1");
  console.log(JSON.stringify(res.rows, null, 2));
  await pool.end();
}
check();
