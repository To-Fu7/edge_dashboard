import { NextResponse } from 'next/server';
import { queryOne, describeDbError } from '@/lib/db';
import { startupState } from '@/lib/startup';

export const dynamic = 'force-dynamic';

// Public: used by setup/install.sh and container health checks. Reports whether
// the database is reachable and the startup tasks (migrations, seed, reconcile) ran.
export async function GET() {
  const state = startupState();
  try {
    const row = await queryOne<{ version: string }>('SELECT max(version) AS version FROM schema_migrations');
    const ok = state.ready && !state.error;
    return NextResponse.json({ ok, db: 'ok', schema: row?.version ?? null, startup: state }, { status: ok ? 200 : 503 });
  } catch (e) {
    return NextResponse.json({ ok: false, db: describeDbError(e), startup: state }, { status: 503 });
  }
}
