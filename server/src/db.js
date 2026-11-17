// Database access. Two modes, same SQL:
//  - DATABASE_URL set  -> real PostgreSQL (recommended for the server)
//  - DATABASE_URL empty -> embedded PostgreSQL (PGlite) stored in DATA_DIR, zero install
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let impl = null;

export async function initDb() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(1082, (v) => v); // DATE -> 'YYYY-MM-DD'
    pg.types.setTypeParser(1700, (v) => (v == null ? null : Number(v))); // NUMERIC -> number
    // DB_SSL: empty = as the URL says; "require" = encrypted, the server's certificate is not checked;
    // "verify" = encrypted and checked (DB_SSL_CA = path of the organisation's CA file, if it is not a public one)
    const sslMode = (process.env.DB_SSL || '').toLowerCase();
    const ssl = sslMode === 'require' ? { rejectUnauthorized: false }
      : sslMode === 'verify' ? { rejectUnauthorized: true, ...(process.env.DB_SSL_CA ? { ca: fs.readFileSync(process.env.DB_SSL_CA, 'utf8') } : {}) }
      : undefined;
    const pool = new pg.Pool({ connectionString: url, max: 10, ...(ssl ? { ssl } : {}) });
    const wrap = (c) => ({ query: async (t, p) => (await c.query(t, p)).rows });
    impl = {
      kind: 'postgres',
      close: () => pool.end(),
      ...wrap(pool),
      exec: async (t) => { await pool.query(t); },
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(wrap(c));
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      },
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '../../data/pglite'));
    fs.mkdirSync(dir, { recursive: true });
    lockDataDir(dir);
    const pgl = new PGlite(dir, { parsers: { 1082: (v) => v, 1700: (v) => (v == null ? null : Number(v)) } });
    await pgl.waitReady;
    // a small change journal (the default lets it reach 1 GB). Takes effect from the next start.
    try {
      if ((await pgl.query('SHOW max_wal_size')).rows[0]?.max_wal_size !== '64MB') {
        await pgl.exec("ALTER SYSTEM SET max_wal_size = '64MB'");
        await pgl.exec("ALTER SYSTEM SET min_wal_size = '32MB'");
      }
    } catch (e) { console.error('[gantraah] could not set the journal size:', e.message); }
    const wrap = (c) => ({ query: async (t, p) => (await c.query(t, p)).rows });
    // PGlite is single-connection: serialize transactions with a simple queue.
    let chain = Promise.resolve();
    impl = {
      kind: 'embedded',
      // wait for the change in progress, then close the files cleanly
      close: async () => { await chain.catch(() => {}); await pgl.close(); },
      ...wrap(pgl),
      exec: async (t) => { await pgl.exec(t); },
      tx: (fn) => {
        const run = chain.then(() => pgl.transaction((tx) => fn(wrap(tx))));
        chain = run.catch(() => {});
        return run;
      },
    };
  }
  await impl.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return impl;
}

/**
 * The embedded database may be opened by ONE process only: a second server on the same folder
 * would corrupt it. A lock file next to the folder holds the owner's process id. A lock whose
 * process is gone (a crash, or the service stopped by force) is taken over.
 */
/**
 * Is the server that wrote the lock still running? Not if the computer restarted since (the lock is
 * older than the last boot), not if no process has that id, and not if the process with that id is
 * something else: after a restart Windows hands the same ids to other programs.
 */
function ownerIsRunning(lock, pid) {
  const bootedAt = Date.now() - os.uptime() * 1000;
  if (fs.statSync(lock).mtimeMs < bootedAt) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try {
    if (process.platform === 'win32') {
      const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return /^"node(\.exe)?"/i.test(row.trim());
    }
    if (fs.existsSync(`/proc/${pid}/cmdline`)) return /node/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  } catch { /* cannot tell: assume it is running, the safe side */ }
  return true;
}

function lockDataDir(dir) {
  const lock = `${dir}.lock`;
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (pid && pid !== process.pid && ownerIsRunning(lock, pid)) {
      console.error(`[gantraah] The database folder is already in use by another Ganttraah server (process ${pid}):\n  ${dir}\n` +
        `Stop that server first. Only if you are sure no server is running, delete the file:\n  ${lock}`);
      process.exit(1);
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  fs.writeFileSync(lock, String(process.pid));
  const release = () => { try { if (fs.readFileSync(lock, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lock); } catch { /* gone already */ } };
  process.on('exit', release); // the server's own shutdown (Ctrl+C, stop) ends with process.exit
}

export const db = {
  query: (t, p) => impl.query(t, p),
  tx: (fn) => impl.tx(fn),
  exec: (t) => impl.exec(t),
  get kind() { return impl?.kind; },
  /** close the database (on shutdown): the embedded one writes everything to disk first */
  close: () => (impl?.close ? impl.close() : Promise.resolve()),
};

// Normalise a DATE value coming from either driver to 'YYYY-MM-DD' (or null).
export function isoDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
