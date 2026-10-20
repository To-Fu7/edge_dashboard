'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Trash2, ChevronDown, Search, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { type NrDebugEntry, entryIsError, entryIsWarn } from '@/hooks/useNrDebug';
import type { NrFlow } from '@/lib/nodered';

// ── Node type colours (NR palette) ───────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
  inject:          '#7fc3e4',
  debug:           '#87d745',
  function:        '#fdd0a2',
  switch:          '#e2d96e',
  change:          '#98c0e3',
  template:        '#def7e0',
  delay:           '#e2d9c5',
  trigger:         '#e2d9c5',
  comment:         '#d9d9d9',
  catch:           '#f9a8a8',
  complete:        '#c3e6a8',
  status:          '#ade8f0',
  'http in':       '#82c7a5',
  'http response': '#82c7a5',
  'http request':  '#b2d8b2',
  'mqtt in':       '#d7b4e8',
  'mqtt out':      '#d7b4e8',
  'link in':       '#c5c5c5',
  'link out':      '#c5c5c5',
  'link call':     '#c5c5c5',
  split:           '#e8c9a0',
  join:            '#e8c9a0',
  sort:            '#e8c9a0',
  batch:           '#e8c9a0',
  exec:            '#c9d0d5',
  json:            '#b8d4e8',
  xml:             '#b8d4e8',
  yaml:            '#b8d4e8',
  csv:             '#b8d4e8',
  file:            '#c9b8a8',
  'file in':       '#c9b8a8',
  tail:            '#c9b8a8',
  subflow:         '#e8c5e0',
};

