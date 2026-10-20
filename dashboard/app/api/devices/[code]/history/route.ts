import { NextResponse } from 'next/server';
import { requireDevice, deviceHistory } from '@/lib/devices';
import { apiError } from '@/lib/device-api';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const device = await requireDevice((await params).code);
    return NextResponse.json({ currentVersion: device.config_version, history: await deviceHistory(device.id) });
  } catch (e) {
    return apiError(e);
  }
}
