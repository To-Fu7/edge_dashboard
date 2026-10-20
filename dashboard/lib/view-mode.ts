'use client';

import { usePathname } from 'next/navigation';

/** The Settings page is shared by two areas: the main area (/settings: app,
 *  stream-gateway, port forward — works with no detection pipeline running)
 *  and the Detection area (/detection/settings: Triton, models, MQTT and the
 *  defaults every camera inherits). The page calls this to decide which
 *  sections to show. */
export function useDetectionView() {
  const isDetection = (usePathname() ?? '').startsWith('/detection');
  return { isDetection };
}
