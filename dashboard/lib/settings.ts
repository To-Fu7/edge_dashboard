// Global settings — one JSON document in the `settings` table (key 'global').
// Every change is kept in settings_history. Applying the change to devices
// (recomputing their effective env) is done by the caller: see
// applySettingsToDevices() in lib/devices.ts.
import { query, queryOne, withTransaction } from './db';
import { GlobalSettings, DEFAULT_SETTINGS } from './types';

const KEY = 'global';

/** Fill sections a stored document may be missing (older versions, partial writes). */
export function mergeSettings(stored: Partial<GlobalSettings> | null | undefined): GlobalSettings {
  const p = stored ?? {};
  return {
    appName: p.appName ?? DEFAULT_SETTINGS.appName,
    hardwareMode: p.hardwareMode ?? DEFAULT_SETTINGS.hardwareMode,
    triton: { ...DEFAULT_SETTINGS.triton, ...p.triton },
    streamGateway: { ...DEFAULT_SETTINGS.streamGateway, ...p.streamGateway },
    portForward: { ...DEFAULT_SETTINGS.portForward, ...p.portForward },
    mqtt: { ...DEFAULT_SETTINGS.mqtt, ...p.mqtt },
    defaults: { ...DEFAULT_SETTINGS.defaults, ...p.defaults },
  };
}

export async function readSettings(): Promise<GlobalSettings> {
  const row = await queryOne<{ value: Partial<GlobalSettings> }>('SELECT value FROM settings WHERE key = $1', [KEY]);
  return mergeSettings(row?.value);
}

/** Shallow-merge `patch` into the stored document per section; returns old and new. */
export async function updateSettings(
  patch: Partial<GlobalSettings>,
  userId: string | null,
): Promise<{ previous: GlobalSettings; next: GlobalSettings }> {
  return withTransaction(async client => {
    const cur = await client.query<{ value: Partial<GlobalSettings> }>('SELECT value FROM settings WHERE key = $1 FOR UPDATE', [KEY]);
    const previous = mergeSettings(cur.rows[0]?.value);
    const next = mergeSettings({
      ...previous,
      ...patch,
      triton: { ...previous.triton, ...patch.triton },
      streamGateway: { ...previous.streamGateway, ...patch.streamGateway },
      portForward: { ...previous.portForward, ...patch.portForward },
      mqtt: { ...previous.mqtt, ...patch.mqtt },
      defaults: { ...previous.defaults, ...patch.defaults },
    });
    await client.query(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1, $2, now(), $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [KEY, JSON.stringify(next), userId],
    );
    await client.query('INSERT INTO settings_history (key, value, changed_by) VALUES ($1, $2, $3)', [KEY, JSON.stringify(next), userId]);
    return { previous, next };
  });
}

export async function settingsHistory(limit = 50): Promise<{ id: number; value: GlobalSettings; changed_at: string; changed_by: string | null }[]> {
  return query(
    `SELECT h.id, h.value, h.changed_at, u.username AS changed_by
       FROM settings_history h LEFT JOIN users u ON u.id = h.changed_by
      WHERE h.key = $1 ORDER BY h.changed_at DESC LIMIT $2`,
    [KEY, limit],
  );
}
