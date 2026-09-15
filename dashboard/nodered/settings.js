// bcryptjs is bundled with node-red as a direct runtime dependency
const bcrypt = require('bcryptjs');

module.exports = {
    uiPort: process.env.PORT || 1880,

    // NR editor is kept accessible at /nodered for developer debugging,
    // but not exposed to end users — the dashboard embeds its own custom
    // editor UI (Next.js + React Flow) that talks to NR via the Admin API.
    // Admin (editor + REST API) at root so direct port-1880 access works normally.
    // The dashboard proxies /nodered/* → port 1880, stripping the /nodered prefix
    // before forwarding — so /nodered/auth/token → /auth/token here.
    httpAdminRoot: '/',
    httpNodeRoot: '/api',

    flowFile: 'flows.json',
    userDir: '/data',

    // Credentials auth — password is hashed on each startup (cheap, happens once).
    // Set NODE_RED_USERNAME / NODE_RED_PASSWORD in docker-compose environment.
    adminAuth: {
        type: 'credentials',
        users: [{
            username: process.env.NODE_RED_USERNAME || 'admin',
            password: bcrypt.hashSync(process.env.NODE_RED_PASSWORD || 'epiwalk_admin', 8),
            permissions: '*',
        }],
        // Also accept token-based auth (used by the dashboard API client)
        tokens: [],
    },

    functionGlobalContext: {},

    editorTheme: {
        page: {
            title: 'Epiwalk Automation Engine',
            css: '/data/custom-theme.css',
        },
        header: { title: 'Automation Engine' },
        projects: { enabled: false },
    },

    logging: {
        console: {
            level: 'info',
            metrics: false,
            audit: false,
        },
    },
};
