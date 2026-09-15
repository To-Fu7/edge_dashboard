import { NextResponse } from 'next/server';
import { injectNode } from '@/lib/nodered';

type Ctx = { params: Promise<{ nodeId: string }> };

export async function POST(_req: Request, { params }: Ctx) {
  try {
    const { nodeId } = await params;
    await injectNode(nodeId);
    return new NextResponse(null, { status: 204 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
