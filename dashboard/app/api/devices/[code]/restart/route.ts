import { NextResponse } from 'next/server';
import { requireDevice, setDeviceEnabled } from '@/lib/devices';
import { restartDevice } from '@/lib/device-runtime';
import { apiError } from '@/lib/device-api';

export async function POST(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const device = await requireDevice((await params).code);
    await restartDevice(device);
    await setDeviceEnabled(device.id, true);    // reconcile keeps it running
    return NextResponse.json({ success: true });
  } catch (e) {
    return apiError(e);
  }
}
