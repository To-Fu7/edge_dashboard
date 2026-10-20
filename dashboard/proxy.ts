// Login gate for every page and API route (Next.js 16 "proxy", formerly middleware).
//
// 1. Strip any client-sent x-edge-user-* headers.
// 2. Verify the signed session cookie and that the session still exists in the
//    database (cached 30 s per session so this stays cheap).
// 3. Check the role may use this path (lib/permissions.ts).
// 4. Pass the user to route handlers as x-edge-user-* headers (lib/auth.ts requestUser).
//
// /nodered is handled in server.js before Next sees the request.
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifyToken } from './lib/auth-token';
import { sessionUser, sessionCache, USER_HEADERS, type SessionUser } from './lib/auth';
import { canAccess, isPublicPath, USER_HOME } from './lib/permissions';
import { describeDbError } from './lib/db';

const CACHE_MS = 30_000;
const cache = sessionCache;   // shared with logout / user changes (lib/auth.ts)

async function resolveUser(cookie: string | undefined): Promise<SessionUser | null> {
  if (!cookie || !verifyToken(cookie)) return null;
  const hit = cache.get(cookie);
  if (hit && hit.until > Date.now()) return hit.user;
  const user = await sessionUser(cookie);
  cache.set(cookie, { user, until: Date.now() + CACHE_MS });
  if (cache.size > 5000) cache.clear();
  return user;
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith('/api/');
  const headers = new Headers(req.headers);
  for (const h of Object.values(USER_HEADERS)) headers.delete(h);

  if (isPublicPath(pathname)) return NextResponse.next({ request: { headers } });

  let user: SessionUser | null;
  try {
    user = await resolveUser(req.cookies.get(SESSION_COOKIE)?.value);
  } catch (e) {
    const message = `Login unavailable: ${describeDbError(e)}`;
    if (isApi) return NextResponse.json({ error: message }, { status: 503 });
    return new NextResponse(message, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  if (!user) {
    if (isApi) return NextResponse.json({ error: 'Not logged in' }, { status: 401 });
    const url = new URL('/login', req.url);
    if (pathname !== '/') url.searchParams.set('next', pathname + search);
    return NextResponse.redirect(url);
  }

  if (!canAccess(user.role, req.method, pathname)) {
    if (isApi) return NextResponse.json({ error: 'Admin only' }, { status: 403 });
    return NextResponse.redirect(new URL(USER_HOME, req.url));
  }

  headers.set(USER_HEADERS.id, user.id);
  headers.set(USER_HEADERS.name, user.username);
  headers.set(USER_HEADERS.role, user.role);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
