import { NextResponse } from 'next/server';
import { uninstallNode } from '@/lib/nodered';

type Ctx = { params: Promise<{ module: string }> };

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const { module } = await params;
    await uninstallNode(decodeURIComponent(module));
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
