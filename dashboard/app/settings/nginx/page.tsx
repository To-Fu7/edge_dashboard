'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { RefreshCw, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatusBadge } from '@/components/StatusBadge';
import type { ContainerStatus } from '@/lib/types';

interface Forward {
  deviceCode: string;
  listenPort: string;
  srcIp: string;
  srcPort: string;
}

interface Overview {
  containerName: string;
  configPath: string;
  status: ContainerStatus;
  portRange: [number, number];
  forwards: Forward[];
  liveConf: string | null;
  expectedConf: string;
  inSync: boolean;
  logs: string[];
}

async function fetchOverview(): Promise<Overview> {
  const res = await fetch('/api/portforward');
  const d = await res.json();
  if (!res.ok) throw new Error(d.error || 'Request failed');
  return d;
}

export default function NginxSettingsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [showExpected, setShowExpected] = useState(false);

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
      .then(d => { if (!cancelled) setData(d); })
      .catch(e => toast.error(`Failed to load nginx status: ${String(e)}`))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function redeploy() {
    setDeploying(true);
    try {
      const res = await fetch('/api/portforward', { method: 'POST' });
      const d = await res.json();
      if (d.deployed) toast.success('Nginx config deployed and reloaded');
      else if (d.skipped) toast.warning(d.error || 'Forwarder container is not running');
      else toast.error(d.error || 'Deploy failed');
      await load();
    } finally {
      setDeploying(false);
    }
  }

  if (loading && !data) return <div className="p-6 text-muted-foreground">Loading...</div>;
  if (!data) return <div className="p-6 text-muted-foreground">Nginx status unavailable.</div>;

  const shownConf = showExpected || data.liveConf === null ? data.expectedConf : data.liveConf;

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Nginx</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Port-forward proxy for camera RTSP streams. The config is generated from each device&apos;s
            Stream tab; edit forwards there.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={redeploy} disabled={deploying || data.status !== 'running'}>
            <Upload className="w-4 h-4 mr-1.5" />
            {deploying ? 'Deploying...' : 'Redeploy config'}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span className="font-mono text-base">{data.containerName}</span>
            <StatusBadge status={data.status} />
            {data.liveConf !== null && (
              data.inSync
                ? <Badge variant="outline">Config in sync</Badge>
                : <Badge variant="destructive">Redeploy pending</Badge>
            )}
          </CardTitle>
          <CardDescription>
            Listen ports {data.portRange[0]}–{data.portRange[1]} · config at <span className="font-mono">{data.configPath}</span>
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
              No forwards configured. Enable one in a device&apos;s Stream tab.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-2 pr-4 font-medium">Device</th>
                    <th className="py-2 pr-4 font-medium">Host port</th>
                    <th className="py-2 font-medium">Forwards to</th>
                  </tr>
                </thead>
                <tbody>
                  {data.forwards.map(f => (
                    <tr key={f.deviceCode} className="border-b border-border last:border-0">
                      <td className="py-2 pr-4">
                        <Link href={`/devices/${f.deviceCode}`} className="text-primary hover:underline">{f.deviceCode}</Link>
                      </td>
                      <td className="py-2 pr-4 font-mono tabular-nums">{f.listenPort}</td>
                      <td className="py-2 font-mono">{f.srcIp}:{f.srcPort}</td>
                    </tr>
                  ))}
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
    </div>
  );
}
