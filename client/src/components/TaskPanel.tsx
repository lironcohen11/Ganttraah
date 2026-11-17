import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import { STATUS_LABEL, DEP_LABEL, depText, doneCount, delayLabel } from '../model';
import type { AuditEntry, DepType } from '../types';
import { fmtDate, fmtDateTime, toDay, fromDay, daysText } from '../dates';
import { Icon } from './Icon';
import { TaskPicker } from './TaskPicker';


function Field({ label, children, hint, info }: { label: string; children: React.ReactNode; hint?: React.ReactNode; info?: string }) {
  return (
    <label className="field">
      <span className="f-label">{label}{info && <span className="f-info" title={info}><Icon name="info" size={13} /></span>}</span>
      {children}
      {hint && <span className="f-hint">{hint}</span>}
    </label>
  );
}

/** Input that commits on blur / Enter. */
function Commit({ value, onCommit, type = 'text', disabled, min, max, className, placeholder }: {
  value: string | number; onCommit: (v: string) => unknown; type?: string; disabled?: boolean; min?: number; max?: number; className?: string; placeholder?: string;
}) {
  const { remote } = useApp();
  const [v, setV] = useState(String(value ?? ''));
  // someone else saved this field while it is being typed in: keep what was typed, and ask
  const editing = useRef(false);
  const base = useRef(String(value ?? '')); // the saved value the typing started from
  const [theirs, setTheirs] = useState<{ value: string; by: string } | null>(null);
  useEffect(() => {
    const nv = String(value ?? '');
    if (editing.current && v !== base.current && nv !== base.current && nv !== v) setTheirs({ value: nv, by: remote?.by || '' });
    else { setV(nv); setTheirs(null); }
    base.current = nv;
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = useRef(value);
  latest.current = value;
  // nothing saved (cancelled, refused): the field shows the saved value again
  const send = (x: string) => Promise.resolve(onCommit(x)).then((r) => { if (r === undefined) setV(String(latest.current ?? '')); });
  const commit = () => { if (!theirs && v !== String(value ?? '')) send(v); };
  // A date typed on the keyboard is valid after every digit (typing "15" passes through "01"), so it is
  // saved only on leaving the field or Enter. A date picked in the calendar is saved at once.
  const typing = useRef(false);
  return (<>
    <input className={className} type={type} value={v} disabled={disabled} min={min} max={max} placeholder={placeholder}
      onFocus={() => { editing.current = true; base.current = String(latest.current ?? ''); }}
      onChange={(e) => {
        setV(e.target.value);
        if (type === 'date' && !typing.current && e.target.value && e.target.value !== String(value ?? '')) send(e.target.value);
      }}
      onBlur={() => { editing.current = false; typing.current = false; commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && type !== 'textarea') { (e.target as HTMLInputElement).blur(); return; }
        if (type === 'date' && e.key !== 'Tab') typing.current = true;
      }} />
    {theirs && (
      <span className="edit-clash" role="alert" title={type === 'date' ? fmtDate(theirs.value) : theirs.value}>
        <span className="ec-text">{theirs.by || 'מישהו אחר'} שמר/ה: <b>{type === 'date' ? fmtDate(theirs.value) : theirs.value || '(ריק)'}</b></span>
        <button type="button" className="link" onMouseDown={(e) => e.preventDefault()} onClick={() => { const mine = v; setTheirs(null); send(mine); }}>לשמור את שלי</button>
        <span className="ec-sep">·</span>
        <button type="button" className="link" onMouseDown={(e) => e.preventDefault()} onClick={() => { setV(theirs.value); setTheirs(null); }}>לקחת את שלהם</button>
      </span>
    )}
  </>);
}

const fMonthHead = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/**
 * A date field with a calendar of our own (the browser's own calendar cannot colour days): the days
 * the task can move to without moving anything else (its free slack) are marked green. Typing in the
 * field works as before; picking a day saves at once.
 */
function DatePick({ value, onCommit, disabled, safeFrom, safeUntil, minDay }: {
  value: string; onCommit: (v: string) => unknown; disabled?: boolean; safeFrom?: string | null; safeUntil?: string | null; minDay?: number;
}) {
  const { model } = useApp();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [ym, setYm] = useState(() => ({ y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)) - 1 }));
  const ref = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', h);
    window.addEventListener('keydown', k, true);
    return () => { document.removeEventListener('mousedown', h); window.removeEventListener('keydown', k, true); };
  }, [open]);
  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = ref.current!.getBoundingClientRect();
    setYm({ y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)) - 1 });
    setPos({ top: Math.min(r.bottom + 6, window.innerHeight - 330), left: Math.max(8, r.right - 268) });
    setOpen(true);
  };
  const first = Date.UTC(ym.y, ym.m, 1) / 86400000, days = new Date(Date.UTC(ym.y, ym.m + 1, 0)).getUTCDate();
  const lead = new Date(first * 86400000).getUTCDay();
  const safe = safeFrom && safeUntil && safeUntil > safeFrom ? [toDay(safeFrom), toDay(safeUntil)] : null;
  const step = (n: number) => setYm(({ y, m }) => ({ y: y + Math.floor((m + n) / 12), m: ((m + n) % 12 + 12) % 12 }));
  return (
    <span className="dp" ref={ref}>
      <Commit type="date" value={value} disabled={disabled} onCommit={onCommit} />
      {!disabled && <button type="button" className={`dp-btn ${open ? 'on' : ''}`} onClick={toggle} aria-label="בחירה מלוח השנה"><Icon name="calendar" size={15} /></button>}
      {open && pos && (
        <div className="dp-pop" ref={pop} style={{ top: pos.top, left: pos.left }}>
          <div className="dp-head">
            <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label="החודש הקודם"><Icon name="chevronRight" size={15} /></button>
            <b>{fMonthHead.format(new Date(first * 86400000))}</b>
            <button type="button" className="icon-btn" onClick={() => step(1)} aria-label="החודש הבא"><Icon name="chevronLeft" size={15} /></button>
          </div>
          <div className="dp-grid">
            {['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'].map((d) => <span key={d} className="dp-wd">{d}</span>)}
            {Array.from({ length: lead }, (_, i) => <span key={'b' + i} />)}
            {Array.from({ length: days }, (_, i) => {
              const day = first + i, iso = fromDay(day);
              const inSafe = !!safe && day > safe[0] && day <= safe[1];
              const cls = ['dp-day', !model.cal.isWork(day) && 'off', iso === value && 'cur', inSafe && 'safe',
                inSafe && day === safe![1] && 'safe-end', inSafe && day === safe![0] + 1 && 'safe-start'].filter(Boolean).join(' ');
              return (
                <button type="button" key={iso} className={cls} disabled={minDay != null && day < minDay}
                  onClick={() => { setOpen(false); if (iso !== value) onCommit(iso); }}>{i + 1}</button>
              );
            })}
          </div>
          <div className="dp-note">
            {safe ? <><span className="dp-swatch" /> עד <b>{fmtDate(safeUntil)}</b> אפשר לדחות בלי להזיז משימות אחרות</>
              : <span className="muted">אין מרווח: כל דחייה תזיז משימות אחרות או את סוף הפרויקט</span>}
          </div>
        </div>
      )}
    </span>
  );
}

