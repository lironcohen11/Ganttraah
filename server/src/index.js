// Ganttraah server entry point.
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
import { onChange, pruneHistory, HISTORY_DAYS, maintenance } from './store.js';
import { seedDemoIfEmpty } from './seed.js';
import { ensureUnits, migrateOwners, restructureUnits, migrateSpecialDays } from './units.js';

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
{ const n = await migrateSpecialDays(); if (n) console.log(`[gantraah] ${n} special days moved to the new table`); }
// projects whose original plan was saved before 1.5.1: take the date from the history
await db.query("UPDATE projects p SET baseline_at = (SELECT max(at) FROM audit_log a WHERE a.action='baseline' AND a.project_id=p.id) WHERE baseline_at IS NULL");
// history older than a year is deleted now, and then once a day
const prune = () => pruneHistory()
  .then((n) => { if (n) console.log(`[gantraah] ${n} history entries older than ${HISTORY_DAYS} days deleted`); })
  .catch((e) => console.error('[gantraah] history cleanup failed:', e.message));
await prune();
setInterval(prune, 24 * 3600 * 1000).unref();
// embedded database: housekeeping now, and every night at 03:00 (when nobody works)
if (db.kind === 'embedded') {
  await maintenance();
  const nightly = () => {
    const now = new Date(), next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => { maintenance().finally(nightly); }, next - now).unref();
  };
  nightly();
}

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
  app.get('/', (_req, res) => res.send('Ganttraah server is running. Client build not found at ' + STATIC_DIR));
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
// Who has which task open: every browser tab says which task card it shows ({ type: 'view', task }),
// and everyone gets the full list after each change ({ type: 'presence', viewers: { taskId: [{ c, n }] } }).
// c = the tab's own id (so a tab can leave itself out), n = the unit the tab entered as.
function sendPresence() {
  const viewers = {};
  for (const ws of wss.clients) {
    if (ws.readyState !== 1 || ws.viewing == null) continue;
    (viewers[ws.viewing] ||= []).push({ c: ws.client || '', n: ws.user?.display_name || '' });
  }
  const text = JSON.stringify({ type: 'presence', viewers });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(text);
}
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.viewing = null;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw).slice(0, 500)); } catch { return; }
    if (m?.type !== 'view') return;
    ws.client = String(m.client || '').slice(0, 40);
    const task = Number.isInteger(m.task) ? m.task : null;
    if (task === ws.viewing) return;
    ws.viewing = task;
    sendPresence();
  });
  ws.on('close', () => { if (ws.viewing != null) sendPresence(); });
  sendPresence();
});
wss.on('close', () => clearInterval(ping));
onChange((msg) => {
  const text = JSON.stringify(msg);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(text);
});

server.listen(PORT, HOST, () => {
  console.log(`[gantraah] listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (database: ${db.kind})`);
});

// stopping (Ctrl+C, a service stop, or OpenShift/Kubernetes deleting the pod: SIGTERM): stop taking
// requests, let the change in progress finish, close the database, then exit. At most 10 seconds.
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log('[gantraah] shutting down');
  setTimeout(() => process.exit(0), 10000).unref();
  server.close();
  for (const ws of wss.clients) ws.terminate();
  try { await db.close(); } catch (e) { console.error('[gantraah] closing the database:', e.message); }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
