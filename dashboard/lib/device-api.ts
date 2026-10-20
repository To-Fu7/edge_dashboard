// Shared bits for the device API routes.
import { NextResponse } from 'next/server';
import { DeviceError, type DeviceRow, type DeviceStatusRow } from './devices';
import { describeDbError } from './db';
import { upsertCameraStream, removeCameraStream } from './stream-gateway';
import { containerNameFor, GLOBAL_KEYS, type Env } from './device-config';
import type { ContainerStatus } from './types';

/** Map thrown errors to a JSON response with a sensible status. */
export function apiError(e: unknown): NextResponse {
  if (e instanceof DeviceError) return NextResponse.json({ error: e.message }, { status: e.status });
  const code = (e as { code?: string }).code;
  if (code && /^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|28P01|3D000)/.test(code)) {
    return NextResponse.json({ error: describeDbError(e) }, { status: 503 });
  }
  return NextResponse.json({ error: (e as Error).message || String(e) }, { status: 500 });
}

// What the `user` role may see of a device env: enough to draw lines/zones on
// the live view, nothing that carries credentials or addresses.
const PUBLIC_KEY = /^(DEVICE_(ID|CODE|NAME)|DETECTION_MODE|DETECTION_STYLE|POINT_AXIS|LINE_OFFSET(_AMOUNT)?|DOT_OFFSET(_AMOUNT)?|SCREEN_RESOLUTION|CROP_AREA|SWAP_IN_OUT|MERGE_GATES|line[A-Z]|zone[A-Z]|STREAM_GATEWAY_(ALWAYS_ON|AUDIO))$/;

export function publicEnv(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([k]) => PUBLIC_KEY.test(k)));
}

/** Register (or re-register after a rename) the camera with stream-gateway. Best-effort. */
export function syncStreamRegistration(device: DeviceRow, previousCode?: string): void {
  const env = device.effective_env;
  const onDemand = env.STREAM_GATEWAY_ALWAYS_ON !== 'true';
  const includeAudio = env.STREAM_GATEWAY_AUDIO === 'true';
  const warn = (what: string) => (err: Error) => console.warn(`stream-gateway ${what} failed for ${device.code}:`, err.message);
  if (previousCode && previousCode !== device.code) {
    removeCameraStream(previousCode).catch(() => {});
    removeCameraStream(`${previousCode}_sub`).catch(() => {});
  }
  if (env.RTSP_URL) upsertCameraStream(device.code, { rtspUrl: env.RTSP_URL, onDemand, includeAudio }).catch(warn('upsert'));
  if (env.SUBSTREAM_URL) {
    upsertCameraStream(`${device.code}_sub`, { rtspUrl: env.SUBSTREAM_URL, onDemand, includeAudio }).catch(warn('upsert sub'));
  } else {
    removeCameraStream(`${device.code}_sub`).catch(() => {});
  }
}

export interface DeviceSummary {
  deviceId: string;
  deviceCode: string;
  deviceName: string;
  containerName: string;
  status: ContainerStatus;
  enabled: boolean;
  configVersion: number;
  rtspUrl?: string;
  heartbeat: (DeviceStatusRow & { stale: boolean }) | null;
}

/** A heartbeat older than this means the container stopped reporting. */
const HEARTBEAT_STALE_MS = 45_000;

export function deviceSummary(
  d: DeviceRow & { status?: DeviceStatusRow | null },
  container: { name: string; status: ContainerStatus } | undefined,
  admin: boolean,
): DeviceSummary {
  const hb = d.status ?? null;
  return {
    deviceId: d.id,
    deviceCode: d.code,
    deviceName: d.name,
    containerName: container?.name ?? containerNameFor(d.code),
    status: container?.status ?? 'not_found',
    enabled: d.enabled,
    configVersion: d.config_version,
    ...(admin ? { rtspUrl: d.effective_env.RTSP_URL ?? '' } : {}),
    heartbeat: hb ? { ...hb, stale: Date.now() - new Date(hb.updated_at).getTime() > HEARTBEAT_STALE_MS } : null,
  };
}

/** Which keys of this device come from Settings and which it overrides — for
 *  the device page's "global / override" hints. */
export function inheritanceInfo(d: DeviceRow): { globalKeys: string[]; overriddenKeys: string[] } {
  return { globalKeys: [...GLOBAL_KEYS], overriddenKeys: Object.keys(d.overrides) };
}
