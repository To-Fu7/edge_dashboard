// How a device's environment is built. Pure functions — no I/O — so the same
// rules run on create, save, global-settings change and rollback.
//
//   effective_env = DEVICE_DEFAULTS  (per-device fallbacks, e.g. 800x600)
//                 + globalEnv()      (values coming from Settings, inherited)
//                 + derived topics   (per-type MQTT topics under MQTT_TOPIC)
//                 + overrides        (what this device changed)
//                 + identity         (DEVICE_ID / CODE / NAME, always system-owned)
//
// A device stores only `overrides`. When the device form is saved, diffOverrides
// keeps just the keys whose value differs from what the device would inherit,
// so a later change in Settings flows to every device that didn't override it.
import type { DeviceEnvConfig, GlobalSettings } from './types';

export type Env = Record<string, string>;

export interface DeviceIdentity {
  id: string;
  code: string;
  name: string;
}

/** Fallbacks for per-device keys that have no global counterpart. */
export const DEVICE_DEFAULTS: Env = {
  RTSP_URL: '',
  SCREEN_RESOLUTION: '[800, 600]',
  CROP_AREA: '',
  ANNOTATED_STREAM: 'false',
  STREAM_PORT: '8090',
  STREAM_GATEWAY_ALWAYS_ON: 'false',
  STREAM_GATEWAY_AUDIO: 'false',
  SUBSTREAM_URL: '',
  YOLO_IOU: '0.3',
  APD_ENABLED: 'false',
  APD_MODEL: '',
  APD_VIOLATION_CLASSES: '',
  FIRE_SMOKE_ENABLED: 'false',
  FIRE_SMOKE_MODEL: '',
  FACE_ENABLED: 'false',
  FACE_MODEL: '',
  FACE_CROP_MARGIN: '0.25',
  FACE_CROP_MIN_SIZE: '112',
  FACE_MIN_SIZE: '40',
  FACE_MAX_SIZE: '0',
  INTRUSION_ENABLED: 'false',
  INTRUSION_DETECTION_MODE: 'zone',
  INTRUSION_TAG: 'alarm',
  DETECTION_MODE: 'line_crossing',
  POINT_AXIS: 'Y',
  MERGE_GATES: 'false',
  SWAP_IN_OUT: 'false',
  DETECTION_STYLE: 'dot',
  DOT_OFFSET: 'Y',
  DOT_OFFSET_AMOUNT: '0',
  LINE_OFFSET: 'Y',
  LINE_OFFSET_AMOUNT: '5',
};

/** Keys owned by the system: never stored as overrides, always recomputed. */
export const IDENTITY_KEYS = ['DEVICE_ID', 'DEVICE_CODE', 'DEVICE_NAME'] as const;

/** Keys a device must not carry any more: connection details come from the
 *  container env (EDGE_DB_*, TRITON_URL), debug paths move to a separate tool,
 *  port forwards live in their own table, and the pre-Triton names are dead. */
const DROPPED_KEY = /^(PG_(HOST|PORT|DB|USER|PASS)|DEBUG_MODE|FALLBACK_VIDEO|PORTFWD_.*|EDGE_.*|TRITON_URL|YOLO_MODEL|YOLO_IMGSZ|YOLO_DEVICE|ENABLE_NVDEC)$/;

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fillCode(template: string, code: string): string {
  return template.replace(/\{code\}/g, code);
}

/** Values every device inherits from Settings unless it overrides them. */
export function globalEnv(s: GlobalSettings, code: string): Env {
  const d = s.defaults;
  return {
    MQTT_BROKER: s.mqtt.broker,
    MQTT_PORT: s.mqtt.port,
    MQTT_USERNAME: s.mqtt.username,
    MQTT_PASSWORD: s.mqtt.password,
    MQTT_TOPIC: fillCode(s.mqtt.activityTopicTemplate, code),
    MQTT_INTERVAL_TOPIC: fillCode(s.mqtt.intervalTopicTemplate, code),
    MQTT_INTERVAL_MINUTES: d.mqtt_interval_minutes,
    DAILY_SEND_TIME: d.daily_send_time,
    TRITON_MODEL: s.triton.defaultModel,
    FACE_EMBED_MODEL: s.triton.faceEmbedModel,
    YOLO_CONFIDENCE: d.yolo_confidence,
    JPEG_QUALITY: d.jpeg_quality,
    FPS_LIMIT: d.fps_limit,
    FRAME_SKIP: d.frame_skip,
    PEOPLE_COUNTING_TAG: d.people_counting_tag,
    APD_CONFIDENCE: d.apd_confidence,
    APD_TAG: d.apd_tag,
    FIRE_SMOKE_CONFIDENCE: d.fire_smoke_confidence,
    FIRE_TAG: d.fire_tag,
    SMOKE_TAG: d.smoke_tag,
    FIRE_SMOKE_COOLDOWN_MINUTES: d.fire_smoke_cooldown_minutes,
    FACE_CONFIDENCE: d.face_confidence,
    FACE_MATCH_THRESHOLD: d.face_match_threshold,
    INSIDER_TAG: d.insider_tag,
    INTRUDER_TAG: d.intruder_tag,
    FACE_CACHE_REFRESH_MINUTES: d.face_cache_refresh_minutes,
    FACE_CAPTURE_FRAMES: d.face_capture_frames,
  };
}

