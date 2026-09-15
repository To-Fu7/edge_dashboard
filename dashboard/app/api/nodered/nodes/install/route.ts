import { NextResponse } from 'next/server';
import { installNode } from '@/lib/nodered';

export async function POST(req: Request) {
  try {
    const { module } = await req.json();
    if (!module) return NextResponse.json({ error: 'module required' }, { status: 400 });
    const result = await installNode(module);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
