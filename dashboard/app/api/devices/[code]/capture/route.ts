import { NextResponse } from 'next/server';
import { requireDevice } from '@/lib/devices';
import { apiError } from '@/lib/device-api';
import { captureFrame } from '@/lib/capture';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  const { code } = await params;

  let env: Record<string, string>;
  try {
    env = (await requireDevice(code)).effective_env;
  } catch (e) {
    return apiError(e);
  }
  if (!env.RTSP_URL) {
    return NextResponse.json({ error: 'RTSP_URL not configured for this device' }, { status: 400 });
  }

  try {
    const frameBuffer = await captureFrame(env.RTSP_URL);
    const base64 = frameBuffer.toString('base64');
    return NextResponse.json({ image: `data:image/jpeg;base64,${base64}` });
  } catch (e) {
    return NextResponse.json({ error: `Frame capture failed: ${String(e)}` }, { status: 500 });
  }
}
