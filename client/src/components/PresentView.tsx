import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../ctx';
import type { Model } from '../model';
import type { Task } from '../types';
import { fmtDate, fmtLong, fmtMonth, toDay, daysText } from '../dates';
import { Icon } from './Icon';
import { OrgLogos } from './OrgLogos';

// Meeting-room view: four big numbers and a plain timeline of phases and milestones.
// Built to be read from across a room by people who don't use the system.

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem('gantraah.meet.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem('gantraah.meet.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

type Light = 'done' | 'ok' | 'risk' | 'late' | 'idle';
const LIGHT_TIP: Record<Light, string> = {
  ok: 'מתקדם לפי לוח הזמנים',
  risk: 'ההתקדמות המדווחת נמוכה ביותר מ-15 נקודות ממה שצפוי לפי התאריכים, ותאריך הסיום עוד לא עבר',
  late: 'תאריך הסיום עבר והמשימה לא הושלמה, או שהיא חורגת מתאריך יעד',
  done: 'הושלם (100%)',
  idle: 'מועד ההתחלה עוד לא הגיע',
};
const LIGHT_LABEL: Record<Light, string> = { done: 'הושלם', ok: 'בזמן', risk: 'בסיכון', late: 'באיחור', idle: 'טרם התחיל' };

/** traffic light for a task, looking at everything inside it */
function lightOf(m: Model, t: Task): Light {
  if (t.percent >= 100) return 'done';
  const all = [...m.subtree(t.id)].map((id) => m.task(id)!);
  if (all.some((x) => x.status === 'late' || x.deadline_missed)) return 'late';
  if (all.some((x) => x.status === 'behind')) return 'risk';
  if (t.status === 'planned') return 'idle';
  return 'ok';
}

interface MRow { projectId?: number; key: string; kind: 'project' | 'phase' | 'task' | 'milestone'; name: string; start: string; finish: string; pct: number; light: Light; color: string; depth: number; taskId?: number; hasKids: boolean }

export function PresentView() {
  const { model, user } = useApp();
  const [favOnly, setFavOnly] = useState<boolean>(() => ls.get('favOnly', false));
  useEffect(() => ls.set('favOnly', favOnly), [favOnly]);
  const favs = favOnly && user.unit_id != null ? model.favorites : null;
  // what to show: project ids "p:1" / phase ids "t:5"; empty = everything
  const [pick, setPick] = useState<string[]>(() => ls.get('pick', []));
  const [owners, setOwners] = useState<number[]>(() => ls.get('ownerFilter', []));
  const [stack, setStack] = useState<number[]>([]);           // details window: tasks opened, last = shown
  const [tourFocus, setTourFocus] = useState<number | null>(null); // phase opened by the guided tour
  // the guided tour demonstrates opening a phase
  useEffect(() => {
    const h = (e: Event) => {
      const what = (e as CustomEvent).detail;
      if (what === 'reset') { setTourFocus((f) => { if (f != null) setOpen(new Set()); return null; }); }
      if (what === 'open') {
        const ph = model.data.tasks.find((t) => t.parent_id == null && t.children.length > 0 && t.children.length <= 5);
        if (ph) { setOpen(new Set([ph.id])); setTourFocus(ph.id); }
      }
    };
    window.addEventListener('gantraah-tour', h);
    return () => window.removeEventListener('gantraah-tour', h);
  }, [model]);
  const [open, setOpen] = useState<Set<number>>(new Set());   // phases opened by clicking
  const [menu, setMenu] = useState(false);
  const [menuOut, setMenuOut] = useState(false);
  const menuTimer = useRef(0);
  const closeMenu = () => { setMenuOut(true); window.setTimeout(() => { setMenu(false); setMenuOut(false); }, 160); };
  const menuLeave = () => { clearTimeout(menuTimer.current); menuTimer.current = window.setTimeout(closeMenu, 1000); };
  const menuStay = () => { clearTimeout(menuTimer.current); setMenuOut(false); };
  useEffect(() => () => clearTimeout(menuTimer.current), []);
  // the divider between the four numbers and the timeline
  const [kpiH, setKpiH] = useState<number | null>(() => ls.get('kpiH', null));
  useEffect(() => ls.set('kpiH', kpiH), [kpiH]);
  const kpiRef = useRef<HTMLElement>(null);
  const startKpiDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY, h0 = kpiRef.current?.getBoundingClientRect().height || 150;
    document.body.classList.add('no-select', 'row-resizing');
    const mv = (ev: PointerEvent) => setKpiH(Math.max(64, Math.min(240, Math.round(h0 + ev.clientY - y0))));
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.classList.remove('no-select', 'row-resizing'); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, setFull] = useState(false);
  useEffect(() => ls.set('pick', pick), [pick]);
  useEffect(() => ls.set('ownerFilter', owners), [owners]);
  useEffect(() => { setOpen(new Set()); }, [pick.join(',')]);
  useEffect(() => {
    const h = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  const picks = pick.filter((k) => (k.startsWith('p:') ? model.project(Number(k.slice(2))) : model.task(Number(k.slice(2)))));
  const ownerIds = owners.filter((id) => model.units.has(id));
  const ownerOk = (id: number) => {
    if (!ownerIds.length) return true;
    // keep a task if it, or anything inside it, belongs to a chosen unit
    return [...model.subtree(id)].some((x) => { const o = model.effOwner(x).unit; return o != null && ownerIds.some((u) => model.unitWithin(o, u)); });
  };

  // ---- rows: projects > phases (top-level tasks) > on click, what's inside a phase
  const rows = useMemo(() => {
    const out: MRow[] = [];
    const taskRow = (t: Task, depth: number, phase: boolean): MRow => ({
      key: 't' + t.id, kind: t.kind === 'milestone' ? 'milestone' : phase ? 'phase' : 'task', name: t.name,
      start: t.start, finish: t.finish, pct: t.percent, light: lightOf(model, t),
      color: model.project(t.project_id)!.color, depth, taskId: t.id, hasKids: t.children.length > 0,
    });
    const addKids = (t: Task, depth: number) => {
      if (!open.has(t.id)) return;
      for (const c of t.children) {
        const k = model.task(c)!;
        if (!ownerOk(k.id)) continue;
        out.push(taskRow(k, depth, false));
        addKids(k, depth + 1);
      }
    };
    if (favs) {
      // favourites only: each starred task under its project, in date order
      for (const p of model.projectList) {
        const list = [...favs].map((id) => model.task(id)!).filter((t) => t && t.project_id === p.id && ownerOk(t.id))
          .sort((a, b) => a.start.localeCompare(b.start));
        if (!list.length) continue;
        out.push({ key: 'p' + p.id, kind: 'project', name: p.name, start: p.start, finish: p.finish, pct: p.percent, light: p.percent >= 100 ? 'done' : 'ok', color: p.color, depth: 0, hasKids: true, projectId: p.id });
        for (const t of list) { out.push(taskRow(t, 1, t.parent_id == null)); addKids(t, 2); }
      }
      return out;
    }
    for (const p of model.projectList) {
      const whole = !picks.length || picks.includes('p:' + p.id);
      const roots = p.roots.map((r) => model.task(r)!)
        .filter((t) => (whole || picks.includes('t:' + t.id)) && ownerOk(t.id));
      if (!roots.length) continue;
      const all = roots.flatMap((r) => [...model.subtree(r.id)].map((id) => model.task(id)!));
      const light: Light = p.percent >= 100 ? 'done' : all.some((x) => x.status === 'late' || x.deadline_missed) ? 'late'
        : all.some((x) => x.status === 'behind') ? 'risk' : 'ok';
      out.push({ key: 'p' + p.id, kind: 'project', name: p.name, start: p.start, finish: p.finish, pct: p.percent, light, color: p.color, depth: 0, hasKids: true, projectId: p.id });
      for (const t of roots) { out.push(taskRow(t, 1, true)); addKids(t, 2); }
    }
    return out;
    // eslint-disable-next-line
  }, [model, picks.join(','), open, ownerIds.join(','), favs]);

  // ---- the four numbers (over everything shown, including what is folded inside phases)
  const kpi = useMemo(() => {
    const ids = new Set<number>();
    for (const r of rows) if (r.taskId) for (const x of model.subtree(r.taskId)) ids.add(x);
    const tasks = [...ids].map((id) => model.task(id)!);
    const leaves = tasks.filter((t) => t.kind !== 'summary');
    const w = leaves.reduce((s, t) => s + (t.kind === 'milestone' ? 0 : t.work_days), 0);
    const pct = w ? Math.round(leaves.reduce((s, t) => s + t.percent * (t.kind === 'milestone' ? 0 : t.work_days), 0) / w) : 0;
    const finish = tasks.reduce((m, t) => (t.finish > m ? t.finish : m), '');
    const bl = tasks.reduce((m, t) => (t.baseline_finish && t.baseline_finish > m ? t.baseline_finish : m), '');
    const late = leaves.filter((t) => t.status === 'late' || t.deadline_missed).length;
    const risk = leaves.filter((t) => t.status === 'behind').length;
    const next = tasks.filter((t) => t.kind === 'milestone' && t.percent < 100 && t.finish >= model.data.today).sort((a, b) => a.finish.localeCompare(b.finish))[0];
    return { pct, finish, slip: bl && finish ? toDay(finish) - toDay(bl) : null, late, risk, next };
  }, [rows, model]);

  const title = favs ? 'המועדפים' : picks.length === 1
    ? (picks[0].startsWith('p:') ? model.project(Number(picks[0].slice(2)))!.name : model.task(Number(picks[0].slice(2)))!.name)
    : 'תכנית העבודה';

  const toggle = (r: MRow) => {
    if (!r.taskId || !r.hasKids) return;
    setOpen((s) => { const n = new Set(s); if (n.has(r.taskId!)) n.delete(r.taskId!); else n.add(r.taskId!); return n; });
  };
  // ticking a project ticks its phases; unticking a phase unticks its project (it is no longer whole)
  const phasesOf = (pid: number) => model.project(pid)!.roots.map((r) => model.task(r)!).filter((t) => t.kind !== 'milestone').map((t) => 't:' + t.id);
  const togglePick = (k: string) => setPick((s) => {
    const on = s.includes(k);
    if (k.startsWith('p:')) {
      const group = [k, ...phasesOf(Number(k.slice(2)))];
      return on ? s.filter((x) => !group.includes(x)) : [...new Set([...s, ...group])];
    }
    const pk = 'p:' + model.task(Number(k.slice(2)))!.project_id;
    if (on) return s.filter((x) => x !== k && x !== pk);
    const next = [...s, k];
    return phasesOf(Number(pk.slice(2))).every((x) => next.includes(x)) ? [...new Set([...next, pk])] : next;
  });
  // the same for units: a unit ticks the units below it, unticking one unticks the units above it
  const toggleOwner = (id: number) => setOwners((s) => {
    const sub = model.unitSubtree(id);
    const above: number[] = [];
    for (let x = model.units.get(id)?.parent_id ?? null; x != null; x = model.units.get(x)?.parent_id ?? null) above.push(x);
    if (s.includes(id)) return s.filter((x) => !sub.includes(x) && !above.includes(x));
    const next = new Set([...s, ...sub]);
    for (const a of above) if (model.unitSubtree(a).every((x) => x === a || next.has(x))) next.add(a);
    return [...next];
  });

  return (
    <div className={`page meet ${isFull ? 'full' : ''}`} ref={rootRef}>
      <header className="meet-head">
        <div className="meet-title">
          <OrgLogos size={48} />
          <div>
            <h1>{title}</h1>
            <div className="meet-date">מצב נכון ל-{fmtLong(model.data.today)}</div>

          </div>
        </div>
        <div className="meet-tools" data-tour="m-tools" onMouseLeave={() => menu && menuLeave()} onMouseEnter={menuStay}>
          {(picks.length > 0 || ownerIds.length > 0) && !favs && (
            <button className="btn small filter-on" onClick={() => { setPick([]); setOwners([]); }}
              title={[picks.length > 0 && 'מוצג רק מה שסומן ב"מה להציג"', ownerIds.length > 0 && 'מוצגות רק משימות של המסגרות שסומנו'].filter(Boolean).join(' · ')}>
              <Icon name="filter" size={14} /> נקה סינון
            </button>
          )}
          {favs && <button className="btn small fav-on" onClick={() => setFavOnly(false)} title="חזרה לכל התוכנית"><Icon name="star" size={14} fill="currentColor" /> מועדפים בלבד <Icon name="x" size={12} /></button>}
          <button className={`icon-btn ${menu ? 'on' : ''}`} title="הגדרות תצוגה" onClick={() => (menu ? closeMenu() : setMenu(true))}><Icon name="settings" size={19} /></button>
          <button className="icon-btn" title={isFull ? 'יציאה ממסך מלא' : 'מסך מלא'}
            onClick={() => (document.fullscreenElement ? document.exitFullscreen() : rootRef.current?.requestFullscreen())}><Icon name="expand" size={18} /></button>
          {menu && (
            <div className={`meet-menu ${menuOut ? 'out' : ''}`}>
              <div className="mm-head">
                <b>הגדרות תצוגה</b>
                <span className="mm-head-end">
                  {user.unit_id != null && (
                    <button className={`btn small ${favOnly ? 'fav-on' : ''}`} onClick={() => setFavOnly(!favOnly)} disabled={!model.favorites.size && !favOnly}
                      title={model.favorites.size ? `המשימות ש${user.display_name} סימנו בכוכב` : 'עוד אין מועדפים. מסמנים בכוכב שבחלון הפרטים של משימה.'}>
                      <Icon name="star" size={14} fill={favOnly ? 'currentColor' : undefined} /> {favOnly ? 'הצגת הכול' : 'הצגת מועדפים'}
                    </button>
                  )}
                  <button className="icon-btn" onClick={closeMenu} aria-label="סגירה"><Icon name="x" size={15} /></button>
                </span>
              </div>
              <div className="mm-cols">
                <div className="mm-sec">
                  <div className="mm-title">מה להציג {picks.length > 0 && <button className="link" onClick={() => setPick([])}>הכול</button>}</div>
                  <div className="mm-list">
                    {model.projectList.map((p) => (
                      <div key={p.id}>
                        <label className="mm-item strong">
                          <input type="checkbox" checked={picks.includes('p:' + p.id)} onChange={() => togglePick('p:' + p.id)} />
                          <span className="mt-chip" style={{ background: p.color }} />{p.name}
                        </label>
                        {p.roots.map((r) => model.task(r)!).filter((t) => t.kind !== 'milestone').map((t) => (
                          <label key={t.id} className="mm-item sub">
                            <input type="checkbox" checked={picks.includes('t:' + t.id)} onChange={() => togglePick('t:' + t.id)} />{t.name}
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                  <p className="mm-help">בלי סימון מוצג הכול. אפשר לסמן כמה פרויקטים או שלבים יחד.</p>
                </div>
                <div className="mm-sec">
                  <div className="mm-title">רק משימות של {ownerIds.length > 0 && <button className="link" onClick={() => setOwners([])}>כולם</button>}</div>
                  <div className="mm-list">
                    {model.unitTree().map(({ unit, depth }) => (
                      <label key={unit.id} className={`mm-item ${unit.kind !== 'team' ? 'strong' : ''}`} style={{ paddingInlineStart: 6 + depth * 16 }}>
                        <input type="checkbox" checked={owners.includes(unit.id)} onChange={() => toggleOwner(unit.id)} />{unit.name}
                      </label>
                    ))}
                  </div>
                  <p className="mm-help">מדור כולל גם את הצוותים שלו.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      <section className={`meet-kpis ${kpiH != null && kpiH < 110 ? 'compact' : ''}`} data-tour="m-kpis" ref={kpiRef}
        style={kpiH != null ? ({ height: kpiH, '--kz': Math.max(0.55, Math.min(1, kpiH / 150)) } as React.CSSProperties) : undefined}>
        <div className="mk">
          <span className="mk-label">התקדמות</span>
          <span className="mk-val">{kpi.pct}%</span>
          <div className="mk-bar"><i style={{ width: `${kpi.pct}%` }} /></div>
          <span className="mk-sub" title="ממוצע ההתקדמות של כל המשימות שבתצוגה. משימה ארוכה משפיעה יותר (לפי מספר ימי העבודה שלה). אבני דרך לא נספרות.">ממוצע של כל המשימות, לפי המשך שלהן</span>
        </div>
        <div className="mk">
          <span className="mk-label">סיום צפוי</span>
          <span className="mk-val">{fmtDate(kpi.finish)}</span>
          {kpi.slip != null && <span className={`mk-sub ${kpi.slip > 0 ? 'late' : 'ok'}`}>{kpi.slip > 0 ? `${daysText(kpi.slip)} אחרי התכנון` : kpi.slip < 0 ? `${daysText(kpi.slip)} לפני התכנון` : 'לפי התכנון'}</span>}
        </div>
        <div className={`mk ${kpi.late ? 'late' : kpi.risk ? 'risk' : 'ok'}`}>
          <span className="mk-label">דורש תשומת לב</span>
          <span className="mk-val">{kpi.late + kpi.risk}</span>
          <span className="mk-sub">{kpi.late + kpi.risk === 0 ? 'הכול מתקדם כמתוכנן' : [kpi.late && `${kpi.late} באיחור`, kpi.risk && `${kpi.risk} בסיכון`].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="mk">
          <span className="mk-label">אבן הדרך הבאה</span>
          {kpi.next ? <>
            <span className="mk-val small">{kpi.next.name}</span>
            <span className="mk-sub">{fmtLong(kpi.next.finish)}</span>
          </> : <span className="mk-sub">אין אבני דרך פתוחות</span>}
        </div>
      </section>

      <div className="kpi-split" onPointerDown={startKpiDrag} onDoubleClick={() => setKpiH(null)} title="גרירה משנה את הגובה של המספרים מול ציר הזמן. לחיצה כפולה מחזירה לגודל הרגיל." />

      <Timeline rows={rows} today={model.data.today} onToggle={toggle} open={open} model={model} tourFocus={tourFocus}
        onOpenTask={(from, id) => setStack(from === id ? [id] : [from, id])} />
      {stack.length > 0 && (
        <TaskDetails m={model} stack={stack} onOpen={(id) => setStack((st) => [...st, id])}
          onBack={() => setStack((st) => st.slice(0, -1))} onClose={() => setStack([])} />
      )}

      <footer className="meet-legend">
        {(['ok', 'risk', 'late', 'done', 'idle'] as Light[]).map((l) => <span key={l} title={LIGHT_TIP[l]}><i className={`dot-l ${l}`} />{LIGHT_LABEL[l]}</span>)}
        <span><svg width="16" height="16"><path d="M8 1l7 7-7 7-7-7z" fill="var(--g-ms)" /></svg>אבן דרך</span>
        <span className="legend-sep" />
        <span className="how"><HowHover />עמידה של שנייה על פס: מה משפיע עליו ומה מושפע ממנו</span>
        <span className="how"><HowClick />לחיצה על שם של שלב: פתיחת המשימות שבתוכו · לחיצה על פס: כרטיס המשימה</span>
      </footer>
    </div>
  );
}

/** Direct relations of a task, one card per other task. */
function directLinks(m: Model, id: number) {
  const rel = m.relations(id);
  const uniq = (list: typeof rel.drivers) => {
    const seen = new Map<number, (typeof list)[number]>();
    for (const r of list) if (!seen.has(r.other)) seen.set(r.other, r);
    return [...seen.values()];
  };
  return { up: uniq(rel.drivers), down: uniq(rel.driven) };
}

/** A small card for a related task. */
function LinkCard({ m, link, side, index, onOpen }: {
  m: Model; link: { dep: { type: string; lag: number }; other: number; via: number | null }; side: 'up' | 'down'; index: number; onOpen: (id: number) => void;
}) {
  const t = m.task(link.other);
  if (!t) return null;
  const light = lightOf(m, t);
  return (
    <button className={`lc ${side}`} style={{ animationDelay: `${60 + index * 55}ms` }} onClick={(e) => { e.stopPropagation(); onOpen(t.id); }}>
      <span className="lc-path">{m.path(t.id)}</span>
      <span className="lc-name">{t.kind === 'milestone' && <Icon name="diamond" size={11} />} {t.name}</span>
      <span className="lc-foot">
        <span className={`mt-light ${light}`}>{LIGHT_LABEL[light]}</span>
        <span>{fmtDate(t.finish)}</span>
      </span>
    </button>
  );
}

/** The cards that pop out of a row: affecting on the right, affected on the left. */
function LinkStrip({ m, taskId, onOpen }: { m: Model; taskId: number; onOpen: (id: number) => void }) {
  const { up, down } = directLinks(m, taskId);
  const t = m.task(taskId)!;
  return (
    <div className="ls">
      <div className="ls-side up">
        <div className="ls-title"><i className="dot up" />משפיעות עליה</div>
        <div className="ls-cards">
          {up.length ? up.map((l, i) => <LinkCard key={l.other} m={m} link={l} side="up" index={i} onOpen={onOpen} />)
            : <span className="ls-none">שום משימה לא משפיעה עליה</span>}
        </div>
      </div>
      <div className="ls-center">
        <span className="ls-arrow">←</span>
        <span className="ls-me">{t.name}</span>
        <span className="ls-arrow">←</span>
      </div>
      <div className="ls-side down">
        <div className="ls-title"><i className="dot down" />מושפעות ממנה</div>
        <div className="ls-cards">
          {down.length ? down.map((l, i) => <LinkCard key={l.other} m={m} link={l} side="down" index={i} onOpen={onOpen} />)
            : <span className="ls-none">שום משימה לא מחכה לה</span>}
        </div>
      </div>
    </div>
  );
}

/** Details window for one task, with its links; "הקודם" walks back through what was opened. */
function TaskDetails({ m, stack, onOpen, onBack, onClose }: {
  m: Model; stack: number[]; onOpen: (id: number) => void; onBack: () => void; onClose: () => void;
}) {
  const { user, toggleFavorite } = useApp();
  const id = stack[stack.length - 1];
  const t = m.task(id);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  if (!t) return null;
  const light = lightOf(m, t);
  const prev = stack.length > 1 ? m.task(stack[stack.length - 2]) : null;
  const owner = m.ownerName(t.id);
  return (
    <div className="td-bg" onClick={onClose}>
      <div className="td" key={id} onClick={(e) => e.stopPropagation()}>
        <div className="td-top">
          {prev ? <button className="btn" onClick={onBack}>› הקודם: {prev.name}</button> : <span />}
          <span className="td-tools">
            {user.unit_id != null && (
              <button className={`icon-btn star ${m.favorites.has(t.id) ? 'on' : ''}`} onClick={() => toggleFavorite(t.id)}
                title={m.favorites.has(t.id) ? 'הסרה מהמועדפים' : `הוספה למועדפים של ${user.display_name}`}>
                <Icon name="star" size={19} fill={m.favorites.has(t.id) ? 'currentColor' : undefined} />
              </button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="סגירה"><Icon name="x" size={18} /></button>
          </span>
        </div>
        <div className="td-path">{m.path(t.id)}</div>
        <h2 className="td-name">{t.kind === 'milestone' && <Icon name="diamond" size={18} />} {t.name}</h2>
        <div className="td-stats">
          <div><span>מצב</span><b><span className={`mt-light ${light}`}>{LIGHT_LABEL[light]}</span></b></div>
          <div><span>{t.kind === 'milestone' ? 'תאריך' : 'תאריכים'}</span><b>{t.kind === 'milestone' ? fmtDate(t.finish) : `${fmtDate(t.start)} – ${fmtDate(t.finish)}`}</b></div>
          {t.kind !== 'milestone' && <div><span>התקדמות</span><b>{t.percent}%</b></div>}
          {owner && <div><span>אחראי</span><b>{owner}</b></div>}
          {t.deadline && <div><span>תאריך יעד</span><b className={t.deadline_missed ? 'bad' : ''}>{fmtDate(t.deadline)}</b></div>}
        </div>
        {t.kind !== 'milestone' && <div className="mk-bar"><i style={{ width: `${t.percent}%` }} /></div>}
        <LinkStrip m={m} taskId={t.id} onOpen={onOpen} />
      </div>
    </div>
  );
}

/**
 * A plain timeline that always fits the screen width (no scrolling).
 * Hover a bar for 1 second: cards of what affects it pop out to its right (orange) and
 * what it affects to its left (purple). Clicking a card opens its details.
 */
function Timeline({ rows, today, onToggle, open, model, onOpenTask, tourFocus }: {
  rows: MRow[]; today: string; onToggle: (r: MRow) => void; open: Set<number>; model: Model; onOpenTask: (from: number, id: number) => void; tourFocus?: number | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(1000);
  const [pop, setPop] = useState<number | null>(null);        // row whose cards are open
  const armTimer = useRef<number>(0);
  const closeTimer = useRef<number>(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setPop(null); }, [rows]);
  // the guided tour demonstrates the cards on a row that has links on both sides
  useEffect(() => {
    const h = (e: Event) => {
      const what = (e as CustomEvent).detail;
      if (what === 'pop') {
        const score = (i: number) => { const l = directLinks(model, rows[i].taskId!); return (l.up.length ? 2 : 0) + (l.down.length ? 2 : 0) + (rows[i].kind === 'phase' ? 1 : 0); };
        const cands = rows.map((r, i) => i).filter((i) => rows[i].taskId != null && score(i) >= 2);
        if (cands.length) setPop(cands.sort((a, b) => score(b) - score(a))[0]);
      }
      if (what === 'reset' || what === 'open') setPop(null);
    };
    window.addEventListener('gantraah-tour', h);
    return () => window.removeEventListener('gantraah-tour', h);
  }, [rows, model]);
  useEffect(() => () => { clearTimeout(armTimer.current); clearTimeout(closeTimer.current); }, []);

  // hovering a bar for 1 second opens the cards next to it
  const enterBar = (i: number) => {
    clearTimeout(closeTimer.current);
    if (pop === i) return;
    clearTimeout(armTimer.current);
    if (rows[i].taskId == null) return;
    armTimer.current = window.setTimeout(() => setPop(i), 1000);
  };
  const leave = () => {
    clearTimeout(armTimer.current);
    clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setPop(null), 400);
  };
  const stay = () => clearTimeout(closeTimer.current);

  const NAME_W = Math.min(380, Math.max(240, w * 0.24));
  const chartW = Math.max(200, w - NAME_W);
  const t0 = toDay(today);
  let lo = t0, hi = t0;
  for (const r of rows) { lo = Math.min(lo, toDay(r.start)); hi = Math.max(hi, toDay(r.finish)); }
  const pad = Math.max(7, Math.round((hi - lo) * 0.04));
  lo -= pad; hi += pad;
  const span = Math.max(1, hi - lo + 1);
  const x = (day: number) => chartW - ((day - lo) / span) * chartW; // RTL: earlier on the right
  const ticks: { x1: number; x2: number; label: string }[] = [];
  const longPlan = span > 540;
  for (let d = lo; d <= hi;) {
    const dt = new Date(d * 86400000);
    const y = dt.getUTCFullYear(), mo = dt.getUTCMonth();
    const step = longPlan ? 3 - (mo % 3) : 1;
    const next = Math.floor(Date.UTC(y, mo + step, 1) / 86400000);
    const label = longPlan ? `רבעון ${Math.floor(mo / 3) + 1} ${y}` : `${fmtMonth(d)}${mo === 0 || d === lo ? ` ${y}` : ''}`;
    ticks.push({ x1: x(Math.min(next, hi + 1)), x2: x(d), label });
    d = next;
  }
  const ROW = 58;
  const heights = rows.map((r) => (r.kind === 'project' ? ROW - 6 : r.kind === 'task' ? ROW - 14 : ROW));
  const tops: number[] = [];
  let total = 0;
  for (const h of heights) { tops.push(total); total += h; }

  return (
    <div className="meet-timeline" ref={box} data-tour="m-timeline">
      <div className="mt-head" style={{ paddingInlineStart: NAME_W }}>
        <svg width={chartW} height={34}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={t.x1} x2={t.x1} y1={8} y2={34} className="mt-tick" />
              {t.x2 - t.x1 > 44 && <text x={(t.x1 + t.x2) / 2} y={24} className="mt-month">{t.label}</text>}
            </g>
          ))}
        </svg>
      </div>
      <div className="mt-body">
        {rows.map((r, i) => {
          const s = toDay(r.start), f = toDay(r.finish);
          const right = x(s), left = x(f + 1);
          const bw = Math.max(6, right - left);
          const isOpen = r.taskId != null && open.has(r.taskId);
          const h = heights[i];
          // name first, then progress and finish date (the project row already shows its name on the side)
          const label = r.kind === 'project' ? `${r.pct}%` : `${r.name} · ${r.pct}% · ${fmtDate(r.finish)}`;
          const inside = bw > label.length * 8.6 + 26;
          return (
            <div key={r.key} className={`mt-row k-${r.kind} ${r.hasKids && r.taskId ? 'clickable' : ''} ${pop === i ? 'popped' : ''} ${tourFocus != null && r.taskId != null && (r.taskId === tourFocus || model.ancestors(r.taskId).includes(tourFocus)) ? 'tour-hl' : ''}`}
              style={{ height: h }} onClick={() => (r.hasKids || r.taskId == null ? onToggle(r) : onOpenTask(r.taskId, r.taskId))}>
              <div className="mt-name" style={{ width: NAME_W, paddingInlineStart: 16 + r.depth * 22 }}>
                {r.kind === 'project' && <span className="mt-chip" style={{ background: r.color }} />}
                {r.hasKids && r.taskId != null && <Icon name="chevronDown" size={16} className={`mt-tog ${isOpen ? '' : 'closed'}`} />}
                <span className="mt-text">{r.name}</span>
                <span className={`mt-light ${r.light}`}>{LIGHT_LABEL[r.light]}</span>
              </div>
              <svg width={chartW} height={h} className="mt-chart">
                {ticks.map((t, k) => <line key={k} x1={t.x1} x2={t.x1} y1={0} y2={h} className="mt-grid" />)}
                {r.kind === 'milestone' ? (
                  <g className="mt-hit" onMouseEnter={() => enterBar(i)} onMouseLeave={leave}
                    onClick={(e) => { if (r.taskId != null) { e.stopPropagation(); clearTimeout(armTimer.current); setPop(null); onOpenTask(r.taskId, r.taskId); } }}>
                    <path transform={`translate(${left}, ${h / 2})`} d="M0,-13L13,0L0,13L-13,0Z" className={`mt-ms ${r.light}`} />
                    <text x={left - 20} y={h / 2} dy="0.35em" className="mt-label out">{`${r.name} · ${fmtDate(r.finish)}`}</text>
                  </g>
                ) : (
                  <g className="mt-hit" onMouseEnter={() => enterBar(i)} onMouseLeave={leave}
                    onClick={(e) => { if (r.taskId != null) { e.stopPropagation(); clearTimeout(armTimer.current); setPop(null); onOpenTask(r.taskId, r.taskId); } }}>
                    <rect x={left} y={h * 0.2} width={bw} height={h * 0.6} rx={8} className={`mt-bar ${r.light}`} />
                    <rect x={right - (bw * r.pct) / 100} y={h * 0.2} width={(bw * r.pct) / 100} height={h * 0.6} rx={8} className={`mt-fill ${r.light}`} />
                    {inside
                      ? <text x={right - 12} y={h / 2} dy="0.35em" className={`mt-label ${r.pct >= 25 ? 'in' : 'in-dark'}`}>{label}</text>
                      : <text x={left - 10} y={h / 2} dy="0.35em" className="mt-label out">{label}</text>}
                  </g>
                )}
              </svg>
            </div>
          );
        })}
        <div className="mt-today" style={{ insetInlineStart: NAME_W + (chartW - x(t0)) }}><span>היום</span></div>
        {pop != null && rows[pop]?.taskId != null && (() => {
          // affecting tasks stack to the right of the bar, affected ones to its left
          const r = rows[pop];
          const { up, down } = directLinks(model, r.taskId!);
          let bR = x(toDay(r.start)), bL = x(toDay(r.finish) + 1);
          if (r.kind === 'milestone') { const c = bL; bR = c + 14; bL = c - 14; }
          const CW = 236, CH = 92, GAP = 14;
          const cy = tops[pop] + heights[pop] / 2;
          const topFor = (n: number) => Math.max(4, Math.min(Math.max(4, total - n * CH - 4), cy - (n * CH) / 2));
          // affecting cards right of the bar, affected cards left of it. They may float over the
          // names column; near an edge they are pushed apart so the two stacks never touch.
          let upLeft = Math.min(w - CW - 8, bR + 10);
          let downLeft = Math.max(8, bL - 10 - CW);
          if (up.length && down.length && upLeft < downLeft + CW + GAP) {
            const need = downLeft + CW + GAP - upLeft;
            const roomLeft = downLeft - 8, roomRight = w - CW - 8 - upLeft;
            const toLeft = Math.min(roomLeft, Math.ceil(need / 2) + Math.max(0, Math.ceil(need / 2) - roomRight));
            downLeft -= toLeft;
            upLeft += need - toLeft;
          }
          const open = (id: number) => { const from = r.taskId!; setPop(null); onOpenTask(from, id); };
          return (
            <div className="mt-float">
              {up.length > 0 && (
                <div className="mt-stack" style={{ left: upLeft, top: topFor(up.length), width: CW }} onMouseEnter={stay} onMouseLeave={leave}>
                  {up.map((l, k) => <LinkCard key={l.other} m={model} link={l} side="up" index={k} onOpen={open} />)}
                </div>
              )}
              {down.length > 0 && (
                <div className="mt-stack" style={{ left: downLeft, top: topFor(down.length), width: CW }} onMouseEnter={stay} onMouseLeave={leave}>
                  {down.map((l, k) => <LinkCard key={l.other} m={model} link={l} side="down" index={k} onOpen={open} />)}
                </div>
              )}
            </div>
          );
        })()}
      </div>
      {!rows.length && <p className="muted" style={{ padding: 30, textAlign: 'center' }}>אין מה להציג</p>}
    </div>
  );
}

/** mouse pointer, drawn the way it looks on screen */
const POINTER = 'M0,0 L0,13 L3.2,10 L5.6,15.2 L7.8,14.2 L5.5,9.2 L9.6,9.2 Z';

/** legend picture: the pointer resting on a bar, with a small clock (one second) */
function HowHover() {
  return (
    <svg width="46" height="26" viewBox="0 0 46 26" className="how-pic" aria-hidden="true">
      <rect x="2" y="7" width="34" height="11" rx="4" fill="#c9ecd4" />
      <rect x="18" y="7" width="18" height="11" rx="4" fill="#22a35a" />
      <g transform="translate(15,10)"><path d={POINTER} fill="var(--g-ms)" stroke="var(--surface)" strokeWidth="1.2" strokeLinejoin="round" /></g>
      <circle cx="39" cy="7" r="6" fill="var(--surface)" stroke="var(--text-2)" strokeWidth="1.4" />
      <path d="M39 4v3.2l2 1.3" fill="none" stroke="var(--text-2)" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** legend picture: a phase row clicked open, with the rows that appear under it */
function HowClick() {
  return (
    <svg width="46" height="28" viewBox="0 0 46 28" className="how-pic" aria-hidden="true">
      <rect x="1" y="1" width="44" height="11" rx="3" fill="var(--primary-soft)" stroke="var(--border-strong)" />
      <path d="M36 5l3 3 3-3" fill="none" stroke="var(--g-ms)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="6" y="4.5" width="24" height="4" rx="2" fill="var(--muted)" />
      <rect x="6" y="15" width="32" height="5" rx="2" fill="var(--g-faded)" />
      <rect x="6" y="22" width="26" height="5" rx="2" fill="var(--g-faded)" />
      <g transform="translate(24,6)"><path d={POINTER} fill="var(--g-ms)" stroke="var(--surface)" strokeWidth="1.2" strokeLinejoin="round" /></g>
    </svg>
  );
}
