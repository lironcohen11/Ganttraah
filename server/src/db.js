// Database access. Two modes, same SQL:
//  - DATABASE_URL set  -> real PostgreSQL (recommended for the server)
//  - DATABASE_URL empty -> embedded PostgreSQL (PGlite) stored in DATA_DIR, zero install
import fs from 'node:fs';
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
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const wrap = (c) => ({ query: async (t, p) => (await c.query(t, p)).rows });
    impl = {
      kind: 'postgres',
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
    const pgl = new PGlite(dir, { parsers: { 1082: (v) => v, 1700: (v) => (v == null ? null : Number(v)) } });
    await pgl.waitReady;
    const wrap = (c) => ({ query: async (t, p) => (await c.query(t, p)).rows });
    // PGlite is single-connection: serialize transactions with a simple queue.
    let chain = Promise.resolve();
    impl = {
      kind: 'embedded',
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

export const db = {
  query: (t, p) => impl.query(t, p),
  tx: (fn) => impl.tx(fn),
  exec: (t) => impl.exec(t),
  get kind() { return impl?.kind; },
};

// Normalise a DATE value coming from either driver to 'YYYY-MM-DD' (or null).
export function isoDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
