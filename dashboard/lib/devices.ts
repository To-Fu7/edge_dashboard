// Device records in PostgreSQL: CRUD, config history/rollback, propagation of
// global settings, export/import. Container lifecycle is in device-runtime.ts.
//
// Every change that alters a device's effective env bumps config_version and
// sends NOTIFY edge_config '<id>:<version>', which the camera container listens
// for (python-counting/config_watch.py) to apply it without anyone restarting it.
import type { PoolClient } from 'pg';
import { query, queryOne, withTransaction } from './db';
import { readSettings } from './settings';
import { computeEffective, diffOverrides, sameEnv, sanitizeOverrides, DEVICE_CODE_RE, type Env } from './device-config';
import type { GlobalSettings } from './types';

export interface DeviceRow {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  overrides: Env;
  effective_env: Env;
  config_version: number;
  created_at: string;
  updated_at: string;
}

export interface DeviceStatusRow {
  state: string;
  fps: number | null;
  persons: number | null;
  in_today: number | null;
  out_today: number | null;
  config_version: number | null;
  triton_ok: boolean | null;
  last_error: string | null;
  details: Record<string, unknown>;
  started_at: string | null;
  updated_at: string;
}

export class DeviceError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLS = 'id, code, name, enabled, overrides, effective_env, config_version, created_at, updated_at';

export async function listDevices(): Promise<(DeviceRow & { status: DeviceStatusRow | null })[]> {
  const rows = await query<DeviceRow & { status: DeviceStatusRow | null }>(
    `SELECT d.id, d.code, d.name, d.enabled, d.overrides, d.effective_env, d.config_version, d.created_at, d.updated_at,
            to_jsonb(s) - 'device_id' AS status
       FROM devices d LEFT JOIN device_status s ON s.device_id = d.id
      ORDER BY d.name, d.code`,
  );
  return rows;
}

/** Look up by UUID or by code (URLs use the code, which can change). */
export async function getDevice(idOrCode: string): Promise<DeviceRow | null> {
  return UUID_RE.test(idOrCode)
    ? queryOne<DeviceRow>(`SELECT ${COLS} FROM devices WHERE id = $1`, [idOrCode])
    : queryOne<DeviceRow>(`SELECT ${COLS} FROM devices WHERE code = $1`, [idOrCode]);
}

export async function requireDevice(idOrCode: string): Promise<DeviceRow> {
  const d = await getDevice(idOrCode);
  if (!d) throw new DeviceError(`Device "${idOrCode}" not found`, 404);
  return d;
}

export async function getDeviceStatus(id: string): Promise<DeviceStatusRow | null> {
  return queryOne<DeviceStatusRow>(`SELECT ${'state, fps, persons, in_today, out_today, config_version, triton_ok, last_error, details, started_at, updated_at'} FROM device_status WHERE device_id = $1`, [id]);
}

function validateCode(code: string): void {
  if (!DEVICE_CODE_RE.test(code)) {
    throw new DeviceError('Code may only contain letters, digits, "_" and "-" (max 64 characters)');
  }
}

async function notify(client: PoolClient, id: string, version: number): Promise<void> {
  await client.query('SELECT pg_notify($1, $2)', ['edge_config', `${id}:${version}`]);
}

async function recordHistory(
  client: PoolClient, d: Pick<DeviceRow, 'id' | 'code' | 'name' | 'overrides' | 'config_version'>,
  reason: string, userId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO device_config_history (device_id, config_version, code, name, overrides, reason, changed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [d.id, d.config_version, d.code, d.name, JSON.stringify(d.overrides), reason, userId],
  );
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string }).code === '23505';
}

export interface CreateDeviceInput {
  code: string;
  name: string;
  id?: string;           // optional fixed UUID (keeps results continuous when re-creating a camera)
  env?: Env;             // initial values (RTSP_URL, lines, ...), diffed against inherited ones
}

