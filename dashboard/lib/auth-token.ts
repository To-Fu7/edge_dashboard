// Signed session cookie — crypto only (no DB), so proxy.ts can verify it cheaply.
//
// Cookie value: base64url(JSON {s: session token, r: role, e: expiry epoch s}) + "." + HMAC-SHA256.
// The token itself is random; the database stores only its sha256 (lib/auth.ts).
// server.js re-implements verify() for the /nodered proxy — keep them in sync.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export const SESSION_COOKIE = 'edge_session';
export const SESSION_TTL_S = 7 * 24 * 3600;

export type Role = 'admin' | 'user';

export interface TokenPayload {
  s: string;   // session token (random)
  r: Role;
  e: number;   // expiry, epoch seconds
}

let cachedSecret: Buffer | null = null;

/** EDGE_AUTH_SECRET from the environment, or a random secret persisted next to
 *  the dashboard's data (so sessions survive restarts without configuration). */
export function authSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  if (process.env.EDGE_AUTH_SECRET) {
    cachedSecret = Buffer.from(process.env.EDGE_AUTH_SECRET, 'utf-8');
    return cachedSecret;
  }
  const dataDir = path.dirname(process.env.SETTINGS_FILE || path.join(process.cwd(), 'data', 'settings.json'));
  const file = path.join(dataDir, 'auth-secret');
  try {
    cachedSecret = Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'utf-8');
  } catch {
    fs.mkdirSync(dataDir, { recursive: true });
    const secret = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    cachedSecret = Buffer.from(secret, 'utf-8');
  }
  return cachedSecret;
}

function sign(data: string): string {
  return crypto.createHmac('sha256', authSecret()).update(data).digest('base64url');
}

export function encodeToken(p: TokenPayload): string {
  const data = Buffer.from(JSON.stringify(p), 'utf-8').toString('base64url');
  return `${data}.${sign(data)}`;
}

/** Returns the payload if the signature is valid and it hasn't expired. */
export function verifyToken(value: string | undefined | null): TokenPayload | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const data = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(sign(data));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8')) as TokenPayload;
    if (typeof p.s !== 'string' || (p.r !== 'admin' && p.r !== 'user') || typeof p.e !== 'number') return null;
    if (p.e < Date.now() / 1000) return null;
    return p;
  } catch {
    return null;
  }
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
