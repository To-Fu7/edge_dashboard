import { NextResponse } from 'next/server';
import fs from 'fs';
import { PYTHON_COUNTING_DIR } from '@/lib/compose';

export const dynamic = 'force-dynamic';

// Lists .pt weight files sitting at the root of python-counting/ so the
// export-ONNX step can offer a dropdown instead of a free-text path.
export async function GET() {
  try {
    const files = fs.readdirSync(PYTHON_COUNTING_DIR)
      .filter(f => f.endsWith('.pt'));
    return NextResponse.json({ weights: files });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
