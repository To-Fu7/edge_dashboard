import { NextResponse } from 'next/server';
import {
  deleteForward, deployPortForwardConfig, updateForward, validateForward, type PortForwardInput,
} from '@/lib/portforward';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const input = (await request.json()) as PortForwardInput;
    const problem = validateForward(input, id);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    const forward = updateForward(id, input);
    if (!forward) return NextResponse.json({ error: 'Forward not found' }, { status: 404 });
    const deploy = await deployPortForwardConfig();
    return NextResponse.json({ forward, deploy });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    if (!deleteForward(id)) return NextResponse.json({ error: 'Forward not found' }, { status: 404 });
    const deploy = await deployPortForwardConfig();
    return NextResponse.json({ success: true, deploy });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
