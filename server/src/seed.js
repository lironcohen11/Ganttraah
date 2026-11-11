// Demo data: three linked projects, so the system can be shown on day one.
// Loaded only when SEED_DEMO=true and the database has no projects.
import { db } from './db.js';
import { loadAll } from './store.js';
import { computeSchedule } from './scheduler.js';

export async function seedDemoIfEmpty() {
  const n = (await db.query('SELECT count(*)::int AS n FROM projects'))[0].n;
  if (n > 0) return false;
  await db.tx(async (tx) => {
    const proj = async (name, start, color, description, so) =>
      (await tx.query('INSERT INTO projects (name, start_date, color, description, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [name, start, color, description, so]))[0].id;
    let so = 0;
    const task = async (project, parent, name, o = {}) =>
      (await tx.query(
        `INSERT INTO tasks (project_id, parent_id, sort_order, name, kind, duration, percent, owner, notes, deadline, cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [project, parent, (so += 10), name, o.ms ? 'milestone' : 'task', o.ms ? 0 : (o.d ?? 5), o.pct ?? 0,
          o.owner ?? '', o.notes ?? '', o.deadline ?? null, o.cost ?? null]))[0].id;
    const dep = (p, s, type = 'FS', lag = 0) =>
      tx.query('INSERT INTO dependencies (predecessor_id, successor_id, type, lag) VALUES ($1,$2,$3,$4)', [p, s, type, lag]);

    // ---- Project 3 (infrastructure) - other projects depend on it
    const P3 = await proj('שדרוג תשתיות תקשורת', '2026-10-18', '#c2410c', 'החלפת שרתים ורכיבי תקשורת במרכז הנתונים', 3);
    const p3a = await task(P3, null, 'סקר תשתיות קיימות', { d: 6, pct: 100, owner: 'אבי' });
    const p3b = await task(P3, null, 'רכש ציוד', { d: 15, pct: 60, owner: 'אבי', notes: 'ממתינים לאישור ספק על חלק מהרכיבים' });
    const p3c = await task(P3, null, 'התקנת שרתים', { d: 8, owner: 'אבי' });
    const p3m = await task(P3, null, 'השרתים זמינים', { ms: true });
    await dep(p3a, p3b); await dep(p3b, p3c); await dep(p3c, p3m);

    // ---- Project 1 (main system)
    const P1 = await proj('מערכת ניהול לקוחות חדשה', '2026-10-04', '#3b6fd8', 'החלפת מערכת ניהול הלקוחות הישנה', 1);
    const a = await task(P1, null, 'אפיון');
    const a1 = await task(P1, a, 'איסוף דרישות מהמחלקות', { d: 8, pct: 100, owner: 'דנה' });
    const a2 = await task(P1, a, 'כתיבת מסמך אפיון', { d: 6, pct: 100, owner: 'דנה' });
    const a3 = await task(P1, a, 'אישור אפיון', { ms: true, pct: 100 });
    const b = await task(P1, null, 'פיתוח');
    const b1 = await task(P1, b, 'תשתית ומסד נתונים', { d: 10, pct: 100, owner: 'יוסי', cost: 45000 });
    const b2 = await task(P1, b, 'מודול לקוחות', { d: 10, pct: 40, owner: 'יוסי', cost: 60000 });
    const b3 = await task(P1, b, 'מודול דוחות', { d: 8, pct: 5, owner: 'מיכל', cost: 30000 });
    const b4 = await task(P1, b, 'ממשק למערכת הכספים', { d: 7, pct: 30, owner: 'רועי', cost: 25000 });
    const c = await task(P1, null, 'בדיקות');
    const c1 = await task(P1, c, 'בדיקות פונקציונליות', { d: 8, owner: 'נועה' });
    const c2 = await task(P1, c, 'בדיקות עומסים', { d: 4, owner: 'נועה', notes: 'דורש את השרתים החדשים' });
    const c3 = await task(P1, c, 'תיקון ליקויים', { d: 6, owner: 'יוסי', deadline: '2026-12-08' });
    const e = await task(P1, null, 'הטמעה');
    const e1 = await task(P1, e, 'הסבת נתונים', { d: 5, owner: 'רועי' });
    const e2 = await task(P1, e, 'עלייה לאוויר', { ms: true, deadline: '2027-01-31' });
    await dep(a1, a2); await dep(a2, a3); await dep(a3, b1);
    await dep(b1, b2); await dep(b2, b3, 'SS', 4); await dep(b1, b4);
    await dep(b, c1); await dep(c1, c2, 'SS', 2); await dep(c1, c3);
    await dep(c3, e1); await dep(e1, e2);
    await dep(p3m, c2); // cross-project: load tests need the new servers

    // ---- Project 2 (training)
    const P2 = await proj('תוכנית הדרכה ארגונית', '2026-11-15', '#0f9d76', 'הדרכת המשתמשים על המערכת החדשה', 2);
    const t1 = await task(P2, null, 'הכנת חומרי הדרכה');
    const t11 = await task(P2, t1, 'כתיבת מערכי שיעור', { d: 10, owner: 'שירה' });
    const t12 = await task(P2, t1, 'הכנת סביבת תרגול', { d: 5, owner: 'שירה' });
    const t2 = await task(P2, null, 'ביצוע הדרכות');
    const t21 = await task(P2, t2, 'הדרכת מנהלים', { d: 3, owner: 'שירה' });
    const t22 = await task(P2, t2, 'הדרכת צוותים', { d: 8, owner: 'שירה' });
    const t3 = await task(P2, null, 'סיום הדרכות', { ms: true, deadline: '2026-12-31' });
    await dep(a3, t11);  // cross-project
    await dep(b2, t12);  // cross-project
    await dep(t1, t21); await dep(t21, t22); await dep(t22, t3);
    await dep(t22, e2);  // cross-project: go-live needs trained teams

    // baseline for project 1 as originally planned, then the customer module slipped by 2 days
    const sched = computeSchedule(await loadAll(tx));
    for (const t of sched.tasks.values()) {
      if (t.project_id !== P1) continue;
      await tx.query('UPDATE tasks SET baseline_start=$1, baseline_finish=$2 WHERE id=$3', [t.start, t.finish, t.id]);
    }
    await tx.query('UPDATE tasks SET duration=12 WHERE id=$1', [b2]);
    await tx.query(`INSERT INTO audit_log (user_name, entity, action, summary) VALUES ('מערכת','project','create','נטענו נתוני דוגמה')`);
  });
  return true;
}
