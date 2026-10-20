import { NextResponse } from 'next/server';
import { updateUser, deleteUser } from '@/lib/users';
import { apiError } from '@/lib/device-api';
import { requestUser } from '@/lib/auth';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Ctx) {
  try {
    const body = await request.json();
    const patch = {
      username: body.username !== undefined ? String(body.username).trim() : undefined,
      password: body.password ? String(body.password) : undefined,
      role: body.role,
    };
    return NextResponse.json({ user: await updateUser((await params).id, patch) });
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    await deleteUser((await params).id, requestUser(request)?.id);
    return NextResponse.json({ success: true });
  } catch (e) {
    return apiError(e);
  }
}
