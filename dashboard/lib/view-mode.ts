'use client';

import { usePathname } from 'next/navigation';

/** The dashboard has two areas sharing the same pages: the main area (camera
 *  source, live stream via stream-gateway, port forward — works with no
 *  detection pipeline running) and the Detection area under /detection
 *  (counting/APD/face config, line drawing, logs, container controls,
 *  Triton/DB/MQTT settings). Pages call this to decide which sections to show
 *  and where device links should point. */
export function useDetectionView() {
  const isDetection = (usePathname() ?? '').startsWith('/detection');
  return {
    isDetection,
    devicesBase: isDetection ? '/detection/devices' : '/devices',
  };
}
