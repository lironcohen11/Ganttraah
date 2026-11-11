// Gantraah server entry point.
import './env.js';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { initDb, db } from './db.js';
import { api } from './api.js';
import { ensureAdmin, userFromCookieHeader } from './auth.js';
import { onChange } from './store.js';
import { seedDemoIfEmpty } from './seed.js';
import { ensureUnits, migrateOwners, restructureUnits } from './units.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || path.join(__dirname, '../../client/dist'));

await initDb();
const created = await ensureAdmin();
if (created?.password) {
  const file = path.resolve(process.env.DATA_DIR ? path.join(process.env.DATA_DIR, '..') : path.join(__dirname, '../../data'), 'initial-admin.txt');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `username: ${created.username}\npassword: ${created.password}\n(change it after the first login, then delete this file)\n`);
  } catch { /* read-only disk */ }
  console.log(`[gantraah] first admin user "${created.username}" created. Password written to ${file}`);
}
if (await ensureUnits()) console.log('[gantraah] example organisation structure created');
{ const r = await restructureUnits(); if (r?.length) console.log('[gantraah] organisation updated:', r.join(', ')); }
if (process.env.SEED_DEMO === 'true' && (await seedDemoIfEmpty())) console.log('[gantraah] demo data loaded');
{ const n = await migrateOwners(); if (n) console.log(`[gantraah] ${n} task owners converted to units`); }

const app = express();
app.disable('x-powered-by');
app.get('/healthz', async (_req, res) => {
  try { await db.query('SELECT 1'); res.json({ ok: true, db: db.kind }); } catch { res.status(500).json({ ok: false }); }
});
app.use('/api', api);
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
  });
} else {
  app.get('/', (_req, res) => res.send('Gantraah server is running. Client build not found at ' + STATIC_DIR));
}

const server = http.createServer(app);

// Live updates: every change is pushed to all connected browsers, which then reload the data.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', async (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) return socket.destroy();
  const user = await userFromCookieHeader(req.headers.cookie).catch(() => null);
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => { ws.user = user; wss.emit('connection', ws); });
});
const ping = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000);
wss.on('connection', (ws) => { ws.alive = true; ws.on('pong', () => { ws.alive = true; }); });
wss.on('close', () => clearInterval(ping));
onChange((msg) => {
  const text = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(text);
});

server.listen(PORT, HOST, () => {
  console.log(`[gantraah] listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (database: ${db.kind})`);
});

const shutdown = () => { server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
