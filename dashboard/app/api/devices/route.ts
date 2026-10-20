import { NextResponse } from 'next/server';
import { listDevices, createDevice } from '@/lib/devices';
import { deviceContainerStatuses, ensureContainer } from '@/lib/device-runtime';
import { apiError, deviceSummary, syncStreamRegistration } from '@/lib/device-api';
import { isAdmin, requestUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const admin = isAdmin(request);
    const [devices, containers] = await Promise.all([
      listDevices(),
      deviceContainerStatuses().catch(() => new Map()),
    ]);
    return NextResponse.json({ devices: devices.map(d => deviceSummary(d, containers.get(d.id), admin)) });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const device = await createDevice({
      code: String(body.deviceCode ?? ''),
      name: String(body.deviceName ?? ''),
      id: body.deviceId ? String(body.deviceId) : undefined,
      env: body.rtspUrl ? { RTSP_URL: String(body.rtspUrl) } : {},
    }, requestUser(request)?.id ?? null);

    syncStreamRegistration(device);
    // Create (not start) the container now so problems like a missing image
    // show up immediately; the device is saved either way.
    let containerWarning: string | undefined;
    try {
      await ensureContainer(device);
    } catch (e) {
      containerWarning = (e as Error).message;
    }
    return NextResponse.json({ success: true, deviceCode: device.code, deviceId: device.id, containerWarning }, { status: 201 });
  } catch (e) {
    return apiError(e);
  }
}
