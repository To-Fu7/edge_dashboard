import { NextResponse } from 'next/server';
import { requireDevice, updateDevice, deleteDevice } from '@/lib/devices';
import { deviceContainerStatuses, ensureContainer, removeDeviceContainer, startDevice } from '@/lib/device-runtime';
import { apiError, inheritanceInfo, publicEnv, syncStreamRegistration } from '@/lib/device-api';
import { containerNameFor } from '@/lib/device-config';
import { removeCameraStream } from '@/lib/stream-gateway';
import { deployPortForwardConfig } from '@/lib/portforward';
import { isAdmin, requestUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ code: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    const device = await requireDevice((await params).code);
    const container = (await deviceContainerStatuses().catch(() => new Map())).get(device.id);
    const base = {
      id: device.id,
      status: container?.status ?? 'not_found',
      containerName: container?.name ?? containerNameFor(device.code),
      configVersion: device.config_version,
      enabled: device.enabled,
    };
    if (!isAdmin(request)) return NextResponse.json({ ...base, env: publicEnv(device.effective_env) });
    return NextResponse.json({ ...base, env: device.effective_env, ...inheritanceInfo(device) });
  } catch (e) {
    return apiError(e);
  }
}

// Saves the device form. The config change reaches the running container by
// itself (NOTIFY → config_watch); only a code change needs the container
// recreated, since its name is derived from the code.
export async function PUT(request: Request, { params }: Ctx) {
  try {
    const env = await request.json();
    const { device, previous, codeChanged } = await updateDevice((await params).code, env, requestUser(request)?.id ?? null);
    syncStreamRegistration(device, previous.code);
    if (codeChanged) {
      if (device.enabled) await startDevice(device);
      else await ensureContainer(device);
    }
    return NextResponse.json({
      success: true,
      deviceCode: device.code,
      codeChanged,
      configVersion: device.config_version,
      applied: device.config_version !== previous.config_version,
    });
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  try {
    const device = await requireDevice((await params).code);
    await removeDeviceContainer(device.id);
    await deleteDevice(device.id);           // port forwards and history go with it (ON DELETE CASCADE)
    removeCameraStream(device.code).catch(() => {});
    removeCameraStream(`${device.code}_sub`).catch(() => {});
    deployPortForwardConfig().catch(() => {});
    return NextResponse.json({ success: true });
  } catch (e) {
    return apiError(e);
  }
}
