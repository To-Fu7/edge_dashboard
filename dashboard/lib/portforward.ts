// Manages raw TCP port-forwards for camera RTSP streams via a DEDICATED,
// dashboard-owned nginx container (`edge-portfwd-nginx`, defined in
// dashboard/docker-compose.yml) whose ENTIRE nginx.conf this module owns and
// regenerates from scratch whenever the forward list changes.
//
// Why a dedicated container (vs. editing some other stack's shared nginx):
//   * Isolation — this nginx does nothing but Layer-4 (ngx_stream_core_module)
//     TCP proxying, so a bad forward can only ever break port-forwarding, never
//     a web/admin/reverse-proxy stack that happens to share the box.
//   * Full control — its whole 5500-5600 host-port range is published up front
//     in compose, so the dashboard can pick any listen port in that range and
//     it's already reachable from the host with NO container recreate. (Docker
//     can't add published ports to a running container; pre-publishing the
//     range is what makes forwarding fully dashboard-managed.)
//   * The official nginx image is built --with-stream, so there's no module
//     preflight to do (unlike a random shared/rtmp build).
//
// Because we own the whole file, config generation is a plain full rewrite:
// no marker comments, no byte-for-byte preservation, no brace-depth parsing.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { query, queryOne } from './db';
import { readSettings } from './settings';

const execAsync = promisify(exec);

// Host-port range published by the edge-portfwd-nginx service in
// docker-compose.yml. A listen port MUST fall inside this range or the forward
// won't be reachable from the host. Keep these two in sync with the compose
// `ports:` mapping — shifting one without the other silently breaks forwards.
export const LISTEN_PORT_MIN = 5500;
export const LISTEN_PORT_MAX = 5600;

// Fixed identity of the dedicated forwarder container. These used to be
// user-editable in Settings, but that only created a footgun: a persisted
// EMPTY string in settings.json overrode the default and silently disabled the
// whole feature (readSettings merges { ...DEFAULT, ...parsed }, and "" is a
// present key that wins over the default). They're effectively constants now; a
// non-empty settings value still wins as an escape hatch, but empty falls back.
const DEFAULT_NGINX_CONTAINER = 'edge-portfwd-nginx';
const DEFAULT_NGINX_CONFIG_PATH = '/etc/nginx/nginx.conf';

// ---------------------------------------------------------------------------
// Forward registry — table port_forwards. A forward either belongs to a camera
// (device_id set; its target is pre-filled from that camera's RTSP URL and it is
// deleted together with the device) or points at any host:port typed by hand.
// ---------------------------------------------------------------------------

export interface PortForward {
  id: string;
  name: string;
  deviceCode: string | null;   // camera this forward belongs to (null = manual)
  srcIp: string;               // target host (camera / NVR IP)
  srcPort: string;             // target port, usually 554 for RTSP
  listenPort: string;          // host port in LISTEN_PORT_MIN..LISTEN_PORT_MAX
  enabled: boolean;
  createdAt: string;
}

export type PortForwardInput = Omit<PortForward, 'id' | 'createdAt'>;

const SELECT_FORWARDS = `
  SELECT f.id, f.name, d.code AS "deviceCode", f.src_ip AS "srcIp", f.src_port::text AS "srcPort",
         f.listen_port::text AS "listenPort", f.enabled, f.created_at AS "createdAt"
    FROM port_forwards f LEFT JOIN devices d ON d.id = f.device_id`;

export async function readForwards(): Promise<PortForward[]> {
  return query<PortForward>(`${SELECT_FORWARDS} ORDER BY f.listen_port`);
}

// Only enabled forwards end up in nginx.conf.
export async function collectPortForwards(): Promise<PortForward[]> {
  return query<PortForward>(`${SELECT_FORWARDS} WHERE f.enabled ORDER BY f.listen_port`);
}

// Target host/port of a camera's RTSP URL, used to pre-fill a forward when a
// camera is selected. rtsp://user:pass@10.11.0.48:554/Streaming/... → 10.11.0.48, 554
export function targetFromRtsp(rtspUrl: string | undefined): { srcIp: string; srcPort: string } | null {
  if (!rtspUrl) return null;
  try {
    const u = new URL(rtspUrl);
    if (!u.hostname) return null;
    return { srcIp: u.hostname, srcPort: u.port || '554' };
  } catch {
    return null;
  }
}

