import { NextResponse } from 'next/server';
import { deployPortForwardConfig } from '@/lib/portforward';

// Regenerate nginx.conf from the forward list, validate with `nginx -t`, reload.
export async function POST() {
  const result = await deployPortForwardConfig();
  return NextResponse.json(result, { status: result.deployed || result.skipped ? 200 : 500 });
}
