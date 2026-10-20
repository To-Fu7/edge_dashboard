'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, RefreshCw, Upload, Pencil, Trash2, AlertTriangle, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { StatusBadge } from '@/components/StatusBadge';
import type { ContainerStatus } from '@/lib/types';

interface Forward {
  id: string;
  name: string;
  deviceCode: string | null;
  srcIp: string;
  srcPort: string;
  listenPort: string;
  enabled: boolean;
}

interface Camera {
  code: string;
  name: string;
  target: { srcIp: string; srcPort: string } | null;
}

interface Overview {
  containerName: string;
  configPath: string;
  status: ContainerStatus;
  portRange: [number, number];
  suggestedPort: string | null;
  forwards: Forward[];
  cameras: Camera[];
  liveConf: string | null;
  expectedConf: string;
  inSync: boolean;
  logs: string[];
}

interface DeployResult { deployed: boolean; skipped?: boolean; error?: string }

type FormState = Omit<Forward, 'id'>;

const MANUAL = '__manual';

async function fetchOverview(): Promise<Overview> {
  const res = await fetch('/api/portforward');
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || 'Request failed');
  return d;
}

function reportDeploy(deploy: DeployResult | undefined, okMessage: string) {
  if (!deploy || deploy.deployed) toast.success(okMessage);
  else if (deploy.skipped) toast.warning(`${okMessage}, but nginx is not running: ${deploy.error}`);
  else toast.error(`${okMessage}, but nginx deploy failed: ${deploy.error}`);
}

