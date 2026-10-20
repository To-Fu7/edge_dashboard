// Reset (or create) a dashboard account from the command line — for when no
// admin can sign in any more.
//
//   docker exec -it edge-dashboard node db/reset-password.js <username> <new-password> [admin|user]
//
// Same scrypt format as lib/auth.ts. The role defaults to admin; existing
// sessions of that user are ended.
const crypto = require('crypto');
const { Client } = require('pg');

async function main() {
  const [username, password, role = 'admin'] = process.argv.slice(2);
  if (!username || !password || !['admin', 'user'].includes(role)) {
    console.error('usage: node db/reset-password.js <username> <new-password> [admin|user]');
    process.exit(2);
  }
  const N = 16384, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64, { N, r, p });
  const hash = `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
  const client = new Client({
    host: process.env.EDGE_DB_HOST || 'env_services_timescaledb',
    port: parseInt(process.env.EDGE_DB_PORT || '5432', 10),
    database: process.env.EDGE_DB_NAME || 'edge',
    user: process.env.EDGE_DB_USER || 'edge_owner',
    password: process.env.EDGE_DB_PASSWORD || '',
  });
  await client.connect();
  try {
    const res = await client.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, updated_at = now()
       RETURNING id, (xmax = 0) AS created`,
      [username, hash, role]);
    await client.query('DELETE FROM sessions WHERE user_id = $1', [res.rows[0].id]);
    console.log(`${res.rows[0].created ? 'Created' : 'Updated'} ${username} (${role}).`);
  } finally {
    await client.end();
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
