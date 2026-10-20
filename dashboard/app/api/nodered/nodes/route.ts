import { NextResponse } from 'next/server';
import { getNodes } from '@/lib/nodered';

export async function GET() {
  try {
    const nodes = await getNodes();
    return NextResponse.json(nodes);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
