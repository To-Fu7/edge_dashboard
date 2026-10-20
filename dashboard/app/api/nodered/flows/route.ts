import { NextResponse } from 'next/server';
import { getFlows, createFlow, parseNrFlowArray } from '@/lib/nodered';

export async function GET() {
  try {
    const raw = await getFlows();
    const flows = parseNrFlowArray(raw);
    return NextResponse.json(flows);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = await createFlow(body);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