const HOST_RE = /^[A-Za-z0-9.-]+$/;

// Returns a human-readable problem with the forward, or null if it's valid.
// Port checks are against this registry (and the published range), NOT a live
// OS-level socket probe.
export async function validateForward(input: PortForwardInput, excludeId?: string): Promise<string | null> {
  if (!input.name?.trim()) return 'Name is required';
  if (!input.srcIp || !HOST_RE.test(input.srcIp)) return 'Target IP/host is invalid';
  const srcPort = Number(input.srcPort);
  if (!Number.isInteger(srcPort) || srcPort < 1 || srcPort > 65535) return 'Target port must be 1–65535';
  const n = Number(input.listenPort);
  if (!Number.isInteger(n) || n < LISTEN_PORT_MIN || n > LISTEN_PORT_MAX) {
    return `Listen port must be between ${LISTEN_PORT_MIN} and ${LISTEN_PORT_MAX} (the range published by the port-forward nginx container)`;
  }
  const clash = await queryOne<{ name: string }>(
    'SELECT name FROM port_forwards WHERE listen_port = $1 AND id <> COALESCE($2::uuid, \'00000000-0000-0000-0000-000000000000\')',
    [n, excludeId ?? null]);
  if (clash) return `Listen port ${n} is already used by "${clash.name}"`;
  if (input.deviceCode && !(await queryOne('SELECT 1 FROM devices WHERE code = $1', [input.deviceCode]))) {
    return `Camera "${input.deviceCode}" no longer exists`;
  }
  return null;
}

export async function suggestListenPort(): Promise<string | null> {
  const used = new Set((await query<{ p: number }>('SELECT listen_port AS p FROM port_forwards')).map(r => r.p));
  for (let p = LISTEN_PORT_MIN; p <= LISTEN_PORT_MAX; p++) {
    if (!used.has(p)) return String(p);
  }
  return null;
}

function params(input: PortForwardInput): unknown[] {
  return [input.name.trim(), input.deviceCode || null, input.srcIp.trim(), Number(input.srcPort), Number(input.listenPort), input.enabled !== false];
}

export async function createForward(input: PortForwardInput): Promise<PortForward> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO port_forwards (name, device_id, src_ip, src_port, listen_port, enabled)
     VALUES ($1, (SELECT id FROM devices WHERE code = $2), $3, $4, $5, $6) RETURNING id`, params(input));
  return (await queryOne<PortForward>(`${SELECT_FORWARDS} WHERE f.id = $1`, [row!.id]))!;
}

export async function updateForward(id: string, input: PortForwardInput): Promise<PortForward | null> {
  const row = await queryOne<{ id: string }>(
    `UPDATE port_forwards SET name = $1, device_id = (SELECT id FROM devices WHERE code = $2), src_ip = $3,
            src_port = $4, listen_port = $5, enabled = $6
      WHERE id = $7 RETURNING id`, [...params(input), id]);
  return row ? queryOne<PortForward>(`${SELECT_FORWARDS} WHERE f.id = $1`, [id]) : null;
}

export async function deleteForward(id: string): Promise<boolean> {
  return (await query('DELETE FROM port_forwards WHERE id = $1 RETURNING id', [id])).length > 0;
}

// Builds the COMPLETE nginx.conf for the dedicated forwarder — a stream-only
// config with one server{} per enabled forward. With zero forwards the stream{}
// block is empty, which is valid (nginx just listens on nothing).
export function buildNginxConf(forwards: PortForward[]): string {
  const servers = forwards
    .map(f => `    # ${f.name.replace(/[\r\n]/g, ' ')}${f.deviceCode ? ` (${f.deviceCode})` : ''}
    server {
        listen ${f.listenPort} so_keepalive=on;
        proxy_connect_timeout 2s;
        proxy_pass ${f.srcIp}:${f.srcPort};
        proxy_timeout 10m;
    }`)
    .join('\n');
  return `# ============================================================
