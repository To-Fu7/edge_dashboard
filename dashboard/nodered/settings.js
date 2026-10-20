/**
 * Node-RED settings — mounted read-only into /data/settings.js.
 *
 * The dashboard is the only way in: dashboard/server.js proxies /nodered/* to
 * this container (HTTP + the WebSocket "comms" channel for deploy status and
 * debug messages), stripping the /nodered prefix — so the editor and Admin API
 * live at the root here. The dashboard's Automation pages list flows through
 * the Admin API (lib/nodered.ts) and open a single flow in an iframe.
 *
 * No adminAuth: access is gated by the dashboard login (admin only) and the
 * container publishes no host port. Anything else on the `envisions` Docker
 * network can still reach port 1880 — add adminAuth (and teach lib/nodered.ts
 * to send a token) before putting untrusted containers on that network.
 * Function/exec nodes run arbitrary code on this host.
 */
module.exports = {
    uiPort: process.env.PORT || 1880,

    // Editor + Admin API at the root (the dashboard proxy strips /nodered).
    httpAdminRoot: '/',
    // Flow-defined HTTP in/out nodes (reachable as /nodered/api/... through the proxy).
    httpNodeRoot: '/api',

    // Everything below persists in the /data volume (named volume in
    // docker-compose, NOT committed to git — contains flows + credentials +
    // any community nodes installed via "Manage palette").
    flowFile: 'flows.json',
    userDir: '/data',

    // Community nodes (via the editor's "Manage palette", or by adding
    // dependencies to /data/package.json) install into this same volume and
    // survive container recreation as long as the volume isn't deleted.

    functionGlobalContext: {
        // Add shared modules/config here if flows need them, e.g.:
        // mqttBroker: process.env.MQTT_BROKER,
    },

    editorTheme: {
        page: {
            title: 'Edge Automation',
        },
        header: {
            title: 'Edge Automation',
        },
        // The dashboard already provisions/manages docker-compose services —
        // Node-RED's own "Projects" (git-backed flow storage) would be a
        // second, redundant place to manage config. Keep flows as a single
        // flows.json file instead (the default/simpler model).
        projects: {
            enabled: false,
        },
    },

    logging: {
        console: {
            level: 'info',
            metrics: false,
            audit: false,
        },
    },

    // The dashboard embeds this editor in a same-origin <iframe> (components/nodered/IframeEditor.tsx).
    // Explicitly allow same-origin framing so a stricter default (or a future
    // Node-RED version defaulting to X-Frame-Options: DENY) can't silently
    // blank out that iframe.
    httpAdminMiddleware: function (req, res, next) {
        res.setHeader('X-Frame-Options', 'SAMEORIGIN');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
        next();
    },
};
