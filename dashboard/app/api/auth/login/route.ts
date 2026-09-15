import { NextRequest, NextResponse } from 'next/server';
import { findUserByUsername, verifyPassword, bootstrapAdminIfEmpty } from '@/lib/users';
import { createSession } from '@/lib/auth';

export async function POST(req: NextRequest) {
  const { username, password } = await req.json();
  if (!username || !password) {
    return NextResponse.json({ error: 'Username and password required' }, { status: 400 });
  }

  await bootstrapAdminIfEmpty();

  const user = findUserByUsername(username);
  if (!user) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  await createSession(user.id, user.username);
  return NextResponse.json({ ok: true, username: user.username });
}