/**
 * A small moment of joy when a task is marked done: a burst of little confetti from the button,
 * gone in under a second. Nothing for people who asked for less motion.
 */
function celebrate(from: HTMLElement) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const r = from.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.className = 'confetti';
  layer.style.left = `${r.left + r.width / 2}px`;
  layer.style.top = `${r.top + r.height / 2}px`;
  const colors = ['#2f5bd3', '#16a34a', '#f59e0b', '#e11d48', '#8b5cf6', '#06b6d4'];
  for (let i = 0; i < 18; i++) {
    const p = document.createElement('i');
    const a = (Math.PI * 2 * i) / 18 + (Math.random() - 0.5) * 0.5, dist = 42 + Math.random() * 38;
    p.style.setProperty('--x', `${Math.cos(a) * dist}px`);
    p.style.setProperty('--y', `${Math.sin(a) * dist - 18}px`);
    p.style.setProperty('--r', `${Math.round(Math.random() * 540 - 270)}deg`);
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.random() * 60}ms`;
    if (i % 3 === 0) p.style.borderRadius = '50%';
    layer.appendChild(p);
  }
  document.body.appendChild(layer);
  setTimeout(() => layer.remove(), 1100);
}

/**
 * The name of the person in the owner unit (not required, free text): closed until asked for. When there is a
 * name it shows as one line; clicking it edits it. An empty name closes the field again.
 */
function OwnerName({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => unknown }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  useEffect(() => { if (!editing) setV(value); }, [value, editing]);
  const done = () => { setEditing(false); const x = v.trim(); if (x !== value) onSave(x); };
  if (editing) {
    return (
      <div className="owner-name">
        <input autoFocus value={v} maxLength={200} placeholder="למשל: שם חבר הצוות" aria-label="שם האחראי"
          onChange={(e) => setV(e.target.value)} onBlur={done}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setV(value); setEditing(false); } }} />
      </div>
    );
  }
  if (value) {
    return (
      <div className="owner-name">
        <Icon name="user" size={13} />
        {editable ? <button className="link owner-name-val" onClick={() => setEditing(true)} title="שינוי שם האחראי">{value}</button> : <span>{value}</span>}
      </div>
    );
  }
  if (!editable) return null;
  return <button className="link small owner-name-add" onClick={() => setEditing(true)}>+ שם האחראי <span className="muted">(לא חובה)</span></button>;
}

export function TaskPanel({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const { model, user, canEdit, canEditTask, assignable, isAdmin, run, focusTask, openTask, toggleFavorite, setViewing, viewersOf, remote } = useApp();
  // tell the others which card this tab shows
  useEffect(() => { setViewing(taskId); return () => setViewing(null); }, [taskId, setViewing]);
  // the card can be dragged sideways by the grip in its head (it is as tall as the plan, so only sideways);
  // the place is kept for the next card too
  const panelRef = useRef<HTMLElement>(null);
  const [panelX, setPanelX] = useState<number>(() => { try { return Number(localStorage.getItem('gantraah.panelX')) || 0; } catch { return 0; } });
  useEffect(() => { try { localStorage.setItem('gantraah.panelX', String(panelX)); } catch { /* ignore */ } }, [panelX]);
  const maxX = () => { const el = panelRef.current, box = el?.parentElement; return el && box ? Math.max(0, box.clientWidth - el.offsetWidth - 20) : 0; };
  useEffect(() => { const m = maxX(); if (panelX > m) setPanelX(m); }); // the window got narrower: stay inside
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX, from = panelX, m = maxX();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('no-select', 'panel-dragging');
    const move = (ev: PointerEvent) => setPanelX(Math.round(Math.min(m, Math.max(0, from + ev.clientX - x0))));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); document.body.classList.remove('no-select', 'panel-dragging'); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const t = model.task(taskId);
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [notes, setNotes] = useState(t?.notes || '');
  const [histOpen, setHistOpen] = useState(false);
  // the description, like the other fields: someone else's change does not wipe out what is being typed
  const notesEditing = useRef(false);
  const notesBase = useRef(t?.notes || '');
  const [notesTheirs, setNotesTheirs] = useState<{ value: string; by: string } | null>(null);
  useEffect(() => {
    const nv = t?.notes || '';
    if (notesEditing.current && notes !== notesBase.current && nv !== notesBase.current && nv !== notes) setNotesTheirs({ value: nv, by: remote?.by || '' });
    else { setNotes(nv); setNotesTheirs(null); }
    notesBase.current = nv;
  }, [t?.notes, taskId]); // eslint-disable-line react-hooks/exhaustive-deps

  // a change someone else made while the card is open: say who changed what, and light up those fields
  const [changed, setChanged] = useState<{ by: string; items: string[]; fields: string[]; cause: string | null; keys: Set<string> } | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const [changedOpen, setChangedOpen] = useState(false);
  const seen = useRef<{ id: number; snap: Record<string, string> } | null>(null);
  const usedSeq = useRef(0);
  useEffect(() => {
    if (!t) return;
    const unitName = (id: number | null) => (id == null ? 'ללא' : model.units.get(id)?.name || '');
    const deps = [...(model.depsIn.get(t.id) || []), ...(model.depsOut.get(t.id) || [])].map((d) => `${d.id}:${d.type}:${d.lag}`).sort().join(',');
    const snap: Record<string, string> = {
      name: t.name, notes: t.notes || '', kind: t.input_kind, start: t.start, finish: t.finish, duration: String(t.work_days),
      owner: unitName(t.owner_unit_id), done: t.percent >= 100 ? 'הושלמה' : 'לא הושלמה', deps,
    };
    const prev = seen.current;
    seen.current = { id: t.id, snap };
    if (!prev || prev.id !== t.id) { setChanged(null); return; }
    if (!remote || remote.seq === usedSeq.current || Date.now() - remote.at > 10000) return; // my own change, or nothing new
    const label: Record<string, string> = { name: 'שם', notes: 'תיאור', kind: 'סוג', start: 'התחלה', finish: 'סיום', duration: 'משך', owner: 'אחראי', done: 'ביצוע', deps: 'תלויות' };
    const show = (k: string, x: string) => (k === 'start' || k === 'finish' ? fmtDate(x) : k === 'duration' ? `${x} ימים` : k === 'kind' ? (x === 'milestone' ? 'אבן דרך' : 'משימה') : x);
    const keys = Object.keys(snap).filter((k) => snap[k] !== prev.snap[k]);
    if (!keys.length) return;
    usedSeq.current = remote.seq;
    const items = keys.map((k) => (k === 'notes' || k === 'deps' ? `${label[k]} עודכנו` : `${label[k]}: ${show(k, prev.snap[k]) || '—'} ← ${show(k, snap[k]) || '—'}`));
    setChangedOpen(false);
    setChanged({ by: remote.by, items, fields: keys.map((k) => label[k]), cause: remote.task_id != null && remote.task_id !== t.id ? remote.summary : null, keys: new Set(keys) });
    setFlash(new Set(keys));
    const timer = window.setTimeout(() => setFlash(new Set()), 2600);
    return () => clearTimeout(timer);
  }, [t, model, remote]); // eslint-disable-line react-hooks/exhaustive-deps
  const others = viewersOf(taskId);
  const othersText = (() => {
    const n = new Map<string, number>();
    for (const x of others) n.set(x, (n.get(x) || 0) + 1);
    return [...n].map(([name, k]) => (k > 1 ? `${name} (${k})` : name)).join(', ');
  })();
  // the description box is as tall as its text (grows and shrinks while typing)
  const descRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = descRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [notes, taskId]);
  useEffect(() => {
    let live = true;
    api.get<AuditEntry[]>(`/history?task_id=${taskId}&limit=8`).then((h) => live && setHistory(h)).catch(() => {});
    return () => { live = false; };
  }, [taskId, model]);

  const rel = useMemo(() => (t ? model.relations(t.id) : { drivers: [], driven: [] }), [model, t]);
  const excludeLinks = useMemo(() => {
    if (!t) return new Set<number>();
    const s = new Set<number>([...model.subtree(t.id), ...model.ancestors(t.id)]);
    for (const r of [...rel.drivers, ...rel.driven]) if (!r.via) s.add(r.other);
    return s;
  }, [model, t, rel]);
  // any unit may link any two tasks (the owners of both are told, in the bell)
  const excludeDriven = excludeLinks;

  if (!t) return null;
  const pr = model.project(t.project_id)!;
  const isSummary = t.kind === 'summary';
  const ed = canEditTask(t.id);
  const own = model.effOwner(t.id);
  const ownUnit = own.unit != null ? model.units.get(own.unit) : undefined;
  const save = (patch: Record<string, unknown>) => run(() => api.patch(`/tasks/${t.id}`, patch));
  const drivingNames = rel.drivers.filter((r) => t.driving_dep_ids.includes(r.dep.id)).map((r) => model.task(r.other)?.name).filter(Boolean);
  const anc = model.ancestors(t.id).reverse();

  // status in plain words, and where it comes from
  const isMs = t.kind === 'milestone';
  const statusLabel = isMs
    ? ({ done: 'הושגה', late: 'התאריך עבר', planned: 'מתוכננת', active: 'מתוכננת', behind: 'מתוכננת' } as const)[t.status]
    : STATUS_LABEL[t.status];
  const statusExplain = t.status === 'late'
    ? isMs
      ? `התאריך של אבן הדרך (${fmtDate(t.finish)}) כבר עבר, והיא עוד לא סומנה כהושגה. אם היא הושגה, לחצו "סמן כהושגה".`
      : `תאריך הסיום המתוכנן (${fmtDate(t.finish)}) כבר עבר, והמשימה עוד לא סומנה כהושלמה.`
    : t.status === 'done' ? 'מסומנת כהושלמה.'
      : t.status === 'planned' ? `עוד לא הגיע מועד ההתחלה (${fmtDate(t.start)}).`
      : `בביצוע: מתוכננת להסתיים ב-${fmtDate(t.finish)}.`;
  const kidsDone = isSummary ? doneCount(model, [t.id]) : null;

  const depRow = (r: { dep: { id: number; type: DepType; lag: number }; other: number; via: number | null }, side: 'up' | 'down') => {
    const o = model.task(r.other);
    if (!o) return null;
    const direct = !r.via;
    const driving = side === 'up' && t.driving_dep_ids.includes(r.dep.id);
    return (
      <div key={r.dep.id + '-' + r.other} className={`dep-row ${side}`}>
        <button className="dep-task" onClick={() => openTask(o.id)} title="פתח את המשימה">
          <span className="proj-chip" style={{ background: model.project(o.project_id)?.color }} />
          <span className="dep-name">{o.name}</span>
          <span className="dep-path">{model.path(o.id)}</span>
        </button>
        <div className="dep-meta">
          {direct && (ed || canEditTask(r.other)) ? (
            <>
              <select value={r.dep.type} onChange={(e) => run(() => api.patch(`/dependencies/${r.dep.id}`, { type: e.target.value }))}>
                {Object.entries(DEP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <Commit className="lag" type="number" value={r.dep.lag} onCommit={(v) => run(() => api.patch(`/dependencies/${r.dep.id}`, { lag: Number(v) || 0 }))} />
              <span className="unit">ימים</span>
              <button className="icon-btn danger" title="הסר תלות" onClick={() => run(() => api.del(`/dependencies/${r.dep.id}`), 'התלות הוסרה')}><Icon name="x" size={14} /></button>
            </>
          ) : (
            <span className="dep-type">{depText(r.dep.type, r.dep.lag)}</span>
          )}
          {driving && <span className="chip drive" title="התלות הזו היא שקובעת את מועד ההתחלה">קובעת את התאריך</span>}
          {r.via && <span className="chip via">דרך "{model.task(r.via)?.name}"</span>}
        </div>
      </div>
    );
  };

  return (
    <aside className="panel" ref={panelRef} onClick={(e) => e.stopPropagation()} style={{ left: 10 + panelX }}>
      {/* the whole top strip drags the card; the arrows on both sides say it moves sideways only */}
      <div className="panel-drag" onPointerDown={startDrag} onDoubleClick={() => setPanelX(0)} role="separator" aria-orientation="vertical" aria-label="הזזת הכרטיס ימינה או שמאלה">
        <span className="pd-arrow r"><Icon name="chevronRight" size={13} /></span>
        <span className="pd-dots"><Icon name="grip" size={16} /></span>
        <span className="pd-arrow l"><Icon name="chevronLeft" size={13} /></span>
      </div>
      <div className="panel-head" onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('button, a, input, select, textarea, .viewers-badge')) startDrag(e); }}
        onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button, a, input')) setPanelX(0); }}>
        <div className="crumbs">
          <span className="proj-chip" style={{ background: pr.color }} />
          <span>{pr.name}</span>
          {anc.map((a) => <span key={a} className="crumb-sep">›<button onClick={() => openTask(a)}>{model.task(a)!.name}</button></span>)}
        </div>
        {others.length > 0 && (
          <span className="viewers-badge" title={`הכרטיס פתוח עכשיו גם אצל: ${othersText}`} aria-label={`פתוח עכשיו גם אצל ${others.length}`}>
            <Icon name="eye" size={15} /> {others.length}
          </span>
        )}
        {user.unit_id != null && (
          <button className={`icon-btn star ${model.favorites.has(t.id) ? 'on' : ''}`} onClick={() => toggleFavorite(t.id)}
            title={model.favorites.has(t.id) ? 'הסרה מהמועדפים' : `הוספה למועדפים של ${user.display_name}`}>
            <Icon name="star" size={17} fill={model.favorites.has(t.id) ? 'currentColor' : undefined} />
          </button>
        )}
        <button className="icon-btn" onClick={onClose} aria-label="סגור"><Icon name="x" /></button>
      </div>

      <div className="panel-body">
        {changed && (
          <div className={`changed-box ${changedOpen ? 'open' : ''}`} role="status">
            <div className="changed-line">
              <Icon name="alert" size={13} />
              <button className="cl-text" onClick={() => setChangedOpen(!changedOpen)} aria-expanded={changedOpen} title={changedOpen ? 'הסתרת הפרטים' : 'מה השתנה?'}>
                <b>{changed.by || 'מישהו אחר'}</b> {changed.cause ? 'שינה/תה משימה אחרת, והשתנה כאן' : 'שינה/תה'}: {changed.fields.join(', ')}
              </button>
              <button className="cl-x cl-more" onClick={() => setChangedOpen(!changedOpen)} aria-label={changedOpen ? 'הסתרת הפרטים' : 'מה השתנה?'}>
                <Icon name="chevronDown" size={13} />
              </button>
              <button className="cl-x" onClick={() => setChanged(null)} aria-label="סגירה"><Icon name="x" size={12} /></button>
            </div>
            {changedOpen && (
              <div className="changed-more">
                <ul>{changed.items.map((x) => <li key={x}>{x}</li>)}</ul>
                {changed.cause && <p>בעקבות: {changed.cause}</p>}
              </div>
            )}
          </div>
        )}
        <div className={`title-row ${flash.has('name') ? 'just-changed' : ''}`}>
          <span className="wbs-tag" title={`מספר המשימה בתכנית: ${t.wbs}. המספר משקף את המיקום בהיררכיה (למשל 2.3 = המשימה השלישית בתוך משימה 2), כמו בעמודה # בטבלה.`}>{t.wbs}</span>
          {ed ? <Commit className="title-input" value={t.name} onCommit={(v) => v.trim() && save({ name: v.trim() })} />
            : <h2 className="title-ro">{t.name}</h2>}
        </div>
        {!ed && canEdit && (
          <p className="ro-banner"><Icon name="eye" size={14} /> צפייה בלבד: המשימה באחריות <b>{ownUnit?.name || 'הנהלת הענף'}</b>. אפשר לערוך רק משימות של היחידה שלך ושל היחידות שמתחתיה.</p>
        )}
        <div className="chips">
          {t.kind === 'milestone' && <span className="chip"><Icon name="diamond" size={11} /> אבן דרך</span>}
          {isSummary && <span className="chip">אב-משימה · {t.children.length} תתי-משימות</span>}
          <span className={`chip st-${t.status}`} title={statusExplain}>{statusLabel}</span>
          {t.critical && <span className="chip crit" title="כל עיכוב במשימה הזו מזיז את סיום הפרויקט">בנתיב הקריטי</span>}
          {model.crossProject(t.id) && <span className="chip"><Icon name="link" size={12} /> קשורה לפרויקט אחר</span>}
        </div>
        {statusExplain && t.status === 'late' && <p className="small bad status-why">{statusExplain}</p>}
        {(() => {
          const d = model.delays.get(t.id);
          if (!d) return null;
          const cause = d.cause_task_id != null ? model.task(d.cause_task_id) : null;
          return (
            <div className="delay-box">
              <div className="delay-box-head"><Icon name="calendar" size={14} /> נדחתה ב-<bdi>{fmtDate(d.at.slice(0, 10))}</bdi>{d.from_finish && d.to_finish ? <span className="muted"> · הסיום זז מ-<bdi>{fmtDate(d.from_finish)}</bdi> ל-<bdi>{fmtDate(d.to_finish)}</bdi></span> : null}</div>
              {d.cause_task_id != null ? (
                <div>בעקבות דחייה של {cause
                  ? <button className="link" onClick={() => openTask(cause.id)}>"{cause.name}" ›</button>
                  : <b>משימה שנמחקה</b>}{d.reason ? <span className="muted"> · סיבה: {delayLabel(d.reason, d.reason_other)}</span> : null}</div>
              ) : (
                <div><b>סיבה: {delayLabel(d.reason, d.reason_other)}</b>{d.user_name ? <span className="muted"> · {d.user_name}</span> : null}</div>
              )}
              {d.description && <p className="delay-box-desc">{d.description}</p>}
            </div>
          );
        })()}

        <textarea className={`desc ${flash.has('notes') ? 'just-changed' : ''}`} ref={descRef} value={notes} disabled={!ed} placeholder={ed ? 'תיאור המשימה…' : 'אין תיאור'} aria-label="תיאור המשימה" rows={1}
          onFocus={() => { notesEditing.current = true; notesBase.current = t.notes || ''; }}
          onChange={(e) => setNotes(e.target.value)} onBlur={() => { notesEditing.current = false; if (!notesTheirs && notes !== t.notes) save({ notes }); }} />
        {notesTheirs && (
          <span className="edit-clash" role="alert" title={notesTheirs.value}>
            <span className="ec-text">{notesTheirs.by || 'מישהו אחר'} שמר/ה תיאור אחר</span>
            <button type="button" className="link" onMouseDown={(e) => e.preventDefault()} onClick={() => { setNotesTheirs(null); save({ notes }); }}>לשמור את שלי</button>
            <span className="ec-sep">·</span>
            <button type="button" className="link" onMouseDown={(e) => e.preventDefault()} onClick={() => { setNotes(notesTheirs.value); setNotesTheirs(null); }}>לקחת את שלהם</button>
          </span>
        )}

        {!isSummary && ed && (
          <div className="seg">
            <button className={t.kind === 'task' ? 'on' : ''} onClick={() => t.kind !== 'task' && save({ kind: 'task' })}>משימה</button>
            <button className={t.kind === 'milestone' ? 'on' : ''} onClick={() => t.kind !== 'milestone' && save({ kind: 'milestone' })}>אבן דרך</button>
          </div>
        )}

        <section className={`sec ${['start', 'finish', 'duration', 'kind'].some((k) => flash.has(k)) ? 'just-changed' : ''}`}>
          <h3 className="sec-h-row">{t.kind === 'milestone' ? 'תאריך' : 'לוח זמנים'}
            {ed && !isSummary && (
              <button className="icon-btn to-backlog" title="שליחה ל-Backlog" aria-label="שליחה ל-Backlog"
                onClick={() => {
                  const links = rel.drivers.filter((r) => !r.via).length + rel.driven.filter((r) => !r.via).length;
                  if (!confirm(`לשלוח את "${t.name}" ל-Backlog?\n\nהמשימה תצא מהגאנט ולא יהיו לה תאריכים${links ? (links === 1 ? ', והתלות שלה תימחק' : `, ו-${links} התלויות שלה יימחקו`) : ''}. אפשר לשבץ אותה בחזרה מתי שרוצים.`)) return;
                  run(() => api.post(`/tasks/${t.id}/to-backlog`), `"${t.name}" הועברה ל-Backlog`);
                }}>
                <Icon name="inbox" size={15} />
              </button>
            )}
          </h3>
          {isSummary ? (
            <div className="ro-dates">
              <div><span>התחלה</span><b>{fmtDate(t.start)}</b></div>
              <div><span>סיום</span><b>{fmtDate(t.finish)}</b></div>
              <div><span>משך</span><b>{daysText(t.work_days)}</b></div>
              <p className="muted small">התאריכים של אב-משימה מחושבים אוטומטית מתתי-המשימות שבתוכה.</p>
            </div>
          ) : (
            <div className="grid2">
              <Field label={t.kind === 'milestone' ? 'תאריך' : 'התחלה'}
                hint={t.constrained
                  ? <>התאריך נקבע ידנית: המשימה לא תתחיל לפניו, גם אם מה שלפניה יסתיים מוקדם. אם משהו לפניה יתעכב, היא עדיין תידחה.{' '}
                      {ed && <button className="link" onClick={() => save({ start_constraint: null })}>לחשב לפי התלויות</button>}</>
                  : drivingNames.length ? <>מחושב אוטומטית: מגיע אחרי {drivingNames.map((n) => `"${n}"`).join(', ')}</>
                  : <>מחושב אוטומטית: תחילת הפרויקט</>}>
                <DatePick value={t.start} disabled={!ed} onCommit={(v) => v && save({ start_constraint: v })}
                  safeFrom={t.start} safeUntil={t.free_float ? fromDay(model.cal.finishOf(toDay(t.start), t.free_float + 1)) : null} />
              </Field>
              {t.kind !== 'milestone' && <>
                <Field label="משך (ימי עבודה)">
                  <Commit type="number" min={1} value={t.duration} disabled={!ed} onCommit={(v) => save({ duration: Math.max(1, Number(v) || 1) })} />
                </Field>
                <Field label="סיום">
                  <DatePick value={t.finish} disabled={!ed} minDay={toDay(t.start)} safeFrom={t.finish} safeUntil={t.free_float ? t.free_until : null} onCommit={(v) => {
                    if (!v) return;
                    const f = Math.max(toDay(t.start), toDay(v));
                    return save({ duration: Math.max(1, model.cal.between(toDay(t.start), f)) });
                  }} />
                </Field>
              </>}
            </div>
          )}
          {t.baseline_finish && (
            <p className="muted small">תכנון מקורי: {fmtDate(t.baseline_start)} – {fmtDate(t.baseline_finish)}
              {t.baseline_finish !== t.finish && <b className={toDay(t.finish) > toDay(t.baseline_finish) ? 'bad' : 'good'}> · {toDay(t.finish) > toDay(t.baseline_finish) ? 'מתעכב' : 'מקדים'} ב-{daysText(Math.abs(toDay(t.finish) - toDay(t.baseline_finish)))}</b>}
            </p>
          )}
        </section>

        <section className="sec">
          <h3>{isSummary ? 'התקדמות' : 'ביצוע'}</h3>
          {kidsDone ? (
            <div className="prog-ro">
              <div className="pct-bar big"><i style={{ width: `${kidsDone.total ? (kidsDone.done / kidsDone.total) * 100 : 0}%`, background: pr.color }} /></div>
              <b>הושלמו {kidsDone.done} מתוך {kidsDone.total}</b>
            </div>
          ) : (() => {
            // done or not done: one switch (this version has no partial progress)
            const done = t.percent >= 100, ms = t.kind === 'milestone';
            return (
              <div className={`done-row ${done ? 'on' : ''}`}>
                <span className={`done-state ${done ? 'pop' : ''}`} key={done ? 'on' : 'off'}>{done ? <><Icon name="check" size={15} /> {ms ? 'הושגה' : 'הושלמה'}</> : ms ? 'עוד לא הושגה' : 'עוד לא הושלמה'}</span>
                {ed && <button className={`btn small ${done ? '' : 'primary'}`} onClick={(e) => { if (!done) celebrate(e.currentTarget); save({ percent: done ? 0 : 100 }); }}>
                  {done ? 'ביטול הסימון' : ms ? 'סמן כהושגה' : 'סמן כהושלמה'}</button>}
              </div>
            );
          })()}
        </section>

        <section className="sec">
          <Field label="אחראי" hint={t.owner_unit_id == null && ownUnit ? `לא נקבע ישירות, ולכן עובר מאב-המשימה: ${ownUnit.name}` : null}>
            {ed ? (
              <select value={t.owner_unit_id ?? ''} onChange={(e) => save({ owner_unit_id: e.target.value === '' ? null : Number(e.target.value) })}>
                {(isAdmin || t.owner_unit_id == null) && <option value="">{t.parent_id && ownUnit ? `כמו אב-המשימה (${ownUnit.name})` : 'ללא אחראי'}</option>}
                {t.owner_unit_id != null && !assignable.some((u) => u.id === t.owner_unit_id) && <option value={t.owner_unit_id}>{model.units.get(t.owner_unit_id)?.name}</option>}
                {assignable.map((u) => {
                  const depth = model.unitTree().find((x) => x.unit.id === u.id)?.depth ?? 0;
                  return <option key={u.id} value={u.id}>{'   '.repeat(depth)}{u.name}</option>;
                })}
              </select>
            ) : (
              <div className="ro-value">{ownUnit ? ownUnit.name : '—'}</div>
            )}
          </Field>
          <OwnerName value={t.owner || ''} editable={ed} onSave={(v) => save({ owner: v })} />
        </section>

        {isSummary && (
          <section className="sec">
            <h3>תתי-משימות</h3>
            <div className="kids">
              {t.children.map((c) => {
                const k = model.task(c)!;
                return (
                  <button key={c} className="kid" onClick={() => openTask(c)}>
                    <span className={`st ${k.status}`} />
                    <span className="kid-name">{k.kind === 'milestone' && <Icon name="diamond" size={11} />} {k.name}</span>
                    {k.children.length > 0 && <span className="muted small">{k.children.length} תתי-משימות</span>}
                    <span className="kid-pct">{k.children.length ? (() => { const c = doneCount(model, [k.id]); return `${c.done}/${c.total}`; })() : k.percent >= 100 ? <Icon name="check" size={13} /> : ''}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className="sec">
          <h3><span className="dot up" /> משפיעות על המשימה <span className="count">{rel.drivers.length}</span></h3>
          {rel.drivers.length === 0 && <p className="muted small">אין משימות שהמשימה הזו מחכה להן.</p>}
          {rel.drivers.map((r) => depRow(r, 'up'))}
          {canEdit && <TaskPicker model={model} exclude={excludeLinks} placeholder="+ הוספת משימה שהמשימה הזו תלויה בה…"
            onPick={(id) => run(() => api.post('/dependencies', { predecessor_id: id, successor_id: t.id, type: 'FS' }), 'התלות נוספה')} />}
        </section>

        <section className="sec">
          <h3><span className="dot down" /> מושפעות מהמשימה <span className="count">{rel.driven.length}</span></h3>
          {rel.driven.length === 0 && <p className="muted small">אין משימות שמחכות למשימה הזו.</p>}
          {rel.driven.map((r) => depRow(r, 'down'))}
          {canEdit && <TaskPicker model={model} exclude={excludeDriven} placeholder="+ הוספת משימה שתלויה במשימה הזו…"
            onPick={(id) => run(() => api.post('/dependencies', { predecessor_id: t.id, successor_id: id, type: 'FS' }), 'התלות נוספה')} />}
        </section>

        <div className="actions-row">
          <button className="btn primary" onClick={() => focusTask(t.id)}><Icon name="deps" size={15} /> פתיחה במפת התלויות ומה-אם</button>
          <p className="muted small">כל השרשרת של המשימה במסך אחד, והדמיה של מה יקרה אם היא תתעכב.</p>
        </div>

        <section className="sec">
          <button className={`sec-toggle ${histOpen ? 'open' : ''}`} onClick={() => setHistOpen(!histOpen)} aria-expanded={histOpen}>
            <Icon name="chevronDown" size={15} />
            <span>היסטוריית שינויים</span>
            <span className="count">{history.length}{history.length >= 8 ? '+' : ''}</span>
          </button>
          {histOpen && (
            <>
              {history.length === 0 && <p className="muted small">אין שינויים רשומים.</p>}
              <ul className="hist-mini">
                {history.map((h) => (
                  <li key={h.id}><span className="muted">{fmtDateTime(h.at)} · {h.user_name}</span><div>{h.summary}</div></li>
                ))}
              </ul>
            </>
          )}
        </section>

        {ed && (
          <div className="danger-zone">
            <button className="btn danger-outline" onClick={() => {
              const n = model.subtree(t.id).size - 1;
              if (confirm(`למחוק את "${t.name}"${n ? ` ואת ${n} תתי-המשימות שלה` : ''}? הפעולה תירשם בהיסטוריה.`)) {
                run(() => api.del(`/tasks/${t.id}`), 'המשימה נמחקה').then(onClose);
              }
            }}><Icon name="trash" size={14} /> מחיקת המשימה</button>
          </div>
        )}
      </div>
    </aside>
  );
}
