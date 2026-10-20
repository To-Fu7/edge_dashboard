import { NextResponse } from 'next/server';
import { requireDevice, rollbackDevice } from '@/lib/devices';
import { ensureContainer, startDevice } from '@/lib/device-runtime';
import { apiError, syncStreamRegistration } from '@/lib/device-api';
import { requestUser } from '@/lib/auth';

// Restore the code, name and overrides from a history entry (body: { historyId }).
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const current = await requireDevice((await params).code);
    const { historyId } = await request.json();
    const { device, previous, codeChanged } = await rollbackDevice(current.id, Number(historyId), requestUser(request)?.id ?? null);
    syncStreamRegistration(device, previous.code);
    if (codeChanged) {
      if (device.enabled) await startDevice(device);
      else await ensureContainer(device);
    }
    return NextResponse.json({ success: true, deviceCode: device.code, configVersion: device.config_version });
  } catch (e) {
    return apiError(e);
  }
}
