import { NextResponse } from 'next/server';
import { getContainerLogs, getContainerStatus } from '@/lib/docker';
import {
  buildNginxConf, collectPortForwards, deployPortForwardConfig, getForwarderTarget,
  readLiveNginxConf, LISTEN_PORT_MIN, LISTEN_PORT_MAX,
} from '@/lib/portforward';

export const dynamic = 'force-dynamic';

// Overview of the dashboard-owned port-forward nginx for Settings → Nginx.
export async function GET() {
  try {
    const { containerName, configPath } = getForwarderTarget();
    const forwards = collectPortForwards();
    const expectedConf = buildNginxConf(forwards);
    const [status, liveConf, logs] = await Promise.all([
      getContainerStatus(containerName),
      readLiveNginxConf(),
      getContainerLogs(containerName, 200),
    ]);
    return NextResponse.json({
      containerName,
      configPath,
      status,
      portRange: [LISTEN_PORT_MIN, LISTEN_PORT_MAX],
      forwards,
      liveConf,
      expectedConf,
      inSync: liveConf !== null && liveConf.trim() === expectedConf.trim(),
      logs,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// Regenerate nginx.conf from every device's PORTFWD_* vars, validate, reload.
export async function POST() {
  const result = await deployPortForwardConfig();
  return NextResponse.json(result, { status: result.deployed || result.skipped ? 200 : 500 });
}
