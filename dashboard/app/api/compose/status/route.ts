import { NextResponse } from 'next/server';
import { deviceImageExists, DEVICE_IMAGE } from '@/lib/device-runtime';

export async function GET() {
  return NextResponse.json({ imageReady: await deviceImageExists(), imageName: DEVICE_IMAGE });
}
