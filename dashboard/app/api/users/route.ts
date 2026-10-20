import { NextResponse } from 'next/server';
import { listUsers, createUser } from '@/lib/users';
import { apiError } from '@/lib/device-api';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json({ users: await listUsers() });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(request: Request) {
  try {
    const { username, password, role } = await request.json();
    return NextResponse.json({ user: await createUser(String(username ?? '').trim(), String(password ?? ''), role) }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
