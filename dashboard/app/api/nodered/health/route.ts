import { NextResponse } from 'next/server';

const NR_BASE = process.env.NODERED_URL ?? 'http://edge-nodered:1880';

export async function GET() {
  try {
    const res = await fetch(`${NR_BASE}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
    });
    // NR returns 200 (editor HTML) when healthy, even before auth
    if (res.ok) return NextResponse.json({ status: 'ok' });
    return NextResponse.json({ status: 'error', code: res.status }, { status: 502 });
  } catch (e) {
    return NextResponse.json({ status: 'unreachable', error: String(e) }, { status: 503 });
  }
}
