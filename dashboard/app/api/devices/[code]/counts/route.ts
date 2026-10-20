import { NextResponse } from 'next/server';
import { getDevice } from '@/lib/devices';
import { queryOne } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const device = await getDevice((await params).code);
    if (!device) return NextResponse.json({ in: 0, out: 0 });
    // The camera writes one person_inout row per local (Asia/Jakarta) day.
    const row = await queryOne<{ total_in: number; total_out: number }>(
      `SELECT COALESCE(total_in, 0) AS total_in, COALESCE(total_out, 0) AS total_out
         FROM person_inout
        WHERE device_id = $1
          AND (created_at AT TIME ZONE 'Asia/Jakarta')::date = (now() AT TIME ZONE 'Asia/Jakarta')::date
        ORDER BY created_at DESC
        LIMIT 1`,
      [device.id],
    );
    return NextResponse.json({ in: Number(row?.total_in ?? 0), out: Number(row?.total_out ?? 0) });
  } catch (e) {
    return NextResponse.json({ in: 0, out: 0, error: String(e) });
  }
}
