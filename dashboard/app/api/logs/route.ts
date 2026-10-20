import { NextResponse } from 'next/server';
import { getContainerLogs } from '@/lib/docker';
import { listDevices } from '@/lib/devices';
import { containerNameFor } from '@/lib/device-config';
import { apiError } from '@/lib/device-api';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const containerCode = url.searchParams.get('container');
  const tail = parseInt(url.searchParams.get('tail') || '200', 10);
  const since = url.searchParams.get('since');

  try {
    const devices = await listDevices();
    const targets = containerCode ? devices.filter(d => d.code === containerCode) : devices;

    const allLogs: { containerCode: string; containerName: string; line: string }[] = [];

    await Promise.all(
      targets.map(async d => {
        const containerName = containerNameFor(d.code);
        const logs = await getContainerLogs(
          containerName,
          tail,
          since ? parseInt(since, 10) : undefined
        );
        for (const line of logs) {
          allLogs.push({ containerCode: d.code, containerName, line });
        }
      })
    );

    return NextResponse.json({ logs: allLogs });
  } catch (e) {
    return apiError(e);
  }
}
