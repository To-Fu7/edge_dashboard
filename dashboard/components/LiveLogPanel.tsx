'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Play, Square, Trash2 } from 'lucide-react';

interface Props {
  title: string;
  description: string;
  endpoint: string;
}

/** Live-tails a server-sent text stream (e.g. `docker logs -f`) with an
 *  explicit Start/Stop toggle — unlike BuildLogPanel's one-shot "Run", this
 *  stream never ends on its own, so the panel must be able to close it
 *  itself (Stop button, or unmounting) rather than just waiting for it to
 *  finish. Stopping aborts the underlying fetch, which the server observes
 *  via request.signal to actually kill the docker log stream. */
export function LiveLogPanel({ title, description, endpoint }: Props) {
  const [active, setActive] = useState(false);
  const [log, setLog] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  function append(chunk: string) {
    setLog(prev => (prev + chunk).slice(-100_000)); // cap to avoid unbounded memory on a long-running tail
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }

  async function start() {
    if (active) return;
    setActive(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(endpoint, { signal: controller.signal });
      if (!res.body) {
        append(await res.text());
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        append(decoder.decode(value, { stream: true }));
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') append(`\n[error] ${e}\n`);
    } finally {
      setActive(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  useEffect(() => () => abortRef.current?.abort(), []);

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{title}</p>
            {active && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button size="sm" variant="outline" onClick={() => setLog('')} title="Clear">
            <Trash2 className="w-4 h-4" />
          </Button>
          {active ? (
            <Button size="sm" variant="outline" onClick={stop}>
              <Square className="w-4 h-4 mr-2" /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={start}>
              <Play className="w-4 h-4 mr-2" /> Follow
            </Button>
          )}
        </div>
      </div>

      <pre
        ref={logRef}
        className="text-xs font-mono bg-black/90 text-gray-300 rounded p-3 h-64 overflow-auto whitespace-pre-wrap"
      >
        {log || (active ? 'waiting for log output…' : 'not following — click Follow to tail live logs')}
      </pre>
    </div>
  );
}
