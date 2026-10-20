import { NextResponse } from 'next/server';
import { deleteSession } from '@/lib/auth';
import { SESSION_COOKIE } from '@/lib/auth-token';

export async function POST(request: Request) {
  const cookie = request.headers.get('cookie')?.split(/;\s*/).find(c => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  await deleteSession(cookie).catch(() => {});
  const res = NextResponse.json({ success: true });
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
