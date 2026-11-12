// Local users with scrypt-hashed passwords and cookie sessions.
// (Active Directory / LDAP can be added later by replacing verifyLogin.)
import crypto from 'node:crypto';
import { db } from './db.js';
import { HttpError } from './store.js';

const COOKIE = 'gantraah_sid';
const SESSION_DAYS = 14;
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}

export function verifyPassword(pw, stored) {
  const [alg, salt, h] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !h) return false;
  const calc = crypto.scryptSync(String(pw), salt, 32);
  const want = Buffer.from(h, 'hex');
  return want.length === calc.length && crypto.timingSafeEqual(calc, want);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const publicUser = (u) => u && ({
  id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: u.active,
  unit_id: u.unit_id ?? null, head: u.head ?? '', kind: u.kind ?? 'account', edit_all: !!u.edit_all,
});

export async function login(username, password) {
  const u = (await db.query('SELECT * FROM users WHERE lower(username) = lower($1)', [String(username || '').trim()]))[0];
  if (!u || !u.active || !verifyPassword(password, u.password_hash)) throw new HttpError(401, 'שם משתמש או סיסמה שגויים');
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.query('INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)', [token, u.id, expires]);
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  return { token, user: publicUser(u), expires };
}

export function sessionCookie(token, expires) {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure}`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

// Branch management (the root unit) enters with a password; every other unit enters without one.
export const DEFAULT_ADMIN_PASSWORD = 'ליורד';
export async function checkAdminPassword(pw) {
  const row = (await db.query("SELECT value FROM settings WHERE key='admin_password'"))[0];
  const stored = row ? (typeof row.value === 'string' ? row.value : row.value?.hash) : null;
  return stored ? verifyPassword(pw ?? '', stored) : String(pw ?? '') === DEFAULT_ADMIN_PASSWORD;
}
export async function setAdminPassword(pw) {
  await db.query(`INSERT INTO settings (key, value) VALUES ('admin_password', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ hash: hashPassword(pw) })]);
}

/** Enter the system as an organisation unit (or view-only). Only branch management has a password. */
export async function enterAsUnit(unitId, viewOnly, password) {
  let unit = null;
  if (!viewOnly) {
    unit = (await db.query('SELECT * FROM units WHERE id=$1', [Number(unitId)]))[0];
    if (!unit) throw new HttpError(400, 'היחידה לא נמצאה');
    if (unit.parent_id == null && !(await checkAdminPassword(password))) throw new HttpError(403, 'הסיסמה שגויה');
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  await db.query('INSERT INTO sessions (token, unit_id, view_only, expires_at) VALUES ($1,$2,$3,$4)', [token, unit?.id ?? null, !!viewOnly, expires]);
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  return { token, expires };
}

const unitUser = (u) => ({
  id: u.id, unit_id: u.id, username: `unit-${u.id}`, display_name: u.name, head: u.head, kind: u.kind,
  role: u.parent_id == null ? 'admin' : 'editor', active: true, edit_all: !!u.edit_all,
});
export const VIEWER = { id: null, unit_id: null, username: 'viewer', display_name: 'צפייה בלבד', head: '', kind: 'viewer', role: 'viewer', active: true };

export async function userFromCookieHeader(header) {
  const token = parseCookies(header)[COOKIE];
  if (!token) return null;
  const s = (await db.query('SELECT * FROM sessions WHERE token=$1 AND expires_at > now()', [token]))[0];
  if (!s) return null;
  if (s.unit_id) {
    const u = (await db.query('SELECT * FROM units WHERE id=$1', [s.unit_id]))[0];
    return u ? { ...unitUser(u), token } : null;
  }
  if (s.view_only) return { ...VIEWER, token };
  // legacy username/password account
  const u = (await db.query('SELECT * FROM users WHERE id=$1 AND active', [s.user_id]))[0];
  return u ? { ...publicUser(u), token } : null;
}

export async function logout(header) {
  const token = parseCookies(header)[COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE token = $1', [token]);
}

export const authenticate = async (req, _res, next) => {
  try { req.user = await userFromCookieHeader(req.headers.cookie); next(); } catch (e) { next(e); }
};

export const requireRole = (role) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'יש להתחבר'));
  if ((ROLE_RANK[req.user.role] || 0) < ROLE_RANK[role]) {
    return next(new HttpError(403, req.user.role === 'viewer'
      ? 'נכנסת לצפייה בלבד. כדי לערוך, צריך להיכנס דרך היחידה שלך.'
      : role === 'admin' ? 'רק הנהלת הענף יכולה לבצע את הפעולה הזו.' : 'אין לך הרשאה לפעולה הזו'));
  }
  next();
};

/** Create the first admin user if the users table is empty. */
export async function ensureAdmin() {
  const n = (await db.query('SELECT count(*)::int AS n FROM users'))[0].n;
  if (n > 0) return null;
  let pw = process.env.ADMIN_PASSWORD;
  let generated = false;
  if (!pw) { pw = crypto.randomBytes(9).toString('base64url'); generated = true; }
  const username = process.env.ADMIN_USERNAME || 'admin';
  await db.query('INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4)',
    [username, 'מנהל מערכת', hashPassword(pw), 'admin']);
  return { username, password: generated ? pw : null };
}
