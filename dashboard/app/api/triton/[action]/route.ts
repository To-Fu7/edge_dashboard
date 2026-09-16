import { NextResponse } from 'next/server';
import {
  composeUpTriton,
  composeStopTriton,
  composeRestartTriton,
} from '@/lib/compose';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> }
) {
  const { action } = await params;
  try {
    switch (action) {
      case 'start':
        await composeUpTriton();
        return NextResponse.json({ success: true });
      case 'stop':
        await composeStopTriton();
        return NextResponse.json({ success: true });
      case 'restart':
        await composeRestartTriton();
        return NextResponse.json({ success: true });
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
