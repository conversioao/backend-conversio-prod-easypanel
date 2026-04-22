import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

// Carregar variáveis de ambiente
dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'conversioao',
  ssl: false,
  connectionTimeoutMillis: 15000,
});

function escapeValue(val: any): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'number') return String(val);
  if (val instanceof Date) return `'${val.toISOString()}'`;
  if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'`;
  // Strings — escape single quotes
  return `'${String(val).replace(/'/g, "''")}'`;
}

/**
 * Executa o backup completo da base de dados
 */
export async function runFullBackup() {
  const client = await pool.connect();
  const date = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(process.cwd(), 'backups');
  
  // Garantir diretório de backups
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const outFileName = `backup_conversio_ao_${date}.sql`;
  const outFile = path.join(outDir, outFileName);
  const lines: string[] = [];

  console.log('🔌 Conectado ao PostgreSQL para Backup:', pool.options.host);

  lines.push(`-- =====================================================`);
  lines.push(`-- BACKUP COMPLETO (SISTEMA DE MONITORIZAÇÃO) — ${pool.options.database}`);
  lines.push(`-- Data: ${new Date().toISOString()}`);
  lines.push(`-- Host: ${pool.options.host}`);
  lines.push(`-- =====================================================`);
  lines.push(``);
  lines.push(`SET client_encoding = 'UTF8';`);
  lines.push(`SET standard_conforming_strings = on;`);
  lines.push(`SET check_function_bodies = false;`);
  lines.push(`SET xmloption = content;`);
  lines.push(`SET client_min_messages = warning;`);
  lines.push(`SET row_security = off;`);
  lines.push(``);
  
  lines.push(`SET session_replication_role = 'replica';`);
  lines.push(``);

  // 1. Listar todas as tabelas
  const tablesRes = await client.query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);

  const tables: string[] = tablesRes.rows.map((r: any) => r.tablename);
  
  // 2. Exportar tabelas
  for (const table of tables) {
    const colsRes = await client.query(`
      SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `, [table]);

    lines.push(`-- Tabela: ${table}`);
    lines.push(`DROP TABLE IF EXISTS "${table}" CASCADE;`);
    lines.push(`CREATE TABLE "${table}" (`);

    const colDefs = colsRes.rows.map((col: any) => {
      let def = `  "${col.column_name}" ${col.data_type}`;
      if (col.character_maximum_length) def += `(${col.character_maximum_length})`;
      if (col.column_default) def += ` DEFAULT ${col.column_default}`;
      if (col.is_nullable === 'NO') def += ` NOT NULL`;
      return def;
    });

    const pkRes = await client.query(`
      SELECT tc.constraint_name, kcu.column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
    `, [table]);

    if (pkRes.rows.length > 0) {
      const pkName = pkRes.rows[0].constraint_name;
      const pkCols = pkRes.rows.map((r: any) => `"${r.column_name}"`).join(', ');
      colDefs.push(`  CONSTRAINT "${pkName}" PRIMARY KEY (${pkCols})`);
    }

    lines.push(colDefs.join(',\n'));
    lines.push(`);`);
    lines.push(``);

    // Indices
    const indexRes = await client.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = $1
      AND indexname NOT IN (SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = $1)
    `, [table]);
    for (const idx of indexRes.rows) lines.push(`${idx.indexdef};`);

    // Dados
    const dataRes = await client.query(`SELECT * FROM "${table}"`);
    if (dataRes.rows.length > 0) {
      const colNames = dataRes.fields.map((f: any) => `"${f.name}"`).join(', ');
      const BATCH_SIZE = 500;
      for (let i = 0; i < dataRes.rows.length; i += BATCH_SIZE) {
        const batch = dataRes.rows.slice(i, i + BATCH_SIZE);
        const valuesList = batch.map(row => `(${dataRes.fields.map((f: any) => escapeValue(row[f.name])).join(', ')})`).join(',\n  ');
        lines.push(`INSERT INTO "${table}" (${colNames}) VALUES \n  ${valuesList}\nON CONFLICT DO NOTHING;`);
      }
    }
    lines.push(``);
  }

  // FKs
  for (const table of tables) {
    const fkRes = await client.query(`
      SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.table_name = $1 AND tc.constraint_type = 'FOREIGN KEY'
    `, [table]);
    for (const fk of fkRes.rows) {
      lines.push(`ALTER TABLE ONLY "${table}" ADD CONSTRAINT "${fk.constraint_name}" FOREIGN KEY ("${fk.column_name}") REFERENCES "${fk.foreign_table_name}"("${fk.foreign_column_name}") ON DELETE CASCADE;`);
    }
  }

  lines.push(`SET session_replication_role = 'origin';`);
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  
  console.log(`✅ Backup Automático Concluído: ${outFileName}`);
  
  client.release();
  return { success: true, file: outFile, name: outFileName };
}

// Permitir execução via CLI se chamado diretamente
if (import.meta.url.endsWith(path.basename(process.argv[1]))) {
  runFullBackup()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('❌ Erro no backup:', err.message);
      process.exit(1);
    });
}

