import { NextResponse } from 'next/server';
import {
  authenticate, createSession, loginLockedFor, recordLoginFailure, clearLoginFailures,
} from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/auth-token';
import { describeDbError } from '@/lib/db';

export async function POST(request: Request) {
  let username = '', password = '';
  try {
    const body = await request.json();
    username = String(body?.username ?? '').trim();
    password = String(body?.password ?? '');
  } catch { /* fall through to validation */ }
  if (!username || !password) {
    return NextResponse.json({ error: 'Enter a username and password' }, { status: 400 });
  }

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || null;
  const key = `${username.toLowerCase()}|${ip ?? ''}`;
  const locked = loginLockedFor(key);
  if (locked) {
    return NextResponse.json({ error: `Too many failed attempts. Try again in ${locked} s.` }, { status: 429 });
  }

  try {
    const user = await authenticate(username, password);
    if (!user) {
      recordLoginFailure(key);
      return NextResponse.json({ error: 'Wrong username or password' }, { status: 401 });
    }
    clearLoginFailures(key);
    const { cookie, maxAge } = await createSession(user, request.headers.get('user-agent'), ip);
    const res = NextResponse.json({ user });
    res.cookies.set(SESSION_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', path: '/', maxAge });
    return res;
  } catch (e) {
    return NextResponse.json({ error: describeDbError(e) }, { status: 503 });
  }
}