export default function NginxSettingsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [showExpected, setShowExpected] = useState(false);
  const [editing, setEditing] = useState<{ id: string | null; form: FormState } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const newForm = useCallback((d: Overview, deviceCode: string | null): FormState => {
    const cam = deviceCode ? d.cameras.find(c => c.code === deviceCode) : undefined;
    return {
      name: cam?.name ?? '',
      deviceCode: cam?.code ?? null,
      srcIp: cam?.target?.srcIp ?? '',
      srcPort: cam?.target?.srcPort ?? '554',
      listenPort: d.suggestedPort ?? '',
      enabled: true,
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchOverview());
    } catch (e) {
      toast.error(`Failed to load nginx status: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchOverview()
      .then(d => {
        if (cancelled) return;
        setData(d);
        // Arriving from a device page ("Forward this camera"): open the form
        // with that camera selected.
        const device = new URLSearchParams(window.location.search).get('device');
        if (device && d.cameras.some(c => c.code === device)) {
          setEditing({ id: null, form: newForm(d, device) });
        }
      })
      .catch(e => toast.error(`Failed to load nginx status: ${String(e)}`))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [newForm]);

  async function redeploy() {
    setDeploying(true);
    try {
      const res = await fetch('/api/portforward/deploy', { method: 'POST' });
      const d: DeployResult = await res.json();
      reportDeploy(d, 'Config redeployed');
      await load();
    } finally {
      setDeploying(false);
    }
  }

  async function save(id: string | null, form: FormState): Promise<string | null> {
    const res = await fetch(id ? `/api/portforward/${id}` : '/api/portforward', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    });
    const d = await res.json();
    if (!res.ok) return d.error || 'Save failed';
    reportDeploy(d.deploy, id ? 'Forward updated' : 'Forward added');
    await load();
    return null;
  }

  async function toggle(f: Forward, enabled: boolean) {
    const problem = await save(f.id, { ...f, enabled });
    if (problem) toast.error(problem);
  }

  async function remove(id: string) {
    setConfirmDelete(null);
    const res = await fetch(`/api/portforward/${id}`, { method: 'DELETE' });
    const d = await res.json();
    if (!res.ok) { toast.error(d.error || 'Delete failed'); return; }
    reportDeploy(d.deploy, 'Forward removed');
    await load();
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed');
    }
  }

  if (loading && !data) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (!data) return <div className="p-6 text-muted-foreground">Nginx status unavailable.</div>;

  const host = typeof window !== 'undefined' ? window.location.hostname : '<server-ip>';
  const cameraByCode = new Map(data.cameras.map(c => [c.code, c]));
  const shownConf = showExpected || data.liveConf === null ? data.expectedConf : data.liveConf;

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Nginx</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Forward camera RTSP streams to host ports {data.portRange[0]}–{data.portRange[1]}. Each viewer of a
            forward opens its own connection to the camera; for many viewers use the Stream page instead.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={load} disabled={loading} aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="outline" size="sm" onClick={redeploy} disabled={deploying || data.status !== 'running'}>
            <Upload className="w-4 h-4 mr-1.5" />
            {deploying ? 'Deploying...' : 'Redeploy'}
          </Button>
          <Button size="sm" onClick={() => setEditing({ id: null, form: newForm(data, null) })}>
            <Plus className="w-4 h-4 mr-1.5" />
            Add forward
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-base">{data.containerName}</span>
            <StatusBadge status={data.status} />
            {data.liveConf !== null && (
              data.inSync
                ? <Badge variant="outline">Config in sync</Badge>
                : <Badge variant="destructive">Redeploy pending</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Config at <span className="font-mono">{data.configPath}</span>. Changes below are validated with
            <span className="font-mono"> nginx -t</span> and reloaded immediately, with no container restart.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Forwards ({data.forwards.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {data.forwards.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No forwards yet. Click <span className="font-medium text-foreground">Add forward</span> and pick a camera.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Camera</th>
                    <th className="py-2 pr-4 font-medium">Connect to</th>
                    <th className="py-2 pr-4 font-medium">Forwards to</th>
                    <th className="py-2 pr-4 font-medium">Enabled</th>
                    <th className="py-2 font-medium sr-only">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.forwards.map(f => {
                    const cam = f.deviceCode ? cameraByCode.get(f.deviceCode) : undefined;
                    const drifted = cam?.target && (cam.target.srcIp !== f.srcIp || cam.target.srcPort !== f.srcPort);
                    const connect = `${host}:${f.listenPort}`;
                    return (
                      <tr key={f.id} className="border-b border-border last:border-0 align-top">
                        <td className="py-2 pr-4">{f.name}</td>
                        <td className="py-2 pr-4">
                          {!f.deviceCode ? (
                            <span className="text-muted-foreground">Manual</span>
                          ) : cam ? (
                            <Link href={`/devices/${f.deviceCode}`} className="text-primary hover:underline">{f.deviceCode}</Link>
                          ) : (
                            <span className="text-muted-foreground">{f.deviceCode} (removed)</span>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <button
                            type="button"
                            onClick={() => copy(connect)}
                            className="inline-flex items-center gap-1.5 font-mono tabular-nums hover:text-primary"
                            title="Copy"
                          >
                            {connect}
                            <Copy className="w-3 h-3" />
                          </button>
                        </td>
                        <td className="py-2 pr-4">
                          <span className="font-mono">{f.srcIp}:{f.srcPort}</span>
                          {drifted && (
                            <div className="mt-1 flex items-center gap-1.5 text-xs text-yellow-500">
                              <AlertTriangle className="w-3 h-3 shrink-0" />
                              Camera RTSP now points to {cam!.target!.srcIp}:{cam!.target!.srcPort}
                              <button
                                type="button"
                                className="underline hover:text-foreground"
                                onClick={() => save(f.id, { ...f, ...cam!.target! }).then(p => p && toast.error(p))}
                              >
                                Update
                              </button>
                            </div>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <Switch checked={f.enabled} onCheckedChange={v => toggle(f, v)} aria-label={`Enable ${f.name}`} />
                        </td>
                        <td className="py-2 text-right whitespace-nowrap">
                          {confirmDelete === f.id ? (
                            <span className="inline-flex items-center gap-1">
                              <Button size="sm" variant="destructive" onClick={() => remove(f.id)}>Delete</Button>
                              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <Button size="sm" variant="ghost" aria-label={`Edit ${f.name}`}
                                onClick={() => setEditing({ id: f.id, form: { ...f } })}>
                                <Pencil className="w-4 h-4" />
                              </Button>
                              <Button size="sm" variant="ghost" aria-label={`Delete ${f.name}`}
                                onClick={() => setConfirmDelete(f.id)}>
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-3">
            <span>{showExpected || data.liveConf === null ? 'Generated config' : 'Live config'}</span>
            {data.liveConf !== null && (
              <Button variant="ghost" size="sm" onClick={() => setShowExpected(v => !v)}>
                {showExpected ? 'Show live' : 'Show generated'}
              </Button>
            )}
          </CardTitle>
          {data.liveConf === null && (
            <CardDescription>The forwarder container is not reachable, so the live config can&apos;t be read.</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <pre className="text-xs font-mono bg-black/90 text-gray-300 rounded border border-border p-3 overflow-x-auto max-h-96">
            {shownConf}
          </pre>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Container logs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-xs font-mono bg-black/90 text-gray-300 rounded border border-border p-3 overflow-auto max-h-80">
            {data.logs.length === 0
              ? <p className="text-gray-500">No logs.</p>
              : data.logs.map((line, i) => (
                  <p key={i} className={/\[(error|crit|emerg|alert)\]/i.test(line) ? 'text-red-400' : /\[warn\]/i.test(line) ? 'text-yellow-400' : undefined}>
                    {line}
                  </p>
                ))}
          </div>
        </CardContent>
      </Card>

      {editing && (
        <ForwardDialog
          key={editing.id ?? 'new'}
          initial={editing.form}
          isNew={editing.id === null}
          cameras={data.cameras}
          portRange={data.portRange}
          onClose={() => setEditing(null)}
          onSave={async form => {
            const problem = await save(editing.id, form);
            if (!problem) setEditing(null);
            return problem;
          }}
        />
      )}
    </div>
  );
}

function ForwardDialog({
  initial, isNew, cameras, portRange, onClose, onSave,
}: {
  initial: FormState;
  isNew: boolean;
  cameras: Camera[];
  portRange: [number, number];
  onClose: () => void;
  onSave: (form: FormState) => Promise<string | null>;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm(f => ({ ...f, [key]: value }));

  function pickSource(value: string) {
    if (value === MANUAL) {
      setForm(f => ({ ...f, deviceCode: null }));
      return;
    }
    const cam = cameras.find(c => c.code === value);
    if (!cam) return;
    setForm(f => ({
      ...f,
      deviceCode: cam.code,
      // Keep a name the user typed; otherwise follow the camera.
      name: !f.name || cameras.some(c => c.name === f.name) ? cam.name : f.name,
      srcIp: cam.target?.srcIp ?? f.srcIp,
      srcPort: cam.target?.srcPort ?? f.srcPort,
    }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(await onSave(form));
    setSaving(false);
  }

  const selected = form.deviceCode ? cameras.find(c => c.code === form.deviceCode) : undefined;
  const sourceItems: Record<string, string> = {
    [MANUAL]: 'Manual (type an IP)',
    ...Object.fromEntries(cameras.map(c => [c.code, `${c.name} (${c.code})`])),
  };

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Add forward' : 'Edit forward'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="fwd-source">Camera</Label>
            <Select items={sourceItems} value={form.deviceCode ?? MANUAL} onValueChange={v => v && pickSource(v)}>
              <SelectTrigger id="fwd-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MANUAL}>{sourceItems[MANUAL]}</SelectItem>
                {cameras.map(c => (
                  <SelectItem key={c.code} value={c.code}>{sourceItems[c.code]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selected && !selected.target && (
              <p className="text-xs text-yellow-500">This camera has no valid RTSP URL, so fill in the target by hand.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fwd-name">Name</Label>
            <Input id="fwd-name" value={form.name} onChange={e => set('name', e.target.value)} placeholder="CCTV B2 Selatan" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5 col-span-2">
              <Label htmlFor="fwd-ip">Target IP / host</Label>
              <Input id="fwd-ip" value={form.srcIp} onChange={e => set('srcIp', e.target.value)} placeholder="10.11.0.48" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fwd-port">Target port</Label>
              <Input id="fwd-port" value={form.srcPort} onChange={e => set('srcPort', e.target.value)} placeholder="554" className="font-mono" />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 items-end">
            <div className="space-y-1.5">
              <Label htmlFor="fwd-listen">Listen port</Label>
              <Input id="fwd-listen" value={form.listenPort} onChange={e => set('listenPort', e.target.value)}
                placeholder={String(portRange[0])} className="font-mono" />
            </div>
            <p className="col-span-2 text-xs text-muted-foreground pb-2">
              Host port between {portRange[0]} and {portRange[1]}. Clients connect to
              <span className="font-mono"> &lt;server-ip&gt;:{form.listenPort || '…'}</span>.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Switch id="fwd-enabled" checked={form.enabled} onCheckedChange={v => set('enabled', v)} />
            <Label htmlFor="fwd-enabled">Enabled</Label>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving...' : isNew ? 'Add forward' : 'Save'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
