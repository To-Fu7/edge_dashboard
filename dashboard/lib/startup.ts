// Startup tasks, run once per server process from instrumentation.ts:
// migrations → default users → settings row → python-counting/.env for Triton
// → reconcile camera containers with the database.
//
// Runs in the background and retries every 5 s, so the dashboard still starts
// (and can explain what's wrong via /api/health) while PostgreSQL is coming up.
import { runMigrations } from './db-migrate';
import { describeDbError, queryOne } from './db';
import { seedDefaultUsers } from './auth';
import { readSettings, updateSettings } from './settings';
import { writeTritonEnv } from './compose';
import { listDevices } from './devices';
import { reconcileDevices } from './device-runtime';

interface StartupState {
  ready: boolean;
  error: string | null;
  attempts: number;
  migrationsApplied: string[];
  reconcileError: string | null;
}

const g = globalThis as unknown as { __edgeStartup?: Promise<void>; __edgeStartupState?: StartupState };
const state: StartupState = g.__edgeStartupState ??= {
  ready: false, error: null, attempts: 0, migrationsApplied: [], reconcileError: null,
};

export function startupState(): StartupState {
  return { ...state };
}

async function once(): Promise<void> {
  state.migrationsApplied = await runMigrations();
  if (await seedDefaultUsers()) console.log('[startup] created default users admin / user');
  const hasSettings = await queryOne('SELECT 1 FROM settings WHERE key = $1', ['global']);
  if (!hasSettings) await updateSettings({}, null);
  const settings = await readSettings();
  try {
    writeTritonEnv(settings);
  } catch (e) {
    console.error('[startup] could not write python-counting/.env:', (e as Error).message);
  }
  try {
    await reconcileDevices(await listDevices());
    state.reconcileError = null;
  } catch (e) {
    state.reconcileError = (e as Error).message;
    console.error('[startup] reconcile failed:', state.reconcileError);
  }
}

export function runStartup(): Promise<void> {
  g.__edgeStartup ??= (async () => {
    for (;;) {
      state.attempts += 1;
      try {
        await once();
        state.ready = true;
        state.error = null;
        if (state.migrationsApplied.length) console.log('[startup] applied migrations:', state.migrationsApplied.join(', '));
        console.log('[startup] ready');
        return;
      } catch (e) {
        state.error = describeDbError(e);
        if (state.attempts === 1 || state.attempts % 12 === 0) console.error(`[startup] waiting for the database: ${state.error}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  })();
  return g.__edgeStartup;
}
