import { NextResponse } from 'next/server';
import { getContainerLogs, getContainerStatus } from '@/lib/docker';
import { listEnvFiles, readDeviceEnv } from '@/lib/env-parser';
import {
  buildNginxConf, collectPortForwards, createForward, deployPortForwardConfig, getForwarderTarget,
  readForwards, readLiveNginxConf, suggestListenPort, targetFromRtsp, validateForward,
  LISTEN_PORT_MIN, LISTEN_PORT_MAX, type PortForwardInput,
} from '@/lib/portforward';

export const dynamic = 'force-dynamic';

// Everything Settings → Nginx needs: forwarder status, the forward list, the
// cameras a forward can be created for (with their RTSP target pre-resolved),
// and live vs generated config.
export async function GET(request: Request) {
  try {
    // Device page: just that camera's forwards, no docker round-trips.
    const device = new URL(request.url).searchParams.get('device');
    if (device) {
      return NextResponse.json({ forwards: readForwards().filter(f => f.deviceCode === device) });
    }

    const { containerName, configPath } = getForwarderTarget();
    const forwards = readForwards();
    const expectedConf = buildNginxConf(collectPortForwards());
    const cameras = listEnvFiles().map(code => {
      const env = readDeviceEnv(code);
      return { code, name: env?.DEVICE_NAME || code, target: targetFromRtsp(env?.RTSP_URL) };
    });
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
      suggestedPort: suggestListenPort(),
      forwards,
      cameras,
      liveConf,
      expectedConf,
      inSync: liveConf !== null && liveConf.trim() === expectedConf.trim(),
      logs,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// Create a forward, then regenerate + reload nginx.
export async function POST(request: Request) {
  try {
    const input = (await request.json()) as PortForwardInput;
    const problem = validateForward(input);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    const forward = createForward(input);
    const deploy = await deployPortForwardConfig();
    return NextResponse.json({ forward, deploy }, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
