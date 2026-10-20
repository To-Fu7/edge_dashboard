import { NextResponse } from 'next/server';
import { readSettings, updateSettings, settingsHistory } from '@/lib/settings';
import { applySettingsToDevices } from '@/lib/devices';
import { writeTritonEnv } from '@/lib/compose';
import { apiError } from '@/lib/device-api';
import { isAdmin, requestUser } from '@/lib/auth';
import type { GlobalSettings } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const settings = await readSettings();
    if (!isAdmin(request)) {
      // `user` only needs the dashboard name and the stream host override.
      return NextResponse.json({ settings: { appName: settings.appName, streamGateway: settings.streamGateway } });
    }
    const url = new URL(request.url);
    if (url.searchParams.get('history') === '1') {
      return NextResponse.json({ settings, history: await settingsHistory() });
    }
    return NextResponse.json({ settings });
  } catch (e) {
    return apiError(e);
  }
}

// Saves global settings and applies them to every device right away: devices
// whose effective env changes get a new config version and a NOTIFY, and their
// containers pick it up without anyone pressing Restart.
export async function PUT(request: Request) {
  try {
    // applyHardwareMode: rewrite python-counting/.env even if mode/tag didn't
    // change (setup/install.sh uses it on a fresh checkout).
    const { applyHardwareMode, ...patch } = await request.json() as Partial<GlobalSettings> & { applyHardwareMode?: boolean };
    const { previous, next } = await updateSettings(patch, requestUser(request)?.id ?? null);

    const modeChanged = next.hardwareMode !== previous.hardwareMode;
    const tagChanged = next.triton.imageTag !== previous.triton.imageTag;
    if (modeChanged || tagChanged || applyHardwareMode) writeTritonEnv(next);

    const { updated } = await applySettingsToDevices(next);
    return NextResponse.json({
      success: true,
      devicesUpdated: updated,
      // jetson/server engines are TRT-version-specific — the UI prompts a rebuild
      engineRebuildRecommended: Boolean(modeChanged || tagChanged || applyHardwareMode),
    });
  } catch (e) {
    return apiError(e);
  }
}
