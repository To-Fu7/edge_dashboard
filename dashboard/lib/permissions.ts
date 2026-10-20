// Who may open what. Used by proxy.ts for every request (pages and API) and by
// the sidebar to hide what a role can't use. Admin may do everything; `user`
// gets live CCTV and the Detection dashboard, read-only.
import type { Role } from './auth-token';

/** No login needed. */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/login'
    || pathname === '/api/auth/login'
    || pathname === '/api/health'
    || pathname.startsWith('/_next/')
    || pathname === '/favicon.ico';
}

const USER_PAGES = [/^\/$/, /^\/stream$/, /^\/detection$/];

// Read-only data the Stream and Detection dashboard pages need. Responses that
// carry secrets (device env, settings) are redacted for `user` in the routes.
const USER_API_GET = [
  /^\/api\/auth\/me$/,
  /^\/api\/devices$/,
  /^\/api\/devices\/(?!export$|import$)[^/]+$/,      // device detail (env redacted for user) — not the export
  /^\/api\/devices\/[^/]+\/(counts|stream-urls|bbox)$/,
  /^\/api\/stream\/[^/]+(\/annotated)?$/,
  /^\/api\/system$/,
  /^\/api\/triton\/status$/,
  /^\/api\/settings$/,
];
const USER_API_ANY = [/^\/api\/auth\/logout$/];

export function canAccess(role: Role, method: string, pathname: string): boolean {
  if (role === 'admin') return true;
  if (pathname.startsWith('/api/')) {
    if (USER_API_ANY.some(r => r.test(pathname))) return true;
    return (method === 'GET' || method === 'HEAD') && USER_API_GET.some(r => r.test(pathname));
  }
  return USER_PAGES.some(r => r.test(pathname));
}

/** Where a `user` lands when they open something they can't use. */
export const USER_HOME = '/stream';
