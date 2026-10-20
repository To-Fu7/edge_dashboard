// Dashboard accounts (Settings → Users). Admin-only, enforced by proxy.ts.
import { query, queryOne } from './db';
import { hashPassword, forgetAllSessions } from './auth';
import { DeviceError } from './devices';

export interface UserRow {
  id: string;
  username: string;
  role: 'admin' | 'user';
  created_at: string;
  last_login_at: string | null;
}

const USERNAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validate(username: string | undefined, role: string | undefined, password: string | undefined, creating: boolean) {
  if (creating || username !== undefined) {
    if (!username || !USERNAME_RE.test(username)) throw new DeviceError('Username: 1–64 letters, digits, ".", "_" or "-"');
  }
  if (role !== undefined && role !== 'admin' && role !== 'user') throw new DeviceError('Role must be admin or user');
  if (creating || password !== undefined) {
    if (!password || password.length < 4) throw new DeviceError('Password must be at least 4 characters');
  }
}

export async function listUsers(): Promise<UserRow[]> {
  return query<UserRow>('SELECT id, username, role, created_at, last_login_at FROM users ORDER BY username');
}

export async function createUser(username: string, password: string, role: 'admin' | 'user'): Promise<UserRow> {
  validate(username, role, password, true);
  try {
    return (await queryOne<UserRow>(
      'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at, last_login_at',
      [username, await hashPassword(password), role]))!;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new DeviceError('That username already exists', 409);
    throw e;
  }
}

async function adminCount(): Promise<number> {
  return Number((await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM users WHERE role = 'admin'"))?.n ?? 0);
}

export async function updateUser(id: string, patch: { username?: string; password?: string; role?: 'admin' | 'user' }): Promise<UserRow> {
  validate(patch.username, patch.role, patch.password, false);
  const cur = await queryOne<UserRow>('SELECT id, username, role, created_at, last_login_at FROM users WHERE id = $1', [id]);
  if (!cur) throw new DeviceError('User not found', 404);
  if (cur.role === 'admin' && patch.role === 'user' && (await adminCount()) <= 1) {
    throw new DeviceError('At least one admin must remain');
  }
  try {
    const row = await queryOne<UserRow>(
      `UPDATE users SET username = COALESCE($2, username), role = COALESCE($3, role),
              password_hash = COALESCE($4, password_hash), updated_at = now()
        WHERE id = $1 RETURNING id, username, role, created_at, last_login_at`,
      [id, patch.username ?? null, patch.role ?? null, patch.password ? await hashPassword(patch.password) : null]);
    // A new password or role logs the user out everywhere.
    if (patch.password || (patch.role && patch.role !== cur.role)) {
      await query('DELETE FROM sessions WHERE user_id = $1', [id]);
      forgetAllSessions();
    }
    return row!;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new DeviceError('That username already exists', 409);
    throw e;
  }
}

export async function deleteUser(id: string, currentUserId: string | undefined): Promise<void> {
  if (id === currentUserId) throw new DeviceError("You can't delete your own account");
  const cur = await queryOne<UserRow>('SELECT id, username, role, created_at, last_login_at FROM users WHERE id = $1', [id]);
  if (!cur) throw new DeviceError('User not found', 404);
  if (cur.role === 'admin' && (await adminCount()) <= 1) throw new DeviceError('At least one admin must remain');
  await query('DELETE FROM users WHERE id = $1', [id]);   // sessions cascade
  forgetAllSessions();
}
