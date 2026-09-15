'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, MonitorOff, Maximize2 } from 'lucide-react';

interface Props {
  deviceCode: string;
  password?: string;
}

type Status = 'connecting' | 'connected' | 'disconnected' | 'error';

export function VncViewer({ deviceCode, password }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('connecting');

  useEffect(() => {
    if (!containerRef.current) return;

    let rfb: InstanceType<typeof import('@novnc/novnc').default> | null = null;
    let cancelled = false;

    import('@novnc/novnc').then(({ default: RFB }) => {
      if (cancelled || !containerRef.current) return;

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl  = `${proto}://${window.location.host}/vnc/${deviceCode}`;

      rfb = new RFB(containerRef.current, wsUrl, {
        credentials: password ? { password } : undefined,
        wsProtocols: ['binary'],
      });
      rfb.scaleViewport = true;
      rfb.resizeSession  = false;

      rfb.addEventListener('connect',    () => { if (!cancelled) setStatus('connected');    });
      rfb.addEventListener('disconnect', () => { if (!cancelled) setStatus('disconnected'); });
      rfb.addEventListener('credentialsrequired', () => {
        const pass = prompt(`VNC password for ${deviceCode}:`);
        if (pass) rfb!.sendCredentials({ password: pass });
        else { rfb!.disconnect(); setStatus('disconnected'); }
      });
    }).catch(() => {
      if (!cancelled) setStatus('error');
    });

    return () => {
      cancelled = true;
      rfb?.disconnect();
    };
  }, [deviceCode, password]);

  return (
    <div className="relative w-full h-full bg-black group/vnc">
      <div ref={containerRef} className="w-full h-full" />

      {status === 'connecting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 gap-2 pointer-events-none">
          <Loader2 className="w-6 h-6 text-white/50 animate-spin" />
          <p className="text-xs text-white/40">Connecting to VNC…</p>
        </div>
      )}
      {(status === 'disconnected' || status === 'error') && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 gap-2 pointer-events-none">
          <MonitorOff className="w-8 h-8 text-gray-500" />
          <p className="text-xs text-gray-400">
            {status === 'error' ? 'Failed to connect' : 'Disconnected'}
          </p>
        </div>
      )}

      {status === 'connected' && (
        <button
          onClick={() => containerRef.current?.requestFullscreen?.()}
          title="Fullscreen"
          className="absolute top-2 right-2 p-1.5 rounded bg-black/50 text-white/60 hover:text-white hover:bg-black/80 opacity-0 group-hover/vnc:opacity-100 transition-opacity"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
