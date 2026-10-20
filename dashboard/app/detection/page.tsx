'use client';

import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Play, Square, RotateCcw, Camera, AlertCircle, RefreshCw, Layers, HammerIcon, Cpu, MemoryStick, MonitorDot, ArrowRight, ArrowDownToLine, ArrowUpFromLine, Gauge, Users } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import type { ContainerStatus } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Heartbeat {
  state: string;               // starting | running | degraded | error | stopping
  fps: number | null;
  persons: number | null;
  in_today: number | null;
  out_today: number | null;
  config_version: number | null;
  triton_ok: boolean | null;
  last_error: string | null;
  updated_at: string;
  stale: boolean;
  age_s: number;
}

interface Device {
  deviceCode: string;
  deviceName: string;
  deviceId: string;
  containerName: string;
  status: ContainerStatus;
  enabled: boolean;
  configVersion: number;
  heartbeat: Heartbeat | null;
}

/** One live state per camera, combining the container and its heartbeat. */
type LiveState = 'running' | 'degraded' | 'starting' | 'offline' | 'stopped';

function liveState(d: Device): LiveState {
  if (d.status !== 'running') return 'stopped';
  const hb = d.heartbeat;
  if (!hb || hb.stale) return hb ? 'offline' : 'starting';
  if (hb.state === 'degraded' || hb.state === 'error') return 'degraded';
  if (hb.state === 'starting' || hb.state === 'stopping') return 'starting';
  return 'running';
}

