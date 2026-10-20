import { NextResponse } from 'next/server';
import { requireDevice, setDeviceEnabled } from '@/lib/devices';
import { stopDevice } from '@/lib/device-runtime';
import { apiError } from '@/lib/device-api';

export async function POST(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const device = await requireDevice((await params).code);
    await stopDevice(device);
    await setDeviceEnabled(device.id, false);   // stays stopped across dashboard restarts
    return NextResponse.json({ success: true });
  } catch (e) {
    return apiError(e);
  }
}
