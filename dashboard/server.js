// Custom Next.js server.
//
// Proxies /nodered/* (HTTP + WebSocket) to the Node-RED container so it
// appears under the dashboard's own origin/port instead of a separate port,
// then hands everything else to Next's own request handler. WebSocket
// proxying (Node-RED's live deploy-status/debug panel) is why this is a
// custom server rather than next.config.ts rewrites() — rewrites don't
// proxy the `upgrade` event.
//
// /nodered is the RAW proxy target (Node-RED's own full-page UI) — the
// dashboard's actual "Automation" nav item is the Next.js page at
// app/automation/page.tsx, which keeps the dashboard's own sidebar/layout
// and embeds this path in an <iframe>. Kept as two distinct paths so an
// iframe pointed at /nodered isn't itself trying to render inside another
// iframe's worth of dashboard chrome.
//
// This intentionally does NOT use `output: 'standalone'` (see next.config.ts)
// — a hand-written server.js and Next's own generated standalone server are
// two different, non-combinable deployment modes; this is the standard
// custom-server pattern (https://nextjs.org/docs/app/building-your-application/configuring/custom-server).
// Flip to false to turn the Node-RED proxy off (also comment out the `nodered`
// service in docker-compose.yml and the Automation item in Sidebar.tsx).
const NODERED_ENABLED = true;

const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const httpProxy = require('http-proxy');

const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);
const hostname = process.env.HOSTNAME || '0.0.0.0';
const noderedUrl = process.env.NODERED_URL || 'http://edge-nodered:1880';

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const proxy = NODERED_ENABLED
  ? httpProxy.createProxyServer({ target: noderedUrl, ws: true, changeOrigin: true })
  : null;
if (proxy) {
  proxy.on('error', (err, req, res) => {
    console.error(`[nodered proxy] ${err.message}`);
    if (res && !res.headersSent && typeof res.writeHead === 'function') {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Automation service (Node-RED) is unreachable.');
    }
  });
}

// /nodered is served here, before Next.js (and its proxy.ts login gate) sees the
// request, so it checks the session cookie itself: admin only. Same token format
// as lib/auth-token.ts (keep in sync). Signature + expiry only — no DB lookup.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
let authSecret = null;
function getAuthSecret() {
  if (authSecret) return authSecret;
  if (process.env.EDGE_AUTH_SECRET) return (authSecret = Buffer.from(process.env.EDGE_AUTH_SECRET, 'utf-8'));
  const file = path.join(path.dirname(process.env.SETTINGS_FILE || path.join(process.cwd(), 'data', 'settings.json')), 'auth-secret');
  try { return (authSecret = Buffer.from(fs.readFileSync(file, 'utf-8').trim(), 'utf-8')); } catch { return null; }
}
function sessionRole(req) {
  const secret = getAuthSecret();
  const cookie = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith('edge_session='));
  if (!secret || !cookie) return null;
  const value = decodeURIComponent(cookie.slice('edge_session='.length));
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const data = value.slice(0, dot);
  const sig = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(data).digest('base64url'));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8'));
    return p.e > Date.now() / 1000 ? p.r : null;
  } catch { return null; }
}

function isNoderedPath(url) {
  return NODERED_ENABLED && (url === '/nodered' || url.startsWith('/nodered/'));
}

app.prepare().then(() => {
  const server = createServer((req, res) => {
    if (isNoderedPath(req.url)) {
      const role = sessionRole(req);
      if (role !== 'admin') {
        res.writeHead(role ? 403 : 302, role ? { 'Content-Type': 'text/plain' } : { Location: '/login?next=/automation' });
        res.end(role ? 'Admin only' : '');
        return;
      }
      // Node-RED's own Express app registers its index route at
      // `<httpAdminRoot>/` (trailing slash) — hitting the bare path without
      // it 404s with "Cannot GET /nodered". Redirect once so both forms work.
      if (req.url === '/nodered') {
        res.writeHead(302, { Location: '/nodered/' });
        res.end();
        return;
      }
      // Node-RED serves its editor/Admin API at its root: strip /nodered and
      // target the full URL (ignorePath) — mutating req.url alone isn't enough
      // because http-proxy re-joins it with the target path.
      const nrPath = req.url.slice('/nodered'.length) || '/';
      proxy.web(req, res, { target: noderedUrl + nrPath, ignorePath: true });
      return;
    }
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  // Node-RED's editor relies on a WebSocket ("comms") channel for live
  // deploy status and the debug sidebar — proxy the upgrade event too, not
  // just regular HTTP requests.
  server.on('upgrade', (req, socket, head) => {
    if (isNoderedPath(req.url) && sessionRole(req) === 'admin') {
      const nrWsPath = req.url.slice('/nodered'.length) || '/';
      proxy.ws(req, socket, head, { target: noderedUrl + nrWsPath, ignorePath: true });
    } else {
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    const noderedStatus = NODERED_ENABLED ? `proxying /nodered -> ${noderedUrl}` : 'Node-RED integration disabled';
    console.log(`> Ready on http://${hostname}:${port} (${noderedStatus})`);
  });
});
