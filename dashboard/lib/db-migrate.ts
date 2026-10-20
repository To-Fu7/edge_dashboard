// Applies dashboard/db/migrations/*.sql in filename order, each in its own
// transaction, recording them in schema_migrations. Runs at server start
// (instrumentation.ts). An advisory lock keeps two dashboard processes from
// migrating at the same time.
import fs from 'fs';
import path from 'path';
import { getPool } from './db';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const LOCK_KEY = 72_001; // arbitrary, constant per application

export async function runMigrations(): Promise<string[]> {
  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d+_.*\.sql$/.test(f)).sort()
    : [];
  const client = await getPool().connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
  }
  return applied;
}