function nodeColor(type: string): string {
  const lower = type.toLowerCase();
  if (NODE_COLORS[lower]) return NODE_COLORS[lower];
  // deterministic pastel from type hash
  let h = 0;
  for (let i = 0; i < lower.length; i++) h = ((h << 5) - h + lower.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 50%, 75%)`;
}

// ── Level definitions ────────────────────────────────────────────────────────

type LevelGroup = 'error' | 'warn' | 'info' | 'debug';

const LEVEL_GROUPS: { key: LevelGroup; label: string; test: (e: NrDebugEntry) => boolean }[] = [
  { key: 'error', label: 'Error', test: entryIsError },
  { key: 'warn',  label: 'Warn',  test: entryIsWarn },
  { key: 'info',  label: 'Info',  test: e => e.level > 30 && e.level <= 40 },
  { key: 'debug', label: 'Debug', test: e => e.level > 40 },
];

const LEVEL_RING: Record<LevelGroup, string> = {
  error: 'data-[on=true]:ring-destructive/60 data-[on=true]:bg-destructive/10 data-[on=true]:text-destructive',
  warn:  'data-[on=true]:ring-yellow-500/60 data-[on=true]:bg-yellow-500/10 data-[on=true]:text-yellow-600',
  info:  'data-[on=true]:ring-blue-500/60 data-[on=true]:bg-blue-500/10 data-[on=true]:text-blue-500',
  debug: 'data-[on=true]:ring-border data-[on=true]:bg-muted data-[on=true]:text-foreground',
};

function levelLabel(level: number): string {
  if (level <= 10) return 'FATAL';
  if (level <= 20) return 'ERROR';
  if (level <= 30) return 'WARN';
  if (level <= 40) return 'INFO';
  if (level <= 50) return 'DEBUG';
  return 'TRACE';
}

function levelGroup(level: number): LevelGroup {
  if (level <= 20) return 'error';
  if (level <= 30) return 'warn';
  if (level <= 40) return 'info';
  return 'debug';
}

function formatMsg(msg: unknown): string {
  if (msg === null || msg === undefined) return 'null';
  if (typeof msg === 'string') return msg;
  try { return JSON.stringify(msg, null, 2); } catch { return String(msg); }
}

// ── Node type representing a flow node ───────────────────────────────────────

interface FlowNode {
  id: string;
  type: string;
  name?: string;
}

// ── Custom node selector ─────────────────────────────────────────────────────

interface NodeSelectorProps {
  nodes: FlowNode[];
  selected: Set<string>;
  onChange: (id: string) => void;
  onClear: () => void;
}

function NodeSelector({ nodes, selected, onChange, onClear }: NodeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else setSearch('');
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return nodes.filter(n =>
      (n.name ?? '').toLowerCase().includes(q) ||
      n.type.toLowerCase().includes(q) ||
      n.id.toLowerCase().includes(q)
    );
  }, [nodes, search]);

  const label = selected.size === 0
    ? 'All nodes'
    : selected.size === 1
      ? (nodes.find(n => n.id === [...selected][0])?.name || [...selected][0].slice(0, 8))
      : `${selected.size} nodes selected`;

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <button
        onClick={() => setOpen(v => !v)}
        className={cn(
          'w-full flex items-center gap-2 rounded-md border border-border bg-background',
          'px-2.5 py-1.5 text-xs text-left transition-colors hover:bg-muted/50',
          open && 'ring-1 ring-ring border-ring'
        )}
      >
        {selected.size > 0 && (
          <span className="flex items-center gap-1 flex-wrap flex-1 min-w-0">
            {[...selected].slice(0, 3).map(id => {
              const node = nodes.find(n => n.id === id);
              return (
                <span
                  key={id}
                  className="flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-foreground"
                  style={{ backgroundColor: `${nodeColor(node?.type ?? '')}55`, border: `1px solid ${nodeColor(node?.type ?? '')}99` }}
                >
                  <span
                    className="w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: nodeColor(node?.type ?? '') }}
                  />
                  {node?.name || node?.type || id.slice(0, 8)}
                </span>
              );
            })}
            {selected.size > 3 && (
              <span className="text-muted-foreground text-[10px]">+{selected.size - 3}</span>
            )}
          </span>
        )}
        {selected.size === 0 && (
          <span className="flex-1 text-muted-foreground">{label}</span>
        )}
        <ChevronDown className={cn('w-3 h-3 text-muted-foreground shrink-0 transition-transform', open && 'rotate-180')} />
      </button>

      {selected.size > 0 && (
        <button
          onClick={e => { e.stopPropagation(); onClear(); }}
          className="absolute right-6 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
        >
          <X className="w-3 h-3" />
        </button>
      )}

      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
          {/* Search */}
          <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search nodes…"
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Node list */}
          <div className="max-h-52 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">No nodes found</p>
            ) : (
              filtered.map(node => {
                const isSelected = selected.has(node.id);
                const color = nodeColor(node.type);
                return (
                  <button
                    key={node.id}
                    onClick={() => onChange(node.id)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors',
                      isSelected ? 'bg-primary/5' : 'hover:bg-muted/60'
                    )}
                  >
                    {/* Color dot */}
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0 ring-1 ring-black/10"
                      style={{ backgroundColor: color }}
                    />
                    {/* Node name + type */}
                    <span className="flex-1 min-w-0">
                      <span className="font-medium text-foreground truncate block">
                        {node.name || `(unnamed)`}
                      </span>
                      <span className="text-muted-foreground text-[10px]">{node.type}</span>
                    </span>
                    {/* Checkmark */}
                    {isSelected && <Check className="w-3 h-3 text-primary shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Entry row ────────────────────────────────────────────────────────────────

function EntryRow({ entry }: { entry: NrDebugEntry }) {
  const isErr  = entryIsError(entry);
  const isWarn = entryIsWarn(entry);
  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 font-mono text-xs space-y-1',
      isErr  ? 'border-destructive/40 bg-destructive/5' :
      isWarn ? 'border-yellow-500/40 bg-yellow-500/5' :
               'border-border bg-muted/30'
    )}>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className={cn(
          'font-semibold uppercase shrink-0',
          isErr ? 'text-destructive' : isWarn ? 'text-yellow-500' : 'text-muted-foreground'
        )}>
          {levelLabel(entry.level)}
        </span>
        <span className="truncate flex-1">{entry.name || entry.id}</span>
        <span className="shrink-0">{new Date(entry.ts).toLocaleTimeString()}</span>
      </div>
      <pre className="whitespace-pre-wrap break-all text-foreground leading-relaxed max-h-40 overflow-y-auto">
        {formatMsg(entry.msg)}
      </pre>
    </div>
  );
}

// ── Main sheet ───────────────────────────────────────────────────────────────

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flow: NrFlow;
  entries: NrDebugEntry[];
  onClear: () => void;
  onFilterChange?: (nodeIds: Set<string>) => void;
}

const STORAGE_KEY = (flowId: string) => `nr-filter-nodes-${flowId}`;

export function DebugSheet({ open, onOpenChange, flow, entries, onClear, onFilterChange }: Props) {
  // Level filter — all ON by default, not persisted (session preference)
  const [activeLevels, setActiveLevels] = useState<Set<LevelGroup>>(
    new Set(['error', 'warn', 'info', 'debug'])
  );

  // Node filter — persisted to localStorage per flow
  const [filterNodeIds, setFilterNodeIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY(flow.id));
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });

  // Keep onFilterChange stable across renders via ref
  const onFilterChangeRef = useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;

  // Persist node filter whenever it changes, then notify parent
  useEffect(() => {
    try {
      if (filterNodeIds.size === 0) {
        localStorage.removeItem(STORAGE_KEY(flow.id));
      } else {
        localStorage.setItem(STORAGE_KEY(flow.id), JSON.stringify([...filterNodeIds]));
      }
    } catch {}
    onFilterChangeRef.current?.(filterNodeIds);
  }, [filterNodeIds, flow.id]);

  // Reload filter when flow changes (sheet reused for different flows)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY(flow.id));
      setFilterNodeIds(saved ? new Set(JSON.parse(saved)) : new Set());
    } catch { setFilterNodeIds(new Set()); }
  }, [flow.id]);

  function toggleNode(id: string) {
    setFilterNodeIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleLevel(key: LevelGroup) {
    setActiveLevels(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  // All nodes in flow, merged with nodes seen in entries
  const allNodes = useMemo((): FlowNode[] => {
    const map = new Map<string, FlowNode>();
    for (const n of flow.nodes) {
      const name = (n as Record<string, unknown>).name as string | undefined;
      map.set(n.id, { id: n.id, type: n.type, name: name || undefined });
    }
    // also include nodes seen in entries that might not be in flow.nodes
    for (const e of entries) {
      if (!map.has(e.id)) map.set(e.id, { id: e.id, type: 'unknown', name: e.name || undefined });
    }
    return [...map.values()].sort((a, b) =>
      (a.name ?? a.type).localeCompare(b.name ?? b.type)
    );
  }, [flow.nodes, entries]);

  const filtered = useMemo(() => {
    return entries.filter(e => {
      if (filterNodeIds.size > 0 && !filterNodeIds.has(e.id)) return false;
      if (!activeLevels.has(levelGroup(e.level))) return false;
      return true;
    });
  }, [entries, filterNodeIds, activeLevels]);

  const totals = useMemo(() => ({
    error: entries.filter(entryIsError).length,
    warn:  entries.filter(entryIsWarn).length,
  }), [entries]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col gap-0 p-0">

        {/* Header */}
        <SheetHeader className="px-4 pt-4 pb-3 border-b border-border shrink-0">
          <div className="flex items-start justify-between pr-8">
            <div>
              <SheetTitle>{flow.label}</SheetTitle>
              <SheetDescription className="flex gap-2 flex-wrap">
                <span>{entries.length} message{entries.length !== 1 ? 's' : ''}</span>
                {totals.error > 0 && <span className="text-destructive">{totals.error} error{totals.error !== 1 ? 's' : ''}</span>}
                {totals.warn  > 0 && <span className="text-yellow-500">{totals.warn} warn{totals.warn !== 1 ? 's' : ''}</span>}
              </SheetDescription>
            </div>
            {entries.length > 0 && (
              <Button variant="ghost" size="icon-sm" onClick={onClear} title="Clear history">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        </SheetHeader>

        {/* Filters */}
        <div className="px-4 py-3 border-b border-border shrink-0 space-y-3">

          {/* Node selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground shrink-0 w-10">Node</span>
            <NodeSelector
              nodes={allNodes}
              selected={filterNodeIds}
              onChange={toggleNode}
              onClear={() => setFilterNodeIds(new Set())}
            />
          </div>

          {/* Level toggles */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-muted-foreground w-10 shrink-0">Level</span>
            {LEVEL_GROUPS.map(({ key, label }) => {
              const on = activeLevels.has(key);
              return (
                <button
                  key={key}
                  data-on={on}
                  onClick={() => toggleLevel(key)}
                  className={cn(
                    'rounded-full px-2.5 py-0.5 text-[10px] font-medium ring-1 ring-inset transition-all',
                    'ring-border text-muted-foreground',
                    LEVEL_RING[key],
                    !on && 'opacity-35'
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Message list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              {entries.length === 0 ? (
                <>
                  <p className="text-sm text-muted-foreground">No debug messages yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Add a Debug node in this flow to see output here.
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No messages match the current filter.</p>
              )}
            </div>
          ) : (
            [...filtered].reverse().map((e, i) => (
              <EntryRow key={`${e._msgid}-${i}`} entry={e} />
            ))
          )}
        </div>

      </SheetContent>
    </Sheet>
  );
}