const STATE_STYLE: Record<LiveState, { label: string; dot: string; pill: string }> = {
  running:  { label: 'Running',  dot: 'bg-emerald-500', pill: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  degraded: { label: 'Degraded', dot: 'bg-amber-500',   pill: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  starting: { label: 'Starting', dot: 'bg-sky-500 animate-pulse', pill: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  offline:  { label: 'No signal', dot: 'bg-red-500',    pill: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  stopped:  { label: 'Stopped',  dot: 'bg-muted-foreground/50', pill: 'bg-muted text-muted-foreground' },
};

export default function DetectionDashboardPage() {
  return <HomePageContent />;
}

function HomePageContent() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<Record<string, string>>({});
  const [startingAll, setStartingAll] = useState(false);
  const [imageReady, setImageReady] = useState<boolean | null>(null);
  const [admin, setAdmin] = useState(false);

  useEffect(() => {
    fetch('/api/auth/me').then(r => r.json()).then(d => {
      const isAdmin = d.user?.role === 'admin';
      setAdmin(isAdmin);
      if (isAdmin) {
        fetch('/api/compose/status').then(r => r.json()).then(s => setImageReady(s.imageReady)).catch(() => setImageReady(false));
      }
    }).catch(() => {});
  }, []);

  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch('/api/devices');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDevices(data.devices || []);
    } catch (e) {
      toast.error(`Failed to fetch cameras: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(fetchDevices, 0);
    const interval = setInterval(fetchDevices, 5000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, [fetchDevices]);

  async function startAll() {
    setStartingAll(true);
    try {
      const res = await fetch('/api/compose/up', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success('All cameras started');
      setTimeout(fetchDevices, 2000);
    } catch (e) {
      toast.error(`Start all failed: ${(e as Error).message}`);
    } finally {
      setStartingAll(false);
    }
  }

  async function containerAction(code: string, action: 'start' | 'stop' | 'restart') {
    setActionLoading(prev => ({ ...prev, [code]: action }));
    try {
      const res = await fetch(`/api/devices/${code}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`${action.charAt(0).toUpperCase() + action.slice(1)}ed ${code}`);
      setTimeout(fetchDevices, 1500);
    } catch (e) {
      toast.error(`Failed to ${action}: ${(e as Error).message}`);
    } finally {
      setActionLoading(prev => { const n = { ...prev }; delete n[code]; return n; });
    }
  }

  const states = devices.map(liveState);
  const online = states.filter(s => s === 'running' || s === 'degraded').length;
  const problems = states.filter(s => s === 'degraded' || s === 'offline').length;
  const beats = devices.map(d => d.heartbeat).filter((h): h is Heartbeat => !!h && !h.stale);
  const totalIn = beats.reduce((n, h) => n + (h.in_today ?? 0), 0);
  const totalOut = beats.reduce((n, h) => n + (h.out_today ?? 0), 0);
  const fpsValues = beats.map(h => h.fps).filter((f): f is number => typeof f === 'number');
  const avgFps = fpsValues.length ? fpsValues.reduce((a, b) => a + b, 0) / fpsValues.length : null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Detection Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {loading ? 'Loading...' : `${online} of ${devices.length} cameras online · updates every 5 s`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchDevices} disabled={loading} aria-label="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          {admin && (
            <Button variant="outline" size="sm" onClick={startAll} disabled={startingAll}>
              <Layers className={`w-4 h-4 mr-2 ${startingAll ? 'animate-pulse' : ''}`} />
              {startingAll ? 'Starting...' : 'Start all'}
            </Button>
          )}
        </div>
      </div>

      {devices.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <SummaryTile label="Cameras online" value={`${online}/${devices.length}`} tone={online === devices.length ? 'good' : 'warn'} />
          <SummaryTile label="In today" value={totalIn.toLocaleString()} icon={ArrowDownToLine} tone="neutral" />
          <SummaryTile label="Out today" value={totalOut.toLocaleString()} icon={ArrowUpFromLine} tone="neutral" />
          <SummaryTile
            label={problems ? 'Need attention' : 'Average FPS'}
            value={problems ? String(problems) : avgFps !== null ? avgFps.toFixed(1) : '—'}
            icon={problems ? AlertCircle : Gauge}
            tone={problems ? 'bad' : 'neutral'}
          />
        </div>
      )}

      <SystemStats />

      <TritonStatusCard admin={admin} />

      {admin && imageReady === false && (
        <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-yellow-500 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-2">
            <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">Camera image not built yet</p>
            <p className="text-xs text-muted-foreground">
              The image <code className="font-mono bg-muted px-1 rounded">edge-device:latest</code> does not exist locally.
              Build it once before starting any cameras.
            </p>
          </div>
          <Link href="/inference" className="shrink-0">
            <Button size="sm">
              <HammerIcon className="w-4 h-4 mr-2" />
              Build Image
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </Link>
        </div>
      )}

      {!loading && devices.length === 0 && (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <Camera className="w-12 h-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground text-sm mb-4">No cameras configured yet.</p>
          {admin && (
            <Link href="/detection/devices">
              <Button size="sm">Add your first camera</Button>
            </Link>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {devices.map(device => (
          <DeviceCard
            key={device.deviceId}
            device={device}
            admin={admin}
            actionLoading={actionLoading[device.deviceCode]}
            onAction={containerAction}
          />
        ))}
      </div>
    </div>
  );
}

function SummaryTile({ label, value, icon: Icon, tone }: {
  label: string; value: string; icon?: typeof Camera; tone: 'good' | 'warn' | 'bad' | 'neutral';
}) {
  return (
    <div className={cn('rounded-lg border p-4', {
      'border-emerald-500/30 bg-emerald-500/5': tone === 'good',
      'border-amber-500/30 bg-amber-500/5': tone === 'warn',
      'border-red-500/40 bg-red-500/10': tone === 'bad',
      'border-border bg-card': tone === 'neutral',
    })}>
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        {Icon && <Icon className="w-3.5 h-3.5" />}{label}
      </p>
      <p className="text-2xl font-semibold tabular-nums mt-1">{value}</p>
    </div>
  );
}

interface TritonStatusData {
  containerStatus: string;
  reachable: boolean;
  ready: boolean;
  models: { name: string; state?: string }[];
  metrics: { requestSuccess: number; requestFailure: number } | null;
}

function TritonStatusCard({ admin }: { admin: boolean }) {
  const [status, setStatus] = useState<TritonStatusData | null>(null);
  const [acting, setActing] = useState('');

  const poll = () => {
    fetch('/api/triton/status')
      .then(r => r.json())
      .then(setStatus)
      .catch(() => {});
  };

  useEffect(() => {
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  async function action(name: string) {
    setActing(name);
    try {
      const res = await fetch(`/api/triton/${name}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      poll();
    } catch (e) {
      toast.error(`Triton ${name} failed: ${(e as Error).message}`);
    } finally {
      setActing('');
    }
  }

  const ready = status?.ready === true;
  const down = status !== null && !ready;
  const readyModels = status?.models.filter(m => m.state === 'READY').length ?? 0;

  return (
    <div className={`rounded-lg border p-3 flex items-center justify-between gap-4 ${
      down ? 'border-red-500/50 bg-red-500/10' : 'border-border bg-card'
    }`}>
      <div className="flex items-center gap-3 min-w-0">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${ready ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} />
        <div className="min-w-0">
          <p className="text-sm font-medium">
            Triton Inference Server
            <span className="ml-2 text-xs text-muted-foreground">
              {status === null ? '—' : ready ? `ready · ${readyModels} model${readyModels === 1 ? '' : 's'} loaded` : `container ${status.containerStatus} — cameras run degraded until Triton is up`}
            </span>
          </p>
          {ready && status?.metrics && (
            <p className="text-[10px] text-muted-foreground tabular-nums">
              {status.metrics.requestSuccess.toLocaleString()} inferences · {status.metrics.requestFailure.toLocaleString()} failures
            </p>
          )}
        </div>
      </div>
      {admin && (
      <div className="flex gap-2 shrink-0">
        {!ready && (
          <Button size="sm" variant="outline" onClick={() => action('start')} disabled={!!acting}>
            {acting === 'start' ? 'Starting…' : 'Start'}
          </Button>
        )}
        {ready && (
          <Button size="sm" variant="outline" onClick={() => action('restart')} disabled={!!acting}>
            {acting === 'restart' ? 'Restarting…' : 'Restart'}
          </Button>
        )}
        <Link href="/inference">
          <Button size="sm" variant="outline" title="Export ONNX / build TensorRT engines / build camera image, with live logs">
            Build & Inference
            <ArrowRight className="w-4 h-4 ml-2" />
          </Button>
        </Link>
      </div>
      )}
    </div>
  );
}

interface GpuInfo {
  name: string;
  utilization: number;
  memUsed: number;            // MB
  memTotal: number;           // MB
  powerDraw: number | null;   // W
  powerLimit: number | null;  // W
}
interface SystemData {
  cpu: { pct: number };
  ram: { used: number; total: number; usedGb: string; totalGb: string; pct: number };
  gpus: GpuInfo[] | null;
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${color}`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

function SystemStats() {
  const [data, setData] = useState<SystemData | null>(null);

  useEffect(() => {
    function poll() {
      fetch('/api/system')
        .then(r => r.json())
        .then(setData)
        .catch(() => {});
    }
    poll();
    const id = setInterval(poll, 3000);
    return () => clearInterval(id);
  }, []);

  const dash = '—';

  return (
    <div className="grid grid-cols-3 gap-3">
      {/* CPU */}
      <div className="rounded-lg border border-border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Cpu className="w-3.5 h-3.5" />
            CPU
          </div>
          <span className="text-sm font-semibold tabular-nums">
            {data ? `${data.cpu.pct}%` : dash}
          </span>
        </div>
        <Bar pct={data?.cpu.pct ?? 0} color="bg-blue-500" />
      </div>

      {/* RAM */}
      <div className="rounded-lg border border-border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MemoryStick className="w-3.5 h-3.5" />
            RAM
          </div>
          <span className="text-sm font-semibold tabular-nums">
            {data ? `${data.ram.usedGb} / ${data.ram.totalGb} GB` : dash}
          </span>
        </div>
        <Bar pct={data?.ram.pct ?? 0} color="bg-emerald-500" />
      </div>

      {/* GPU */}
      <div className="rounded-lg border border-border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <MonitorDot className="w-3.5 h-3.5" />
            {data?.gpus?.[0]?.name
              ? <span className="truncate max-w-[120px]" title={data.gpus[0].name}>{data.gpus[0].name}</span>
              : 'GPU'}
          </div>
          <span className="text-sm font-semibold tabular-nums">
            {data === null ? dash : data.gpus === null ? 'N/A' : `${data.gpus[0].utilization}%`}
          </span>
        </div>
        {data?.gpus ? (() => {
          const g = data.gpus[0];
          const memPct = Math.round(g.memUsed / g.memTotal * 100);
          const powerPct = g.powerDraw !== null && g.powerLimit ? Math.round(g.powerDraw / g.powerLimit * 100) : null;
          return (
            <div className="space-y-1.5">
              <Bar pct={g.utilization} color="bg-orange-500" />
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-muted-foreground">VRAM</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {(g.memUsed / 1024).toFixed(1)} / {(g.memTotal / 1024).toFixed(1)} GB ({memPct}%)
                </span>
              </div>
              <Bar pct={memPct} color="bg-purple-500" />
              {g.powerDraw !== null && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">Power</span>
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {g.powerDraw.toFixed(0)}{g.powerLimit ? ` / ${g.powerLimit.toFixed(0)}` : ''} W
                      {powerPct !== null ? ` (${powerPct}%)` : ''}
                    </span>
                  </div>
                  {powerPct !== null && (
                    <Bar pct={powerPct} color={powerPct >= 90 ? 'bg-red-500' : 'bg-yellow-500'} />
                  )}
                </>
              )}
            </div>
          );
        })() : (
          <Bar pct={0} color="bg-muted-foreground" />
        )}
      </div>
    </div>
  );
}

function DeviceCard({
  device,
  admin,
  actionLoading,
  onAction,
}: {
  device: Device;
  admin: boolean;
  actionLoading?: string;
  onAction: (code: string, action: 'start' | 'stop' | 'restart') => void;
}) {
  const state = liveState(device);
  const style = STATE_STYLE[state];
  const hb = device.heartbeat;
  const live = hb && !hb.stale && device.status === 'running';
  const applying = live && hb.config_version !== null && hb.config_version < device.configVersion;
  const isLoading = !!actionLoading;
  const href = admin ? `/detection/devices/${device.deviceCode}` : '/stream';

  return (
    <Card className={cn('flex flex-col', state === 'degraded' && 'border-amber-500/40', state === 'offline' && 'border-red-500/40')}>
      <Link href={href} className="hover:bg-muted/40 transition-colors rounded-t-lg">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium truncate">{device.deviceName}</p>
              <p className="text-xs text-muted-foreground font-mono">{device.deviceCode}</p>
            </div>
            <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium shrink-0', style.pill)}>
              <span className={cn('w-1.5 h-1.5 rounded-full', style.dot)} />
              {style.label}
            </span>
          </div>
        </CardHeader>
      </Link>

      <CardContent className="flex-1 space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <p className="text-[11px] text-muted-foreground flex items-center gap-1"><ArrowDownToLine className="w-3 h-3" />In today</p>
            <p className="text-xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">{live ? (hb.in_today ?? 0) : '—'}</p>
          </div>
          <div className="rounded-md bg-muted/50 px-3 py-2">
            <p className="text-[11px] text-muted-foreground flex items-center gap-1"><ArrowUpFromLine className="w-3 h-3" />Out today</p>
            <p className="text-xl font-semibold tabular-nums text-orange-600 dark:text-orange-400">{live ? (hb.out_today ?? 0) : '—'}</p>
          </div>
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
          <span className="flex items-center gap-1"><Gauge className="w-3.5 h-3.5" />{live && hb.fps !== null ? `${hb.fps.toFixed(1)} fps` : '— fps'}</span>
          <span className="flex items-center gap-1"><Users className="w-3.5 h-3.5" />{live && hb.persons !== null ? `${hb.persons.toFixed(1)} in view` : '—'}</span>
          <span title="Configuration version">
            {applying ? <span className="text-sky-600 dark:text-sky-400">applying v{device.configVersion}…</span> : `config v${device.configVersion}`}
          </span>
        </div>

        {state === 'offline' && (
          <p className="text-xs text-red-500 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            No status for {hb!.age_s} s — check the logs
          </p>
        )}
        {live && hb.last_error && (
          <p className="text-xs text-amber-600 dark:text-amber-400 line-clamp-2" title={hb.last_error}>
            <AlertCircle className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />{hb.last_error}
          </p>
        )}

        {admin && (
          <div className="flex gap-1.5 pt-1">
            {device.status !== 'running' ? (
              <Button size="sm" className="flex-1" onClick={() => onAction(device.deviceCode, 'start')} disabled={isLoading}>
                <Play className="w-3.5 h-3.5 mr-1.5" />
                {actionLoading === 'start' ? 'Starting...' : 'Start'}
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="flex-1" onClick={() => onAction(device.deviceCode, 'stop')} disabled={isLoading}>
                <Square className="w-3.5 h-3.5 mr-1.5" />
                {actionLoading === 'stop' ? 'Stopping...' : 'Stop'}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => onAction(device.deviceCode, 'restart')} disabled={isLoading} aria-label={`Restart ${device.deviceCode}`}>
              <RotateCcw className="w-3.5 h-3.5" />
            </Button>
            <Link href={`/detection/devices/${device.deviceCode}`}>
              <Button size="sm" variant="ghost">Edit</Button>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
