'use client';

import { useEffect, useState } from 'react';

export interface NrDebugEntry {
  id: string;      // node id
  z: string;       // flow (tab) id
  name: string;    // node label
  topic: string;
  msg: unknown;
  level: number;   // NR levels: 10=fatal 20=error 30=warn 40=info 50=debug 60=trace
  format: string;
  _msgid: string;
  ts: number;      // client timestamp
}

// NR uses descending severity (lower number = more severe)
export function entryIsError(e: NrDebugEntry): boolean {
  if (e.level <= 20) return true;
  if (typeof e.msg === 'object' && e.msg !== null && 'error' in e.msg) return true;
  return false;
}

export function entryIsWarn(e: NrDebugEntry): boolean {
  return e.level > 20 && e.level <= 30;
}

const MAX_PER_FLOW = 100;

export function useNrDebug() {
  const [log, setLog] = useState<Record<string, NrDebugEntry[]>>({});
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/nodered/comms`);

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ subscribe: 'debug' }));
    };
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setConnected(false);

    ws.onmessage = (evt) => {
      try {
        const messages: Array<{ topic: string; data: Omit<NrDebugEntry, 'ts'> }> = JSON.parse(evt.data);
        setLog(prev => {
          const next = { ...prev };
          for (const { topic, data } of messages) {
            if (topic !== 'debug' || !data?.z) continue;
            const flowId = data.z;
            next[flowId] = [...(next[flowId] ?? []), { ...data, ts: Date.now() }].slice(-MAX_PER_FLOW);
          }
          return next;
        });
      } catch {}
    };

    return () => { ws.close(); };
  }, []);

  function clearFlow(flowId: string) {
    setLog(prev => ({ ...prev, [flowId]: [] }));
  }

  return { log, connected, clearFlow };
}
