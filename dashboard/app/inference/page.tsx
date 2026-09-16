'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BuildLogPanel } from '@/components/BuildLogPanel';
import { LiveLogPanel } from '@/components/LiveLogPanel';

interface TritonStatusData {
  containerStatus: string;
  reachable: boolean;
  ready: boolean;
  models: { name: string; state?: string }[];
}

export default function InferencePage() {
  const [weightsList, setWeightsList] = useState<string[]>([]);
  const [weights, setWeights] = useState('');
  const [imgsz, setImgsz] = useState('640'); // raw text while editing — parsed only when submitted (see getBody below)
  const [forceRebuild, setForceRebuild] = useState(false);
  const [status, setStatus] = useState<TritonStatusData | null>(null);

  useEffect(() => {
    fetch('/api/triton/weights')
      .then(r => r.json())
      .then(d => { if (d.weights?.length) { setWeightsList(d.weights); setWeights(d.weights[0]); } })
      .catch(() => {});

    const poll = () => fetch('/api/triton/status').then(r => r.json()).then(setStatus).catch(() => {});
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  const ready = status?.ready === true;
  const readyModels = status?.models.filter(m => m.state === 'READY').length ?? 0;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-lg font-semibold">Build & Inference</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Run the Triton model pipeline and the camera image build from here — no terminal/SSH needed.
          Each step streams its log live below.
        </p>
      </div>

      <div className={`rounded-lg border p-3 flex items-center gap-3 ${ready ? 'border-border bg-card' : 'border-red-500/50 bg-red-500/10'}`}>
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${ready ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} />
        <p className="text-sm">
          Triton Inference Server{' '}
          <span className="text-muted-foreground">
            {status === null ? '— checking…' : ready ? `ready · ${readyModels} model${readyModels === 1 ? '' : 's'} loaded` : `container ${status.containerStatus}`}
          </span>
        </p>
      </div>

      <LiveLogPanel
        title="Triton Container Logs"
        description="Live docker logs -f for triton-inference-server — model load status, inference errors, engine warnings."
        endpoint="/api/triton/logs"
      />

      <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
        <li>Export ONNX from a .pt weight file (one-time per model, or whenever the weight changes)</li>
        <li>Build the TensorRT engine — must run on THIS device (engines aren&apos;t portable across GPUs)</li>
        <li>Build the camera image, then recreate camera containers from the Devices page to pick it up</li>
      </ol>

      <BuildLogPanel
        title="1. Export ONNX"
        description="Runs tools/Dockerfile.export + export_model.py, writing models/<name>_<imgsz>/1/model.onnx"
        endpoint="/api/triton/export-onnx"
        runLabel="Export"
        disabled={!weights}
        disabledReason="No .pt weight file found in python-counting/"
        getBody={() => ({ weights, imgsz: Number(imgsz) || 640 })}
      >
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Weights file</Label>
            <Select value={weights} onValueChange={v => v && setWeights(v)}>
              <SelectTrigger><SelectValue placeholder={weightsList.length ? 'Select weights' : 'No .pt files found'} /></SelectTrigger>
              <SelectContent>
                {weightsList.map(w => <SelectItem key={w} value={w}>{w}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Image size</Label>
            <Input
              type="number"
              value={imgsz}
              onChange={e => setImgsz(e.target.value)}
              onBlur={() => setImgsz(String(Number(imgsz) || 640))}
            />
          </div>
        </div>
      </BuildLogPanel>

      <BuildLogPanel
        title="2. Build TensorRT Engine"
        description="docker compose --profile build run --rm triton-model-builder (on this device's GPU)"
        endpoint="/api/triton/build-engines"
        runLabel="Build Engine"
        getBody={() => ({ force: forceRebuild })}
      >
        <div className="flex items-center gap-2">
          <Switch checked={forceRebuild} onCheckedChange={setForceRebuild} id="force-rebuild" />
          <Label htmlFor="force-rebuild" className="cursor-pointer">Force rebuild even if the engine is already up to date</Label>
        </div>
      </BuildLogPanel>

      <BuildLogPanel
        title="3. Build Camera Image"
        description="docker build -f dockerfile . — recreate camera containers afterwards from the Devices page"
        endpoint="/api/compose/build"
        runLabel="Build Image"
      />
    </div>
  );
}
