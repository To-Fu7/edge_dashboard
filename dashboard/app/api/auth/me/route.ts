import { NextResponse } from 'next/server';
import { requestUser } from '@/lib/auth';

export async function GET(request: Request) {
  const user = requestUser(request);
  if (!user) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
  return NextResponse.json({ user });
}