# Managed ENTIRELY by the EPiWalk dashboard — do not edit by hand.
# Regenerated from scratch from the forward list in Settings → Nginx.
# Container: edge-portfwd-nginx (dashboard-owned, stream-only L4 TCP
# proxy for RTSP passthrough).
# ============================================================
worker_processes auto;

events {
    worker_connections 1024;
}

stream {
${servers}
}
`;
}

export interface DeployResult {
  deployed: boolean;
  // true when there was nothing to deploy against — the forwarder container
  // isn't running in this environment. Callers should treat this as benign,
  // NOT as a deploy failure to surface to the user.
  skipped?: boolean;
  error?: string;
}

// Regenerates the dedicated forwarder's whole nginx.conf from the current set
// of dashboard-managed forwards, validates the candidate with `nginx -t`
// BEFORE touching the live file, and only then swaps it in and reloads. An
// invalid candidate never reaches the real nginx.conf path.
export async function getForwarderTarget(): Promise<{ containerName: string; configPath: string }> {
  const settings = await readSettings().catch(() => null);
  return {
    containerName: settings?.portForward?.nginxContainerName || DEFAULT_NGINX_CONTAINER,
    configPath: settings?.portForward?.nginxConfigPath || DEFAULT_NGINX_CONFIG_PATH,
  };
}

// The config nginx is actually running with (read from inside the container),
// or null when the forwarder isn't reachable. Compared against
// buildNginxConf(collectPortForwards()) to show whether a redeploy is pending.
export async function readLiveNginxConf(): Promise<string | null> {
  const { containerName, configPath } = await getForwarderTarget();
  try {
    const { stdout } = await execAsync(`docker exec ${containerName} cat "${configPath}"`, { timeout: 10000 });
    return stdout;
  } catch {
    return null;
  }
}

export async function deployPortForwardConfig(): Promise<DeployResult> {
  const { containerName, configPath } = await getForwarderTarget();
  const candidatePath = `${configPath}.candidate`;

  const newConf = buildNginxConf(await collectPortForwards());

  const tmpFile = path.join(os.tmpdir(), `nginx-candidate-${Date.now()}.conf`);
  fs.writeFileSync(tmpFile, newConf, 'utf-8');

  try {
    // Stage the candidate at a NON-bind-mounted path (docker cp works there)
    // and validate it before it can ever affect the running config.
    await execAsync(`docker cp "${tmpFile}" ${containerName}:"${candidatePath}"`, { timeout: 10000 });

    try {
      await execAsync(`docker exec ${containerName} nginx -t -c "${candidatePath}"`, { timeout: 10000 });
    } catch (e) {
      await execAsync(`docker exec ${containerName} rm -f "${candidatePath}"`, { timeout: 5000 }).catch(() => {});
      return { deployed: false, error: `nginx -t validation failed, live config left untouched: ${errMessage(e)}` };
    }

    // configPath is the bind-mounted file (dashboard/nginx/portfwd-nginx.conf).
    // `cp`/`docker cp` unlink+recreate the destination inode, which fails on a
    // bind mount ("device or resource busy"). Writing via a shell redirect
    // truncates-in-place instead, which works on a bind mount the same way
    // `> file` always has — and persists to the host file across recreate.
    await execAsync(
      `docker exec -i ${containerName} sh -c 'cat > "${configPath}"' < "${tmpFile}"`,
      { timeout: 10000 }
    );
    await execAsync(`docker exec ${containerName} rm -f "${candidatePath}"`, { timeout: 5000 }).catch(() => {});
    await execAsync(`docker exec ${containerName} nginx -s reload`, { timeout: 10000 });
    return { deployed: true };
  } catch (e) {
    const msg = errMessage(e);
    // A stack that simply doesn't run the forwarder container shouldn't nag on
    // every save — treat "container missing" as benign (skipped), not an error.
    if (/No such container/i.test(msg)) {
      return { deployed: false, skipped: true, error: `port-forward nginx container "${containerName}" is not running` };
    }
    return { deployed: false, error: msg };
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

function errMessage(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return err.stderr || err.message || String(e);
}
