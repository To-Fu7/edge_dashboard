import { NextRequest, NextResponse } from 'next/server';
import { readUsers, writeUsers, findUserByUsername, hashPassword } from '@/lib/users';
import { getSession } from '@/lib/auth';
import { randomUUID } from 'crypto';

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const users = readUsers().map(({ id, username, createdAt }) => ({ id, username, createdAt }));
  return NextResponse.json(users);
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { username, password } = await req.json();
  if (!username?.trim() || !password) {
    return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
  }
  if (findUserByUsername(username)) {
    return NextResponse.json({ error: 'Username already exists' }, { status: 409 });
  }

  const users = readUsers();
  users.push({
    id: randomUUID(),
    username: username.trim(),
    passwordHash: await hashPassword(password),
    createdAt: new Date().toISOString(),
  });
  writeUsers(users);
  return NextResponse.json({ ok: true });
}
