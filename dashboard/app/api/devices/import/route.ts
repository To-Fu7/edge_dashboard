import { NextResponse } from 'next/server';
import { importDevices, getDevice, type DeviceExport } from '@/lib/devices';
import { ensureContainer } from '@/lib/device-runtime';
import { apiError, syncStreamRegistration } from '@/lib/device-api';
import { requestUser } from '@/lib/auth';

// POST { data: <export file>, keepIds?: boolean } — existing codes are skipped, never overwritten.
export async function POST(request: Request) {
  try {
    const { data, keepIds } = await request.json() as { data: DeviceExport; keepIds?: boolean };
    const result = await importDevices(data, keepIds !== false, requestUser(request)?.id ?? null);
    for (const code of result.created) {
      const d = await getDevice(code);
      if (!d) continue;
      syncStreamRegistration(d);
      await ensureContainer(d).catch(() => {});   // image may not be built yet; reconcile retries later
    }
    return NextResponse.json(result);
  } catch (e) {
    return apiError(e);
  }
}
