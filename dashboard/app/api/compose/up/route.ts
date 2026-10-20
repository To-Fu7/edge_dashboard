import { NextResponse } from 'next/server';
import { listDevices, setDeviceEnabled } from '@/lib/devices';
import { startDevice } from '@/lib/device-runtime';
import { apiError } from '@/lib/device-api';

// "Start all": start every device's container and mark it enabled.
export async function POST() {
  try {
    const failed: { code: string; error: string }[] = [];
    for (const d of await listDevices()) {
      try {
        await startDevice(d);
        await setDeviceEnabled(d.id, true);
      } catch (e) {
        failed.push({ code: d.code, error: (e as Error).message });
      }
    }
    if (failed.length) return NextResponse.json({ error: failed.map(f => `${f.code}: ${f.error}`).join('; '), failed }, { status: 500 });
    return NextResponse.json({ success: true });
  } catch (e) {
    return apiError(e);
  }
}