export async function createDevice(input: CreateDeviceInput, userId: string | null): Promise<DeviceRow> {
  const code = input.code.trim();
  const name = input.name.trim();
  validateCode(code);
  if (!name) throw new DeviceError('Name is required');
  if (input.id && !UUID_RE.test(input.id)) throw new DeviceError('Device ID must be a UUID');
  const settings = await readSettings();
  const overrides = diffOverrides({ lineA: '[(100, 300), (700, 300)]', ...input.env }, code, settings);
  try {
    return await withTransaction(async client => {
      const ins = await client.query<DeviceRow>(
        `INSERT INTO devices (id, code, name, overrides) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4)
         RETURNING ${COLS}`,
        [input.id ?? null, code, name, JSON.stringify(overrides)],
      );
      const row = ins.rows[0];
      const effective = computeEffective(row, overrides, settings);
      const upd = await client.query<DeviceRow>(
        `UPDATE devices SET effective_env = $2 WHERE id = $1 RETURNING ${COLS}`, [row.id, JSON.stringify(effective)]);
      await recordHistory(client, upd.rows[0], 'create', userId);
      return upd.rows[0];
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DeviceError('A device with this code or ID already exists', 409);
    throw e;
  }
}

/**
 * Save the device form. `env` is the full environment the page edited
 * (DEVICE_CODE / DEVICE_NAME included). Returns the new row and whether the
 * code changed (the container then has to be recreated under its new name).
 */
export async function updateDevice(
  idOrCode: string, env: Env, userId: string | null, reason = 'device',
): Promise<{ device: DeviceRow; previous: DeviceRow; codeChanged: boolean }> {
  const settings = await readSettings();
  try {
    return await withTransaction(async client => {
      const cur = await client.query<DeviceRow>(
        `SELECT ${COLS} FROM devices WHERE ${UUID_RE.test(idOrCode) ? 'id' : 'code'} = $1 FOR UPDATE`, [idOrCode]);
      const previous = cur.rows[0];
      if (!previous) throw new DeviceError(`Device "${idOrCode}" not found`, 404);
      const code = (env.DEVICE_CODE ?? previous.code).trim();
      const name = (env.DEVICE_NAME ?? previous.name).trim();
      validateCode(code);
      if (!name) throw new DeviceError('Name is required');
      const overrides = diffOverrides(env, code, settings, { overrides: previous.overrides, effective: previous.effective_env });
      const effective = computeEffective({ id: previous.id, code, name }, overrides, settings);
      const changed = code !== previous.code || name !== previous.name || !sameEnv(effective, previous.effective_env);
      const version = changed ? previous.config_version + 1 : previous.config_version;
      const upd = await client.query<DeviceRow>(
        `UPDATE devices SET code = $2, name = $3, overrides = $4, effective_env = $5, config_version = $6, updated_at = now()
         WHERE id = $1 RETURNING ${COLS}`,
        [previous.id, code, name, JSON.stringify(overrides), JSON.stringify(effective), version],
      );
      const device = upd.rows[0];
      if (changed) {
        await recordHistory(client, device, reason, userId);
        await notify(client, device.id, device.config_version);
      }
      return { device, previous, codeChanged: code !== previous.code };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DeviceError('Another device already uses this code', 409);
    throw e;
  }
}

export async function setDeviceEnabled(id: string, enabled: boolean): Promise<void> {
  await query('UPDATE devices SET enabled = $2, updated_at = now() WHERE id = $1', [id, enabled]);
}

export async function deleteDevice(id: string): Promise<void> {
  await query('DELETE FROM devices WHERE id = $1', [id]);
}

/**
 * Recompute every device's effective env after the global settings changed.
 * Only devices whose effective env actually changes get a new version and a
 * NOTIFY, so editing e.g. the dashboard name wakes nobody up.
 */
export async function applySettingsToDevices(settings?: GlobalSettings): Promise<{ updated: string[] }> {
  const s = settings ?? await readSettings();
  return withTransaction(async client => {
    const rows = (await client.query<DeviceRow>(`SELECT ${COLS} FROM devices FOR UPDATE`)).rows;
    const updated: string[] = [];
    for (const d of rows) {
      const effective = computeEffective(d, d.overrides, s);
      if (sameEnv(effective, d.effective_env)) continue;
      const res = await client.query<{ config_version: number }>(
        `UPDATE devices SET effective_env = $2, config_version = config_version + 1, updated_at = now()
         WHERE id = $1 RETURNING config_version`,
        [d.id, JSON.stringify(effective)],
      );
      await notify(client, d.id, res.rows[0].config_version);
      updated.push(d.code);
    }
    return { updated };
  });
}

export interface HistoryEntry {
  id: number;
  config_version: number;
  code: string;
  name: string;
  overrides: Env;
  reason: string;
  changed_at: string;
  changed_by: string | null;
}

export async function deviceHistory(id: string, limit = 50): Promise<HistoryEntry[]> {
  return query<HistoryEntry>(
    `SELECT h.id, h.config_version, h.code, h.name, h.overrides, h.reason, h.changed_at, u.username AS changed_by
       FROM device_config_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.device_id = $1 ORDER BY h.changed_at DESC, h.id DESC LIMIT $2`,
    [id, limit],
  );
}

/** Restore the code, name and overrides saved in a history entry. */
export async function rollbackDevice(id: string, historyId: number, userId: string | null) {
  const h = await queryOne<HistoryEntry>(
    'SELECT id, config_version, code, name, overrides, reason, changed_at, NULL AS changed_by FROM device_config_history WHERE id = $1 AND device_id = $2',
    [historyId, id],
  );
  if (!h) throw new DeviceError('History entry not found', 404);
  const settings = await readSettings();
  // Rebuild a full env (inherited + overrides) so updateDevice's diff keeps
  // exactly these overrides and drops anything added since.
  const full = computeEffective({ id, code: h.code, name: h.name }, h.overrides, settings);
  return updateDevice(id, full, userId, 'rollback');
}

// ------------------------------------------------------------- transfer ----
export interface DeviceExport {
  format: 'edge-devices';
  version: 1;
  exported_at: string;
  devices: { id: string; code: string; name: string; overrides: Env }[];
}

export async function exportDevices(ids?: string[]): Promise<DeviceExport> {
  const rows = ids?.length
    ? await query<DeviceRow>(`SELECT ${COLS} FROM devices WHERE id = ANY($1::uuid[]) ORDER BY code`, [ids])
    : await query<DeviceRow>(`SELECT ${COLS} FROM devices ORDER BY code`);
  return {
    format: 'edge-devices',
    version: 1,
    exported_at: new Date().toISOString(),
    devices: rows.map(d => ({ id: d.id, code: d.code, name: d.name, overrides: d.overrides })),
  };
}

/**
 * Import devices from an export. Existing codes are skipped (never overwritten);
 * `keepIds` reuses the exported UUIDs so results keep the same device_id.
 */
export async function importDevices(data: DeviceExport, keepIds: boolean, userId: string | null) {
  if (data?.format !== 'edge-devices' || !Array.isArray(data.devices)) {
    throw new DeviceError('Not an Edge device export file');
  }
  const created: string[] = [];
  const skipped: { code: string; reason: string }[] = [];
  for (const d of data.devices) {
    try {
      await createDevice({ code: d.code, name: d.name, id: keepIds ? d.id : undefined, env: sanitizeOverrides(d.overrides ?? {}) }, userId);
      created.push(d.code);
    } catch (e) {
      skipped.push({ code: d.code, reason: (e as Error).message });
    }
  }
  return { created, skipped };
}
