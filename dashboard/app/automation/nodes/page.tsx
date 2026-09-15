'use client';

import { useEffect, useState, useCallback } from 'react';
import { Search, Download, Trash2, Loader2, ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

interface CatalogModule {
  id: string;
  description?: string;
  keywords?: string[];
  version?: string;
  updated_at?: string;
}

interface InstalledModule {
  id: string;
  name: string;
  version?: string;
}

export default function NodesPage() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [modules, setModules] = useState<CatalogModule[]>([]);
  const [total, setTotal] = useState(0);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 400);
    return () => clearTimeout(t);
  }, [q]);

  // Load catalog
  useEffect(() => {
    setLoading(true);
    const url = `/api/nodered/catalog${debouncedQ ? `?q=${encodeURIComponent(debouncedQ)}` : ''}`;
    fetch(url)
      .then(r => r.json())
      .then(d => { setModules(d.modules ?? []); setTotal(d.total ?? 0); })
      .catch(e => toast.error(`Catalog error: ${e}`))
      .finally(() => setLoading(false));
  }, [debouncedQ]);

  // Load installed modules
  const loadInstalled = useCallback(() => {
    fetch('/api/nodered/nodes')
      .then(r => r.json())
      .then((data: InstalledModule[]) => {
        setInstalled(new Set(Array.isArray(data) ? data.map(m => m.id) : []));
      })
      .catch(() => {});
  }, []);

  useEffect(() => { loadInstalled(); }, [loadInstalled]);

  const handleInstall = useCallback(async (id: string) => {
    setActionId(id);
    try {
      const res = await fetch('/api/nodered/nodes/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: id }),
      });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`${id} installed`);
      loadInstalled();
    } catch (e) {
      toast.error(`Install failed: ${e}`);
    } finally {
      setActionId(null);
    }
  }, [loadInstalled]);

  const handleUninstall = useCallback(async (id: string) => {
    if (!confirm(`Uninstall ${id}?`)) return;
    setActionId(id);
    try {
      const res = await fetch(`/api/nodered/nodes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      toast.success(`${id} uninstalled`);
      loadInstalled();
    } catch (e) {
      toast.error(`Uninstall failed: ${e}`);
    } finally {
      setActionId(null);
    }
  }, [loadInstalled]);

  return (
    <div className="h-full flex flex-col">
      <div className="px-6 py-4 border-b border-border flex items-center gap-3">
        <Link
          href="/automation"
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          Automation
        </Link>
        <div className="h-4 w-px bg-border" />
        <div>
          <h1 className="text-lg font-semibold leading-none">Community Nodes</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Browse and install Node-RED community packages</p>
        </div>
      </div>

      <div className="px-6 py-3 border-b border-border">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search community nodes…"
            className="pl-9"
          />
        </div>
        {!loading && (
          <p className="text-xs text-muted-foreground mt-1.5">
            {total} module{total !== 1 ? 's' : ''} · showing first {modules.length}
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : modules.length === 0 ? (
          <p className="text-center text-muted-foreground py-16">No modules found</p>
        ) : (
          <div className="grid gap-3 max-w-3xl">
            {modules.map(m => {
              const isInstalled = installed.has(m.id);
              const inProgress = actionId === m.id;
              return (
                <div
                  key={m.id}
                  className="p-4 rounded-lg border border-border bg-card hover:bg-accent/20 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-sm font-medium">{m.id}</span>
                        {m.version && (
                          <Badge variant="outline" className="text-[10px] h-4 px-1">v{m.version}</Badge>
                        )}
                        {isInstalled && (
                          <Badge className="text-[10px] h-4 px-1 bg-emerald-500/20 text-emerald-500 border-emerald-500/30">installed</Badge>
                        )}
                      </div>
                      {m.description && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{m.description}</p>
                      )}
                      {m.keywords && m.keywords.length > 0 && (
                        <div className="flex gap-1 flex-wrap mt-2">
                          {m.keywords.slice(0, 5).map(k => (
                            <span key={k} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{k}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <Button
                      variant={isInstalled ? 'outline' : 'default'}
                      size="sm"
                      className="h-8 shrink-0"
                      disabled={inProgress}
                      onClick={() => isInstalled ? handleUninstall(m.id) : handleInstall(m.id)}
                    >
                      {inProgress ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : isInstalled ? (
                        <><Trash2 className="w-3 h-3 mr-1" />Remove</>
                      ) : (
                        <><Download className="w-3 h-3 mr-1" />Install</>
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
