// PostgreSQL access for the dashboard — database `edge`, role edge_owner.
//
// The connection itself is the one piece of configuration that can't live in
// the database, so it comes from the environment (dashboard/.env, written by
// setup/install.sh). Camera containers get a different role (edge_device) —
// see deviceDbEnv() and db/migrations/001_edge_schema.sql for its grants.
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function dbConfig(): DbConfig {
  return {
    host: process.env.EDGE_DB_HOST || 'env_services_timescaledb',
    port: parseInt(process.env.EDGE_DB_PORT || '5432', 10),
    database: process.env.EDGE_DB_NAME || 'edge',
    user: process.env.EDGE_DB_USER || 'edge_owner',
    password: process.env.EDGE_DB_PASSWORD || '',
  };
}

/** Env passed to camera containers: same server and database, restricted role. */
export function deviceDbEnv(): Record<string, string> {
  const c = dbConfig();
  return {
    EDGE_DB_HOST: c.host,
    EDGE_DB_PORT: String(c.port),
    EDGE_DB_NAME: c.database,
    EDGE_DB_USER: process.env.EDGE_DEVICE_DB_USER || 'edge_device',
    EDGE_DB_PASSWORD: process.env.EDGE_DEVICE_DB_PASSWORD || '',
  };
}

// Survives Next's dev-mode module reloads, so we don't leak a pool per edit.
const g = globalThis as unknown as { __edgePool?: Pool };

export function getPool(): Pool {
  if (!g.__edgePool) {
    g.__edgePool = new Pool({ ...dbConfig(), max: 10, connectionTimeoutMillis: 5000 });
    g.__edgePool.on('error', err => console.error('[db] idle client error:', err.message));
  }
  return g.__edgePool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await getPool().query<T>(sql, params);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Human-readable reason the database is unusable, for API errors and the UI. */
export function describeDbError(e: unknown): string {
  const err = e as { code?: string; message?: string };
  const c = dbConfig();
  switch (err.code) {
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
    case 'EAI_AGAIN':
      return `Database ${c.host}:${c.port} is not reachable (${err.code}). Check that PostgreSQL is running and EDGE_DB_HOST in dashboard/.env is correct.`;
    case '28P01':
      return `Database login failed for role ${c.user}. Check EDGE_DB_USER / EDGE_DB_PASSWORD in dashboard/.env.`;
    case '3D000':
      return `Database "${c.database}" does not exist. Run setup/install.sh (step infra) to create it.`;
    default:
      return err.message || String(e);
  }
}
