import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const USERS_FILE = process.env.USERS_FILE || path.join(process.cwd(), 'data', 'users.json');

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
}

function ensureDataDir() {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function readUsers(): User[] {
  ensureDataDir();
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')); }
  catch { return []; }
}

export function writeUsers(users: User[]) {
  ensureDataDir();
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

export function findUserById(id: string): User | undefined {
  return readUsers().find(u => u.id === id);
}

export function findUserByUsername(username: string): User | undefined {
  return readUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
}

// PBKDF2 — no external dep, works in both Node and Edge (via crypto module)
export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.pbkdf2(password, salt, 310_000, 32, 'sha256', (err, key) => {
      if (err) return reject(err);
      resolve(`${salt.toString('hex')}:${key.toString('hex')}`);
    });
  });
}

export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [saltHex, keyHex] = stored.split(':');
    const salt = Buffer.from(saltHex, 'hex');
    crypto.pbkdf2(password, salt, 310_000, 32, 'sha256', (err, key) => {
      if (err) return reject(err);
      resolve(key.toString('hex') === keyHex);
    });
  });
}

export async function bootstrapAdminIfEmpty() {
  const users = readUsers();
  if (users.length > 0) return;
  const password = process.env.DEFAULT_ADMIN_PASSWORD || 'admin';
  const passwordHash = await hashPassword(password);
  writeUsers([{
    id: crypto.randomUUID(),
    username: 'admin',
    passwordHash,
    createdAt: new Date().toISOString(),
  }]);
}
