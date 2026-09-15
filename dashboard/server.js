// Custom Next.js server.
//
// --- Node-RED "Automation" integration: TEMPORARILY DISABLED ---
// See nodered/DEV_NOTES.md (gitignored) for current status/why. To
// re-enable: flip NODERED_ENABLED to true below, uncomment the `nodered`
// service in docker-compose.yml (and the dashboard service's `depends_on`/
// `NODERED_URL` lines), and uncomment the nav item in components/Sidebar.tsx.
// Everything else here (the proxy logic itself) is left intact rather than
// deleted so re-enabling is a one-line flip, not a rewrite.
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
// Kept even while Node-RED is disabled since reverting it and setting it back
// up again later would just be repeated work for a currently-inert file.
const NODERED_ENABLED = true;

const { createServer } = require('http');
const next = require('next');
const httpProxy = require('http-proxy');
const net = require('net');
const WebSocket = require('ws');
const express = require('express');
const { ExpressPeerServer } = require('peer');

// Load .env.local (and other Next.js env files) before reading any env vars.
// Without this, env vars set in .env.local are not available at startup because
// Next.js normally loads them inside app.prepare() — after we'd already read them.
const { loadEnvConfig } = require('@next/env');
loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production');

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

function isNoderedPath(url) {
  return NODERED_ENABLED && (url === '/nodered' || url.startsWith('/nodered/'));
}

// ── VNC WebSocket-to-TCP bridge ───────────────────────────────────────────────
// Reads VNC_HOST/VNC_PORT from the device's .env file and bridges the
// browser WebSocket connection directly to the raw TCP VNC port. No extra
// container needed — the ws + net packages handle the framing/bridging.
const fs = require('fs');
const path = require('path');

function readDeviceEnvSync(deviceCode) {
  const dir = process.env.PYTHON_COUNTING_DIR || path.join(process.cwd(), '..', 'python-counting');
  const filePath = path.join(dir, `.env_${deviceCode}`);
  if (!fs.existsSync(filePath)) return null;
  const config = {};
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      val = val.slice(1, -1);
    }
    config[t.slice(0, eq).trim()] = val;
  }
  return config;
}

function handleVncUpgrade(req, socket, head, deviceCode) {
  const env = readDeviceEnvSync(deviceCode);
  if (!env || env.DEVICE_TYPE !== 'vnc' || !env.VNC_HOST) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const vncHost = env.VNC_HOST;
  const vncPort = parseInt(env.VNC_PORT || '5900', 10);

  const wss = new WebSocket.WebSocketServer({ noServer: true });
  wss.handleUpgrade(req, socket, head, (ws) => {
    const tcp = net.createConnection(vncPort, vncHost);

    tcp.on('connect', () => {
      console.log(`[vnc] ${deviceCode} → ${vncHost}:${vncPort}`);
    });

    ws.on('message', (data) => {
      if (tcp.writable) tcp.write(data);
    });

    tcp.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true });
    });

    const teardown = () => {
      tcp.destroy();
      if (ws.readyState !== WebSocket.CLOSED) ws.close();
    };
    ws.on('close', teardown);
    ws.on('error', teardown);
    tcp.on('close', teardown);
    tcp.on('error', (err) => {
      console.error(`[vnc] ${deviceCode} TCP error: ${err.message}`);
      teardown();
    });
  });
}

app.prepare().then(() => {
  const nextUpgrade = app.getUpgradeHandler();

  // ── PeerJS HTTP app ───────────────────────────────────────────────────────
  // Declared here so the createServer closure sees it before server.listen().
  // ExpressPeerServer is called below (after server is created) but requests
  // only arrive after server.listen(), at which point peerApp is fully set up.
  let peerApp = null;

  const server = createServer((req, res) => {
    if (req.url && req.url.startsWith('/peerjs')) {
      peerApp(req, res);
      return;
    }
    if (isNoderedPath(req.url)) {
      if (req.url === '/nodered') {
        res.writeHead(302, { Location: '/nodered/' });
        res.end();
        return;
      }
      // Strip /nodered prefix and pass via ignorePath — mutating req.url alone is
      // unreliable in the Next.js 16 server pipeline.
      const nrPath = req.url.slice('/nodered'.length) || '/';
      proxy.web(req, res, { target: noderedUrl + nrPath, ignorePath: true });
      return;
    }
    handle(req, res);
  });

  // ── PeerJS signaling server ───────────────────────────────────────────────
  // ExpressPeerServer internally creates a ws.WebSocketServer attached to
  // `server` that intercepts ALL upgrade events and rejects non-/peerjs paths
  // with 400 Bad Request — breaking Next.js HMR and VNC WebSocket connections.
  // Fix: capture the listeners it adds, remove them, then route upgrades
  // ourselves so only /peerjs paths are forwarded to PeerJS.
  const upgradesBefore = server.listeners('upgrade').slice();
  const peerServer = ExpressPeerServer(server, { key: 'peerjs', path: '/peerjs' });
  peerApp = express();
  peerApp.use('/peerjs', peerServer);
  peerServer.on('connection', (client) => console.log(`[peerjs] connect: ${client.getId()}`));
  peerServer.on('disconnect', (client) => console.log(`[peerjs] disconnect: ${client.getId()}`));

  const peerWsListeners = server.listeners('upgrade').filter(l => !upgradesBefore.includes(l));
  peerWsListeners.forEach(l => server.removeListener('upgrade', l));

  // ── Upgrade router ────────────────────────────────────────────────────────
  // Handles all WebSocket upgrades in priority order. PeerJS's ws listeners are
  // called manually only for /peerjs paths; everything else reaches Next.js.
  server.on('upgrade', (req, socket, head) => {
    const vncMatch = req.url && req.url.match(/^\/vnc\/([^/?#]+)/);
    if (vncMatch) {
      handleVncUpgrade(req, socket, head, vncMatch[1]);
    } else if (isNoderedPath(req.url)) {
      const nrWsPath = req.url.slice('/nodered'.length) || '/';
      proxy.ws(req, socket, head, { target: noderedUrl + nrWsPath, ignorePath: true });
    } else if (req.url && req.url.startsWith('/peerjs')) {
      peerWsListeners.forEach(l => l.call(server, req, socket, head));
    } else {
      nextUpgrade(req, socket, head);
    }
  });

  server.listen(port, hostname, () => {
    const noderedStatus = NODERED_ENABLED ? `proxying /nodered -> ${noderedUrl}` : 'Node-RED integration disabled';
    console.log(`> Ready on http://${hostname}:${port} (${noderedStatus})`);
  });
});
