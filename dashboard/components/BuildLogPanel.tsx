'use client';

import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { HammerIcon, CheckCircle2, XCircle } from 'lucide-react';

type Outcome = 'idle' | 'success' | 'failed';

interface Props {
  title: string;
  description: string;
  endpoint: string;
  getBody?: () => Record<string, unknown>;
  runLabel?: string;
  disabled?: boolean;
  disabledReason?: string;
  children?: React.ReactNode;
}

export function BuildLogPanel({ title, description, endpoint, getBody, runLabel = 'Run', disabled, disabledReason, children }: Props) {
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('idle');
  const logRef = useRef<HTMLPreElement>(null);

  function append(chunk: string) {
    setLog(prev => prev + chunk);
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }

  async function run() {
    setRunning(true);
    setOutcome('idle');
    setLog('');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(getBody?.() ?? {}),
      });

      if (!res.body) {
        append(await res.text());
        setOutcome(res.ok ? 'success' : 'failed');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        full += chunk;
        append(chunk);
      }
      setOutcome(!res.ok || /\n✗ /.test(full) ? 'failed' : 'success');
    } catch (e) {
      append(`\n[error] ${e}\n`);
      setOutcome('failed');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">{title}</p>
            {outcome === 'success' && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
            {outcome === 'failed' && <XCircle className="w-4 h-4 text-destructive shrink-0" />}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        </div>
        <Button size="sm" onClick={run} disabled={running || disabled} className="shrink-0" title={disabled ? disabledReason : undefined}>
          <HammerIcon className={`w-4 h-4 mr-2 ${running ? 'animate-pulse' : ''}`} />
          {running ? 'Running…' : runLabel}
        </Button>
      </div>

      {children}

      {log && (
        <pre
          ref={logRef}
          className="text-xs font-mono bg-black/90 text-gray-300 rounded p-3 max-h-72 overflow-auto whitespace-pre-wrap"
        >
          {log}
        </pre>
      )}
    </div>
  );
}
