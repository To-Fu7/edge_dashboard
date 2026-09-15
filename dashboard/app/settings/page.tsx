'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { ModelSelect } from '@/components/ModelSelect';
import { TagSelect } from '@/components/TagSelect';
import { toast } from 'sonner';
import { Trash2, Plus, KeyRound, Loader2, User } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { GlobalSettings } from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/types';

interface UserRecord { id: string; username: string; createdAt: string; }

export default function SettingsPage() {
  const [settings, setSettings] = useState<GlobalSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tritonModels, setTritonModels] = useState<{ name: string; state: string }[]>([]);

  // Users
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [userDialog, setUserDialog] = useState<null | 'add' | { id: string; username: string }>(null);
  const [userForm, setUserForm] = useState({ username: '', password: '', confirm: '' });
  const [userSaving, setUserSaving] = useState(false);

  function loadUsers() {
    fetch('/api/auth/users').then(r => r.json()).then(d => { if (Array.isArray(d)) setUsers(d); }).catch(() => {});
  }

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
    fetch('/api/auth/me').then(r => r.json()).then(d => { if (d.userId) setCurrentUserId(d.userId); }).catch(() => {});
    loadUsers();
  }, []);

  function setPg(key: keyof GlobalSettings['pg'], value: string) {
    setSettings(prev => ({ ...prev, pg: { ...prev.pg, [key]: value } }));
  }
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
  function setPortForward(key: keyof GlobalSettings['portForward'], value: string) {
    setSettings(prev => ({ ...prev, portForward: { ...prev.portForward, [key]: value } }));
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
      toast.success('Settings saved. New cameras will use these defaults.');
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
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Global defaults applied when creating new cameras. Existing cameras are not affected.
        </p>
      </div>

      <Section title="Dashboard">
        <FormField label="Dashboard Name">
          <Input
            value={settings.appName}
            onChange={e => setSettings(prev => ({ ...prev, appName: e.target.value }))}
            placeholder="EPiWalk"
          />
        </FormField>
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
              placeholder="yolo26m_640"
              models={tritonModels}
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
            />
            <p className="text-xs text-muted-foreground">
              Used to embed photos on the Face Enrollment page — must match cameras&apos; FACE_EMBED_MODEL,
              since enrollment and runtime embeddings must live in the same vector space to compare.
            </p>
          </FormField>
        </div>
      </Section>

      <Section title="Stream Gateway (MSE/HLS/WebRTC)">
        <FormField label="Public Base URL">
          <Input
            value={settings.streamGateway.publicBaseUrl}
            onChange={e => setStreamGateway('publicBaseUrl', e.target.value)}
            placeholder="http://10.11.0.73:8555"
          />
          <p className="text-xs text-muted-foreground">
            LAN-reachable address of the stream-gateway service, used to build the HLS/MSE/WebRTC
            URLs shown on each device&apos;s Stream tab. Browsers on the LAN can&apos;t resolve
            Docker container names, so this must be a real IP/hostname — set once per deployment.
          </p>
        </FormField>
      </Section>

      <Section title="Port Forward (nginx)">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="nginx Container Name">
            <Input
              value={settings.portForward.nginxContainerName}
              onChange={e => setPortForward('nginxContainerName', e.target.value)}
              placeholder="env_services_nginx"
            />
          </FormField>
          <FormField label="nginx.conf Path (inside container)">
            <Input
              value={settings.portForward.nginxConfigPath}
              onChange={e => setPortForward('nginxConfigPath', e.target.value)}
              placeholder="/etc/nginx/nginx.conf"
            />
          </FormField>
        </div>
        <p className="text-xs text-muted-foreground">
          Name and internal config path of the EXISTING nginx Docker container to manage port
          forwards in — this dashboard never creates or replaces that container, only regenerates
          the stream{'{}'} block in that one file (existing hand-written forwards in it are
          preserved). Leave the container name empty to disable the Port Forward feature on device
          pages.
        </p>
      </Section>

      <Section title="PostgreSQL Database">
        <div className="grid grid-cols-2 gap-4">
          <FormField label="Host">
            <Input value={settings.pg.host} onChange={e => setPg('host', e.target.value)} placeholder="host.docker.internal" />
          </FormField>
          <FormField label="Port">
            <Input type="number" value={settings.pg.port} onChange={e => setPg('port', e.target.value)} placeholder="5432" />
          </FormField>
          <FormField label="Database">
            <Input value={settings.pg.db} onChange={e => setPg('db', e.target.value)} placeholder="postgres" />
          </FormField>
          <FormField label="User">
            <Input value={settings.pg.user} onChange={e => setPg('user', e.target.value)} placeholder="postgres" />
          </FormField>
          <FormField label="Password" className="col-span-2">
            <Input type="password" value={settings.pg.pass} onChange={e => setPg('pass', e.target.value)} />
          </FormField>
        </div>
      </Section>

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
          <FormField label="Debug Mode">
            <div className="flex items-center gap-2 pt-2">
              <Switch
                checked={settings.defaults.debug_mode === 'true'}
                onCheckedChange={v => setDefault('debug_mode', v ? 'true' : 'false')}
              />
              <span className="text-sm text-muted-foreground">
                {settings.defaults.debug_mode === 'true' ? 'ON (display enabled, no MQTT/DB)' : 'OFF (production mode)'}
              </span>
            </div>
          </FormField>
        </div>
      </Section>

      <Section title="Additional Detection Defaults">
        <p className="text-xs text-muted-foreground -mt-2">
          Applied when a new camera is created. APD and Fire/Smoke are disabled
          by default — enable them per camera once a model is selected.
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

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>

      {/* Users */}
      <Section title="Users">
        <div className="space-y-2">
          {users.map(u => (
            <div key={u.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-muted/30">
              <User className="w-4 h-4 text-muted-foreground shrink-0" />
              <span className="flex-1 text-sm font-medium">{u.username}</span>
              <span className="text-xs text-muted-foreground">
                {new Date(u.createdAt).toLocaleDateString()}
              </span>
              <button
                onClick={() => { setUserDialog({ id: u.id, username: u.username }); setUserForm({ username: '', password: '', confirm: '' }); }}
                title="Change password"
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
              >
                <KeyRound className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={async () => {
                  if (!confirm(`Delete user "${u.username}"?`)) return;
                  const res = await fetch(`/api/auth/users/${u.id}`, { method: 'DELETE' });
                  const d = await res.json();
                  if (!res.ok) { toast.error(d.error); return; }
                  toast.success('User deleted');
                  loadUsers();
                }}
                disabled={u.id === currentUserId}
                title={u.id === currentUserId ? "Can't delete yourself" : 'Delete user'}
                className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30 disabled:pointer-events-none"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}

          <Button
            variant="outline"
            size="sm"
            onClick={() => { setUserDialog('add'); setUserForm({ username: '', password: '', confirm: '' }); }}
            className="w-full"
          >
            <Plus className="w-4 h-4 mr-1.5" />
            Add user
          </Button>
        </div>
      </Section>

      {/* Add / change-password dialog */}
      <Dialog open={userDialog !== null} onOpenChange={open => { if (!open) setUserDialog(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {userDialog === 'add' ? 'Add User' : `Change password — ${userDialog !== null && typeof userDialog === 'object' ? userDialog.username : ''}`}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {userDialog === 'add' && (
              <div className="space-y-1.5">
                <Label>Username</Label>
                <Input
                  value={userForm.username}
                  onChange={e => setUserForm(p => ({ ...p, username: e.target.value }))}
                  autoFocus
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>New password</Label>
              <Input
                type="password"
                value={userForm.password}
                onChange={e => setUserForm(p => ({ ...p, password: e.target.value }))}
                autoFocus={userDialog !== 'add'}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Confirm password</Label>
              <Input
                type="password"
                value={userForm.confirm}
                onChange={e => setUserForm(p => ({ ...p, confirm: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUserDialog(null)}>Cancel</Button>
            <Button
              disabled={userSaving || !userForm.password || userForm.password !== userForm.confirm || (userDialog === 'add' && !userForm.username)}
              onClick={async () => {
                setUserSaving(true);
                try {
                  let res: Response;
                  if (userDialog === 'add') {
                    res = await fetch('/api/auth/users', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ username: userForm.username, password: userForm.password }),
                    });
                  } else {
                    res = await fetch(`/api/auth/users/${(userDialog as { id: string }).id}`, {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ password: userForm.password }),
                    });
                  }
                  const d = await res.json();
                  if (!res.ok) { toast.error(d.error); return; }
                  toast.success(userDialog === 'add' ? 'User added' : 'Password changed');
                  setUserDialog(null);
                  loadUsers();
                } finally {
                  setUserSaving(false);
                }
              }}
            >
              {userSaving && <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />}
              {userDialog === 'add' ? 'Add' : 'Change'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
