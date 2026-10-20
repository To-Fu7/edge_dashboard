import { NextResponse } from 'next/server';
import { exportDevices } from '@/lib/devices';
import { apiError } from '@/lib/device-api';

export const dynamic = 'force-dynamic';

// GET /api/devices/export[?ids=uuid,uuid] → JSON file with code, name and overrides per device.
export async function GET(request: Request) {
  try {
    const ids = new URL(request.url).searchParams.get('ids')?.split(',').filter(Boolean);
    const data = await exportDevices(ids);
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(JSON.stringify(data, null, 2), {
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="edge-devices-${stamp}.json"`,
      },
    });
  } catch (e) {
    return apiError(e);
  }
}
