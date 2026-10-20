// Users and sessions in PostgreSQL. Passwords are scrypt hashes; the session
// cookie (lib/auth-token.ts) carries a random token whose sha256 is the
// sessions row id, so a stolen database can't be replayed as cookies and a
// deleted session stops working immediately.
import crypto from 'crypto';
import { promisify } from 'util';
import { query, queryOne } from './db';
import { encodeToken, hashSessionToken, verifyToken, SESSION_TTL_S, type Role } from './auth-token';

const scrypt = promisify(crypto.scrypt) as (pw: crypto.BinaryLike, salt: crypto.BinaryLike, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export interface SessionUser {
  id: string;
  username: string;
  role: Role;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, n, r, p, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: +n, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

/** First start: create the default accounts (changing them is deferred). */
export async function seedDefaultUsers(): Promise<boolean> {
  const row = await queryOne<{ n: string }>('SELECT count(*)::text AS n FROM users');
  if (row && row.n !== '0') return false;
  await query('INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3), ($4, $5, $6) ON CONFLICT (username) DO NOTHING', [
    'admin', await hashPassword('admin'), 'admin',
    'user', await hashPassword('user'), 'user',
  ]);
  return true;
}

export async function authenticate(username: string, password: string): Promise<SessionUser | null> {
  const u = await queryOne<SessionUser & { password_hash: string }>(
    'SELECT id, username, role, password_hash FROM users WHERE username = $1', [username]);
  // Hash anyway on unknown users so timing doesn't reveal which usernames exist.
  if (!u) { await hashPassword(password); return null; }
  if (!(await verifyPassword(password, u.password_hash))) return null;
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
  return { id: u.id, username: u.username, role: u.role };
}

export async function createSession(user: SessionUser, userAgent: string | null, ip: string | null): Promise<{ cookie: string; maxAge: number }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
  await query(
    'INSERT INTO sessions (id, user_id, expires_at, user_agent, ip) VALUES ($1, $2, to_timestamp($3), $4, $5)',
    [hashSessionToken(token), user.id, expires, userAgent?.slice(0, 300) ?? null, ip],
  );
  // Opportunistic cleanup of expired sessions.
  query('DELETE FROM sessions WHERE expires_at < now()').catch(() => {});
  return { cookie: encodeToken({ s: token, r: user.role, e: expires }), maxAge: SESSION_TTL_S };
}

/** Resolve a cookie to its user, checking the session still exists (not logged
 *  out, user not deleted) and taking the role from the database. */
export async function sessionUser(cookieValue: string | undefined | null): Promise<SessionUser | null> {
  const p = verifyToken(cookieValue);
  if (!p) return null;
  return queryOne<SessionUser>(
    `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [hashSessionToken(p.s)],
  );
}

export async function deleteSession(cookieValue: string | undefined | null): Promise<void> {
  const p = verifyToken(cookieValue);
  if (p) await query('DELETE FROM sessions WHERE id = $1', [hashSessionToken(p.s)]);
}

// ------------------------------------------------------- login throttling ----
// 5 failures per username+IP → locked for 60 s. In memory: one dashboard process.
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;

export function loginLockedFor(key: string): number {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) return 0;
  return Math.ceil((f.until - Date.now()) / 1000);
}

export function recordLoginFailure(key: string): void {
  const f = failures.get(key) ?? { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILURES) { f.until = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(key, f);
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}

// ---------------------------------------------------- request → user ----
/** Headers proxy.ts sets after verifying the session (client copies are stripped). */
export const USER_HEADERS = { id: 'x-edge-user-id', name: 'x-edge-user-name', role: 'x-edge-user-role' } as const;

export function requestUser(req: Request): SessionUser | null {
  const id = req.headers.get(USER_HEADERS.id);
  const role = req.headers.get(USER_HEADERS.role);
  if (!id || (role !== 'admin' && role !== 'user')) return null;
  return { id, username: req.headers.get(USER_HEADERS.name) ?? '', role };
}

export function isAdmin(req: Request): boolean {
  return requestUser(req)?.role === 'admin';
}
