'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { Plus, Loader2, Package, Power, PowerOff, ChevronRight, Workflow, Bug, Info } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { NrFlow } from '@/lib/nodered';
import { useNrDebug, entryIsError, entryIsWarn } from '@/hooks/useNrDebug';
import { DebugSheet } from '@/components/nodered/DebugSheet';

type NrHealth = 'checking' | 'ok' | 'error' | 'unreachable';

const HEALTH_LABEL: Record<NrHealth, string> = {
  checking:    'Checking…',
  ok:          'Node-RED connected',
  error:       'Node-RED error',
  unreachable: 'Node-RED unreachable',
};

const HEALTH_DOT: Record<NrHealth, string> = {
  checking:    'bg-muted-foreground animate-pulse',
  ok:          'bg-emerald-500',
  error:       'bg-yellow-500',
  unreachable: 'bg-destructive',
};

export default function AutomationPage() {
  const [flows, setFlows] = useState<NrFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [health, setHealth] = useState<NrHealth>('checking');
  const [debugFlow, setDebugFlow] = useState<NrFlow | null>(null);
  const [nodeFilters, setNodeFilters] = useState<Record<string, Set<string>>>({});

  const { log: debugLog, clearFlow } = useNrDebug();

  // Poll NR health every 30 s
  const checkHealth = useCallback(() => {
    fetch('/api/nodered/health')
      .then(r => r.json())
      .then(d => setHealth(d.status === 'ok' ? 'ok' : 'error'))
      .catch(() => setHealth('unreachable'));
  }, []);

  useEffect(() => {
    checkHealth();
    const t = setInterval(checkHealth, 30_000);
    return () => clearInterval(t);
  }, [checkHealth]);

  const loadFlows = useCallback(() => {
    setLoading(true);
    fetch('/api/nodered/flows')
      .then(r => r.json())
      .then(data => setFlows(Array.isArray(data) ? data : []))
      .catch(e => toast.error(`Failed to load flows: ${e}`))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadFlows(); }, [loadFlows]);

  // Load persisted node filters from localStorage when flows are fetched
  useEffect(() => {
    if (flows.length === 0) return;
    const loaded: Record<string, Set<string>> = {};
    for (const flow of flows) {
      try {
        const raw = localStorage.getItem(`nr-filter-nodes-${flow.id}`);
        if (raw) loaded[flow.id] = new Set(JSON.parse(raw));
      } catch {}
    }
    setNodeFilters(prev => ({ ...prev, ...loaded }));
  }, [flows]);

  const handleCreate = useCallback(async () => {
    const label = prompt('Flow name:', 'New Flow');
    if (!label) return;
    setCreating(true);
    try {
      const res = await fetch('/api/nodered/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: crypto.randomUUID(), type: 'tab', label, disabled: false, nodes: [], configs: [] }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success('Flow created');
      loadFlows();
    } catch (e) {
      toast.error(`Create failed: ${e}`);
    } finally {
      setCreating(false);
    }
  }, [loadFlows]);

  const filteredEntries = useCallback((flowId: string) => {
    const entries = debugLog[flowId] ?? [];
    const filter = nodeFilters[flowId];
    if (!filter || filter.size === 0) return entries;
    return entries.filter(e => filter.has(e.id));
  }, [debugLog, nodeFilters]);

  const handleToggle = useCallback(async (e: React.MouseEvent, flow: NrFlow) => {
    e.preventDefault();
    e.stopPropagation();
    setToggling(flow.id);
    try {
      const res = await fetch(`/api/nodered/flows/${flow.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...flow, disabled: !flow.disabled }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(flow.disabled ? 'Flow enabled' : 'Flow disabled');
      loadFlows();
    } catch (e) {
      toast.error(`Failed: ${e}`);
    } finally {
      setToggling(null);
    }
  }, [loadFlows]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Workflow</h1>
          <div className="flex items-center gap-2 mt-0.5">
            <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', HEALTH_DOT[health])} />
            <p className="text-sm text-muted-foreground">{HEALTH_LABEL[health]}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/automation/nodes"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
          >
            <Package className="w-4 h-4 mr-1.5" />
            Nodes
          </Link>
          <Button size="sm" onClick={handleCreate} disabled={creating || health !== 'ok'}>
            {creating
              ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
              : <Plus className="w-4 h-4 mr-1.5" />}
            New Flow
          </Button>
        </div>
      </div>

      {/* Flow cards */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : flows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
            <Workflow className="w-10 h-10 text-muted-foreground/40" />
            <div>
              <p className="font-medium">
                {health === 'ok' ? 'Belum ada flow' : 'Tidak bisa terhubung ke Node-RED'}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {health === 'ok'
                  ? 'Buat flow baru atau cek koneksi ke Node-RED'
                  : 'Pastikan container edge-nodered berjalan'}
              </p>
            </div>
            {health === 'ok' && (
              <Button size="sm" onClick={handleCreate}>
                <Plus className="w-4 h-4 mr-1.5" />
                Buat flow pertama
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 max-w-6xl">
            {flows.map(flow => (
              <Link
                key={flow.id}
                href={`/automation/${flow.id.replace(/\./g, '~')}`}
                className={cn(
                  'group relative flex flex-col gap-3 p-5 rounded-xl border border-border bg-card',
                  'hover:border-primary/40 hover:bg-accent/30 hover:shadow-sm transition-all',
                  flow.disabled && 'opacity-60'
                )}
              >
                {/* Status dot */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      'w-2 h-2 rounded-full',
                      flow.disabled ? 'bg-muted-foreground' : 'bg-emerald-500 animate-pulse'
                    )} />
                    <span className="text-xs text-muted-foreground">
                      {flow.disabled ? 'disabled' : 'enabled'}
                    </span>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={e => { e.preventDefault(); e.stopPropagation(); setDebugFlow(flow); }}
                      className="p-1 rounded hover:bg-muted"
                      title="Debug history"
                    >
                      {(() => {
                        const errs = filteredEntries(flow.id).filter(entryIsError).length;
                        return (
                          <Info className={cn('w-3.5 h-3.5', errs > 0 ? 'text-destructive' : 'text-muted-foreground')} />
                        );
                      })()}
                    </button>
                    <button
                      onClick={e => handleToggle(e, flow)}
                      disabled={toggling === flow.id}
                      className="p-1 rounded hover:bg-muted"
                      title={flow.disabled ? 'Enable flow' : 'Disable flow'}
                    >
                      {toggling === flow.id
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : flow.disabled
                          ? <Power className="w-3.5 h-3.5 text-muted-foreground" />
                          : <PowerOff className="w-3.5 h-3.5 text-muted-foreground" />
                      }
                    </button>
                  </div>
                </div>

                {/* Flow name */}
                <div className="flex-1">
                  <p className="font-semibold text-foreground truncate">{flow.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {flow.nodes?.length ?? 0} node{(flow.nodes?.length ?? 0) !== 1 ? 's' : ''}
                  </p>
                </div>

                {/* Arrow + debug badge */}
                <div className="flex items-center justify-between">
                  {(() => {
                    const entries = filteredEntries(flow.id);
                    const errCount  = entries.filter(entryIsError).length;
                    const warnCount = entries.filter(entryIsWarn).length;
                    const total     = entries.length;
                    if (total === 0) return <span />;
                    return (
                      <button
                        onClick={e => { e.preventDefault(); e.stopPropagation(); setDebugFlow(flow); }}
                        className={cn(
                          'flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors',
                          errCount  > 0 ? 'bg-destructive/10 text-destructive hover:bg-destructive/20' :
                          warnCount > 0 ? 'bg-yellow-500/10 text-yellow-600 hover:bg-yellow-500/20' :
                                          'bg-muted text-muted-foreground hover:bg-muted/80'
                        )}
                        title="View debug history"
                      >
                        <Bug className="w-3 h-3" />
                        {errCount > 0 ? `${errCount} error${errCount !== 1 ? 's' : ''}` :
                         warnCount > 0 ? `${warnCount} warn${warnCount !== 1 ? 's' : ''}` :
                                         `${total} msg${total !== 1 ? 's' : ''}`}
                      </button>
                    );
                  })()}
                  <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {debugFlow && (
        <DebugSheet
          open={!!debugFlow}
          onOpenChange={open => { if (!open) setDebugFlow(null); }}
          flow={debugFlow}
          entries={debugLog[debugFlow.id] ?? []}
          onClear={() => clearFlow(debugFlow.id)}
          onFilterChange={nodeIds =>
            setNodeFilters(prev => ({ ...prev, [debugFlow.id]: nodeIds }))
          }
        />
      )}
    </div>
  );
}
