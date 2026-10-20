'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ModelSelect } from '@/components/ModelSelect';
import { TagSelect } from '@/components/TagSelect';
import { toast } from 'sonner';
import type { GlobalSettings } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/types';
import { useDetectionView } from '@/lib/view-mode';

export default function SettingsPage() {
  const { isDetection } = useDetectionView();
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tritonModels, setTritonModels] = useState<{ name: string; state: string; kind?: 'detection' | 'embedding' }[]>([]);

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => { if (d.settings) setSettings(d.settings); })
      .catch(() => toast.error('Failed to load settings'))
      .finally(() => setLoading(false));
    fetch('/api/triton/models')
      .then(r => r.json())
      .then(d => { if (d.models) setTritonModels(d.models); })
      .catch(() => { /* Triton model list unavailable — keep free-text fallback */ });
  }, []);

  function setMqtt(key: keyof GlobalSettings['mqtt'], value: string) {
    setSettings(prev => ({ ...prev, mqtt: { ...prev.mqtt, [key]: value } }));
  }
  function setDefault(key: keyof GlobalSettings['defaults'], value: string) {
    setSettings(prev => ({ ...prev, defaults: { ...prev.defaults, [key]: value } }));
  }
  function setTriton(key: keyof GlobalSettings['triton'], value: string) {
    setSettings(prev => ({ ...prev, triton: { ...prev.triton, [key]: value } }));
  }
  function setStreamGateway(key: keyof GlobalSettings['streamGateway'], value: string) {
    setSettings(prev => ({ ...prev, streamGateway: { ...prev.streamGateway, [key]: value } }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.engineRebuildRecommended) {
        toast.warning('Hardware mode / Triton image changed — rebuild TensorRT engines and restart Triton from the dashboard.');
      }
      const n = (data.devicesUpdated ?? []).length;
      toast.success(n ? `Settings saved and applied to ${n} camera${n > 1 ? 's' : ''}.` : 'Settings saved.');
    } catch (e) {
      toast.error(`Failed to save: ${e}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  return (
    <div className="p-6 space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-semibold">{isDetection ? 'Detection Settings' : 'Settings'}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {isDetection
            ? 'Inference server, database, MQTT and detection defaults applied when creating new cameras. Existing cameras are not affected.'
            : 'Dashboard name and live-stream settings. Detection pipeline settings live under Detection → Settings.'}
        </p>
      </div>

      {!isDetection && (
      <Section title="Dashboard">
        <FormField label="Dashboard Name">
          <Input
            value={settings.appName}
            onChange={e => setSettings(prev => ({ ...prev, appName: e.target.value }))}
            placeholder="Edge"
          />
        </FormField>
      </Section>
      )}

      {isDetection && (
      <Section title="Hardware Mode">
        <FormField label="Hardware Mode">
          <div className="flex gap-3 pt-1">
            {(['jetson', 'server', 'cpu'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                onClick={() => setSettings(prev => ({ ...prev, hardwareMode: mode }))}
                className={`px-4 py-2 rounded-md text-sm border transition-colors ${
                  settings.hardwareMode === mode
                    ? 'border-primary bg-primary/10 text-primary font-medium'
                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                }`}
              >
                {mode === 'jetson' ? 'Jetson / Tegra' : mode === 'server' ? 'Mini Server (runtime: nvidia)' : 'CPU Only'}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">
            Changing this updates the Docker Compose template for all existing and new cameras,
            including the Triton Inference Server service (jetson uses the -igpu image; cpu uses onnxruntime).
          </p>
        </FormField>
      </Section>
      )}

      {isDetection && (
      <Section title="Triton Inference Server">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Triton Image Tag">
            <Input
              value={settings.triton.imageTag}
              onChange={e => setTriton('imageTag', e.target.value)}
              placeholder="24.08"
            />
            <p className="text-xs text-muted-foreground">
              tritonserver release (e.g. 24.08). On Jetson this must match the device&apos;s JetPack — see models/README.md.
            </p>
          </FormField>
          <FormField label="Default Model">
            <ModelSelect
              value={settings.triton.defaultModel}
              onChange={v => setTriton('defaultModel', v)}
              placeholder="yolo26s_640_e2e_u8"
              models={tritonModels}
              kind="detection"
            />
            <p className="text-xs text-muted-foreground">
              Model repository name assigned to newly created cameras.
            </p>
          </FormField>
          <FormField label="Face Embedding Model (ArcFace)">
            <ModelSelect
              value={settings.triton.faceEmbedModel}
              onChange={v => setTriton('faceEmbedModel', v)}
              placeholder="arcface_112"
              models={tritonModels}
              kind="embedding"
            />
            <p className="text-xs text-muted-foreground">
              Used to embed photos on the Face Enrollment page — must match cameras&apos; FACE_EMBED_MODEL,
              since enrollment and runtime embeddings must live in the same vector space to compare.
            </p>
          </FormField>
        </div>
      </Section>
      )}

      {!isDetection && (
      <Section title="Stream Gateway (MSE/HLS/WebRTC)">
        <FormField label="Public Base URL (optional)">
          <Input
            value={settings.streamGateway.publicBaseUrl}
            onChange={e => setStreamGateway('publicBaseUrl', e.target.value)}
            placeholder="Leave empty — auto-detected from your browser"
          />
          <p className="text-xs text-muted-foreground">
            Leave <span className="font-medium">empty</span> in almost every case: the browser
            derives the stream host from the address it already reached this dashboard on, so no
            setup is needed. Only set this (e.g.{' '}
            <span className="font-mono">http://10.11.0.73:8555</span>) if stream-gateway is NOT
            reachable at this dashboard&apos;s own host — behind a different hostname or a reverse
            proxy. Only the host and port are used; it applies on the next page load, with no
            container restart.
          </p>
        </FormField>
      </Section>
      )}

      {isDetection && (
      <Section title="Database">
        <p className="text-sm text-muted-foreground">
          Cameras, settings and results are stored in the PostgreSQL database <span className="font-mono">edge</span>.
          The connection is configured in <span className="font-mono">dashboard/.env</span> (EDGE_DB_*) by setup/install.sh,
          not here.
        </p>
      </Section>
      )}

      {isDetection && (
      <Section title="MQTT Broker">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Broker Host">
            <Input value={settings.mqtt.broker} onChange={e => setMqtt('broker', e.target.value)} placeholder="10.11.0.34" />
          </FormField>
          <FormField label="Port">
            <Input type="number" value={settings.mqtt.port} onChange={e => setMqtt('port', e.target.value)} placeholder="1883" />
          </FormField>
          <FormField label="Username">
            <Input value={settings.mqtt.username} onChange={e => setMqtt('username', e.target.value)} />
          </FormField>
          <FormField label="Password">
            <Input type="password" value={settings.mqtt.password} onChange={e => setMqtt('password', e.target.value)} />
          </FormField>
          <FormField label="Default Activity Topic Template">
            <Input
              value={settings.mqtt.activityTopicTemplate}
              onChange={e => setMqtt('activityTopicTemplate', e.target.value)}
              placeholder="/person_in/{code}"
            />
          </FormField>
          <FormField label="Default Interval Topic Template">
            <Input
              value={settings.mqtt.intervalTopicTemplate}
              onChange={e => setMqtt('intervalTopicTemplate', e.target.value)}
              placeholder="/resampling_person/{code}"
            />
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">
          <code className="font-mono bg-muted px-1 rounded">{'{code}'}</code> is replaced with the device code when a new camera is created. Existing cameras are not affected — edit their topics individually on the device page.
        </p>
      </Section>
      )}

      {isDetection && (
      <Section title="Detection Defaults">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="YOLO Confidence">
            <Input type="number" step="0.05" min="0" max="1" value={settings.defaults.yolo_confidence} onChange={e => setDefault('yolo_confidence', e.target.value)} />
          </FormField>
          <FormField label="JPEG Quality (1–100)">
            <Input type="number" min="1" max="100" value={settings.defaults.jpeg_quality} onChange={e => setDefault('jpeg_quality', e.target.value)} />
          </FormField>
          <FormField label="FPS Limit (0 = unlimited)">
            <Input type="number" value={settings.defaults.fps_limit} onChange={e => setDefault('fps_limit', e.target.value)} />
          </FormField>
          <FormField label="Frame Skip">
            <Input type="number" value={settings.defaults.frame_skip} onChange={e => setDefault('frame_skip', e.target.value)} />
          </FormField>
          <FormField label="MQTT Interval (minutes)">
            <Input type="number" value={settings.defaults.mqtt_interval_minutes} onChange={e => setDefault('mqtt_interval_minutes', e.target.value)} />
          </FormField>
          <FormField label="Daily Send Time">
            <Input value={settings.defaults.daily_send_time} onChange={e => setDefault('daily_send_time', e.target.value)} placeholder="23:59" />
          </FormField>
        </div>
      </Section>
      )}

      {isDetection && (
      <Section title="Additional Detection Defaults">
        <p className="text-xs text-muted-foreground -mt-2">
          Every camera inherits these unless it overrides the value on its own page.
          Changes apply to running cameras within seconds. APD and Fire/Smoke stay
          disabled until enabled per camera.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <FormField label="People Counting Tag">
            <TagSelect value={settings.defaults.people_counting_tag} onChange={v => setDefault('people_counting_tag', v)} />
          </FormField>
          <FormField label="APD Confidence">
            <Input type="number" step="0.05" min="0" max="1" value={settings.defaults.apd_confidence} onChange={e => setDefault('apd_confidence', e.target.value)} />
          </FormField>
          <FormField label="APD Tag">
            <TagSelect value={settings.defaults.apd_tag} onChange={v => setDefault('apd_tag', v)} />
          </FormField>
          <FormField label="Fire/Smoke Confidence">
            <Input type="number" step="0.05" min="0" max="1" value={settings.defaults.fire_smoke_confidence} onChange={e => setDefault('fire_smoke_confidence', e.target.value)} />
          </FormField>
          <FormField label="Fire Tag">
            <TagSelect value={settings.defaults.fire_tag} onChange={v => setDefault('fire_tag', v)} />
          </FormField>
          <FormField label="Smoke Tag">
            <TagSelect value={settings.defaults.smoke_tag} onChange={v => setDefault('smoke_tag', v)} />
          </FormField>
          <FormField label="Fire/Smoke Cooldown (minutes)">
            <Input type="number" min="1" value={settings.defaults.fire_smoke_cooldown_minutes} onChange={e => setDefault('fire_smoke_cooldown_minutes', e.target.value)} />
          </FormField>
          <FormField label="Face Confidence">
            <Input type="number" step="0.05" min="0" max="1" value={settings.defaults.face_confidence} onChange={e => setDefault('face_confidence', e.target.value)} />
          </FormField>
          <FormField label="Face Match Threshold">
            <Input type="number" step="0.05" min="0" max="1" value={settings.defaults.face_match_threshold} onChange={e => setDefault('face_match_threshold', e.target.value)} />
          </FormField>
          <FormField label="Insider Tag">
            <TagSelect value={settings.defaults.insider_tag} onChange={v => setDefault('insider_tag', v)} />
          </FormField>
          <FormField label="Intruder Tag">
            <TagSelect value={settings.defaults.intruder_tag} onChange={v => setDefault('intruder_tag', v)} />
          </FormField>
          <FormField label="Face Cache Refresh (minutes)">
            <Input type="number" min="1" value={settings.defaults.face_cache_refresh_minutes} onChange={e => setDefault('face_cache_refresh_minutes', e.target.value)} />
          </FormField>
          <FormField label="Face Best-Shot Capture Frames">
            <Input type="number" min="1" value={settings.defaults.face_capture_frames} onChange={e => setDefault('face_capture_frames', e.target.value)} />
          </FormField>
        </div>
      </Section>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <div className="border-b border-border pb-2">
        <h2 className="font-medium text-sm">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function FormField({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`space-y-1.5 ${className || ''}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