/** Keys that come from Settings — the device page shows these as "global". */
export const GLOBAL_KEYS: readonly string[] = Object.keys(globalEnv(
  { mqtt: { activityTopicTemplate: '', intervalTopicTemplate: '' }, triton: {}, defaults: {} } as unknown as GlobalSettings, '',
));

const TOPIC_SUFFIXES: Record<string, string> = {
  MQTT_APD_TOPIC: 'apd',
  MQTT_FIRESMOKE_TOPIC: 'firesmoke',
  MQTT_FACE_TOPIC: 'face',
  MQTT_INTRUSION_TOPIC: 'intrusion',
};

/** What the device inherits before its own overrides. */
export function baseEnv(s: GlobalSettings, code: string, mqttTopic?: string): Env {
  const env: Env = { ...DEVICE_DEFAULTS, ...globalEnv(s, code) };
  const topic = mqttTopic ?? env.MQTT_TOPIC;
  for (const [key, suffix] of Object.entries(TOPIC_SUFFIXES)) {
    env[key] = topic ? `${topic.replace(/\/+$/, '')}/${suffix}` : '';
  }
  return env;
}

/** Keep only well-formed, string-valued keys that a device is allowed to own. */
export function sanitizeOverrides(input: Record<string, unknown>): Env {
  const out: Env = {};
  for (const [k, v] of Object.entries(input)) {
    if (!KEY_RE.test(k) || DROPPED_KEY.test(k) || (IDENTITY_KEYS as readonly string[]).includes(k)) continue;
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

export function computeEffective(dev: DeviceIdentity, overrides: Env, s: GlobalSettings): Env {
  const own = sanitizeOverrides(overrides);
  // Per-type topics follow the device's MQTT_TOPIC, including an overridden one.
  const base = baseEnv(s, dev.code, own.MQTT_TOPIC);
  const env: Env = { ...base, ...own };
  // Empty strings mean "cleared" (e.g. a removed line) — drop them so Python
  // sees the key as absent, which is how its getenv defaults work.
  for (const k of Object.keys(env)) if (env[k] === '' && !(k in base && base[k] !== '')) delete env[k];
  env.DEVICE_ID = dev.id;
  env.DEVICE_CODE = dev.code;
  env.DEVICE_NAME = dev.name;
  return env;
}

/**
 * Turn a submitted device form (the full env the page loaded and edited) into
 * overrides: keys equal to the inherited value are dropped, so they keep
 * following Settings. A key cleared to '' that the base has a value for is kept
 * as '' (an explicit "clear").
 *
 * `previous`: a value the user didn't touch (same as before) that was inherited
 * before stays inherited — even if what it inherits from just changed, e.g. a
 * renamed code changes MQTT_TOPIC, or a new MQTT_TOPIC changes the per-type
 * topics derived from it. Without this those stale values would freeze as overrides.
 */
export function diffOverrides(
  submitted: Partial<DeviceEnvConfig> | Env, code: string, s: GlobalSettings,
  previous?: { overrides: Env; effective: Env },
): Env {
  const clean = sanitizeOverrides(submitted as Record<string, unknown>);
  const wasInherited = (k: string, v: string) =>
    previous !== undefined && !(k in previous.overrides) && previous.effective[k] === v;
  const topic = clean.MQTT_TOPIC;
  const topicInherited = topic === undefined || topic === globalEnv(s, code).MQTT_TOPIC || wasInherited('MQTT_TOPIC', topic);
  const base = baseEnv(s, code, topicInherited ? undefined : topic);
  const out: Env = {};
  for (const [k, v] of Object.entries(clean)) {
    if (wasInherited(k, v)) continue;
    const inherited = base[k];
    if (inherited === undefined) {
      if (v !== '') out[k] = v;            // device-only key (lines, zones, ...)
    } else if (v !== inherited) {
      out[k] = v;                          // differs from what it would inherit
    }
  }
  return out;
}

/** Same keys and values, ignoring order (JSONB doesn't preserve key order). */
export function sameEnv(a: Env, b: Env): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every(k => b[k] === a[k]);
}

/** Container name for a device code: device-<code>, lowercase, '_' → '-'. */
export function containerNameFor(code: string): string {
  return `device-${code.toLowerCase().replace(/_/g, '-')}`;
}

export const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
