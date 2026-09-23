'use client';

import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { ModelSelect } from '@/components/ModelSelect';
import { Play, Square, RefreshCw } from 'lucide-react';

interface TritonModel {
  name: string;
  state: string;
  kind?: 'detection' | 'embedding';
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function ModelTestPage() {
  const [videos, setVideos] = useState<string[]>([]);
  const [video, setVideo] = useState('');
  const [models, setModels] = useState<TritonModel[]>([]);
  const [model, setModel] = useState('');
  const [conf, setConf] = useState('0.3');
  const [resolution, setResolution] = useState('');
  const [crop, setCrop] = useState('');

  const [running, setRunning] = useState(false);
  const [log, setLog] = useState('');
  const [outputFile, setOutputFile] = useState<string | null>(null);
  const [videoKey, setVideoKey] = useState(0); // bump to force <video> to reload the new file
  const [streamKey, setStreamKey] = useState(0); // bump to retry the live <img> preview
  const [streamReady, setStreamReady] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function loadVideos() {
    fetch('/api/model-test/videos')
      .then(r => r.json())
      .then(d => { if (d.videos) setVideos(d.videos); })
      .catch(() => {});
  }

  useEffect(() => {
    loadVideos();
    fetch('/api/triton/models')
      .then(r => r.json())
      .then(d => { if (d.models) setModels(d.models); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!video && videos.length) setVideo(videos[0]);
  }, [videos]); // eslint-disable-line react-hooks/exhaustive-deps

  function append(chunk: string) {
    setLog(prev => prev + chunk);
    requestAnimationFrame(() => {
      if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
    });
  }

  function retryStream() {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = setTimeout(() => setStreamKey(k => k + 1), 1000);
  }

  async function run() {
    if (!video || !model || running) return;
    setRunning(true);
    setLog('');
    setOutputFile(null);
    setStreamReady(false);
    setStreamKey(k => k + 1); // fresh <img> load for this run, not a cached broken one
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch('/api/model-test/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          video, model,
          conf: Number(conf) || 0.3,
          resolution: resolution.trim() || undefined,
          crop: crop.trim() || undefined,
        }),
      });

      const outFile = res.headers.get('X-Output-File');

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
      if (res.ok && outFile) {
        setOutputFile(outFile);
        setVideoKey(k => k + 1);
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') append(`\n[error] ${e}\n`);
    } finally {
      setRunning(false);
      abortRef.current = null;
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  useEffect(() => () => { if (retryTimerRef.current) clearTimeout(retryTimerRef.current); }, []);

  const detectionModels = models.filter(m => m.kind !== 'embedding');

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-lg font-semibold">Model Test</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Run any Triton detection model against a saved video clip, using the exact same
          inference path (and optionally the same resize/crop preprocessing) as main.py —
          without live-camera noise (RTSP jitter, GPU contention from other cameras) muddying
          whether a low FPS or low detection rate is the model&apos;s fault.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Video" hint={videos.length === 0 ? 'Drop a .mp4/.avi/.mkv into python-counting/test-videos/' : undefined}>
            <div className="flex gap-2">
              <Select value={video} onValueChange={v => v && setVideo(v)}>
                <SelectTrigger><SelectValue placeholder={videos.length ? 'Select a video' : 'No videos found'} /></SelectTrigger>
                <SelectContent>
                  {videos.map(v => <SelectItem key={v} value={v}>{v}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={loadVideos} title="Refresh list">
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>
          </Field>

          <Field label="Model">
            <ModelSelect
              value={model}
              onChange={setModel}
              placeholder="yolo26m_640"
              models={detectionModels}
              kind="detection"
            />
          </Field>

          <Field label="Confidence (0.0–1.0)">
            <Input type="number" step="0.05" min="0" max="1" value={conf} onChange={e => setConf(e.target.value)} />
          </Field>

          <Field label="Resolution (optional)" hint="W,H — mirrors SCREEN_RESOLUTION, e.g. 800,600. Blank = native.">
            <Input placeholder="800,600" value={resolution} onChange={e => setResolution(e.target.value)} />
          </Field>

          <Field label="Crop (optional)" hint="x1,y1,x2,y2 — mirrors CROP_AREA, applied after resize.">
            <Input placeholder="38,11,770,440" value={crop} onChange={e => setCrop(e.target.value)} />
          </Field>
        </div>

        <div className="flex justify-end gap-2">
          {running ? (
            <Button variant="outline" onClick={stop}>
              <Square className="w-4 h-4 mr-2" /> Stop
            </Button>
          ) : (
            <Button onClick={run} disabled={!video || !model}>
              <Play className="w-4 h-4 mr-2" /> Run Test
            </Button>
          )}
        </div>
      </div>

      {running && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
            <p className="text-sm font-medium">Live Preview</p>
          </div>
          <div className="relative rounded-md bg-black overflow-hidden aspect-video">
            {/* eslint-disable-next-line @next/next/no-img-element -- multipart/x-mixed-replace stream, next/image can't handle this */}
            <img
              key={streamKey}
              src={`/api/model-test/stream?t=${streamKey}`}
              alt="Live annotated preview"
              className="w-full h-full object-contain"
              onLoad={() => setStreamReady(true)}
              onError={() => { setStreamReady(false); retryStream(); }}
            />
            {!streamReady && (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                connecting to preview…
              </div>
            )}
          </div>
        </div>
      )}

      {log && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <p className="text-sm font-medium">Live Stats</p>
          <pre
            ref={logRef}
            className="text-xs font-mono bg-black/90 text-gray-300 rounded p-3 max-h-80 overflow-auto whitespace-pre-wrap"
          >
            {log}
          </pre>
        </div>
      )}

      {outputFile && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-2">
          <p className="text-sm font-medium">Annotated Result</p>
          {/* key forces the element to reload src on a new run instead of caching the old file */}
          <video key={videoKey} controls className="w-full rounded-md bg-black" src={`/api/model-test/output/${outputFile}`} />
        </div>
      )}
    </div>
  );
}
