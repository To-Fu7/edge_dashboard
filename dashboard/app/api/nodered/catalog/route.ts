import { NextResponse } from 'next/server';

const CATALOG_URL = 'https://catalogue.nodered.org/catalogue.json';
const CACHE_TTL = 1000 * 60 * 30; // 30 min — catalog updates rarely

let catalogCache: { data: unknown; ts: number } | null = null;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q')?.toLowerCase() ?? '';

  try {
    if (!catalogCache || Date.now() - catalogCache.ts > CACHE_TTL) {
      const res = await fetch(CATALOG_URL, { next: { revalidate: 1800 } });
      if (!res.ok) throw new Error(`catalog fetch: ${res.status}`);
      catalogCache = { data: await res.json(), ts: Date.now() };
    }

    const catalog = catalogCache.data as { modules: unknown[] };
    const modules = q
      ? catalog.modules.filter((m: unknown) => {
          const s = JSON.stringify(m).toLowerCase();
          return q.split(' ').every(term => s.includes(term));
        })
      : catalog.modules;

    return NextResponse.json({ modules: modules.slice(0, 100), total: modules.length });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
