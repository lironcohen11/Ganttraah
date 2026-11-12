import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Model, Row } from '../model';
import { STATUS_LABEL, depText } from '../model';
import type { Task } from '../types';
import { toDay, fromDay, fmtDate, fmtDM, fmtMonthYear, fmtMonth, fmtLong, daysText } from '../dates';
import { Icon } from './Icon';

export type Zoom = 'day' | 'week' | 'month' | 'quarter';
export const ZOOMS: { id: Zoom; label: string; px: number }[] = [
  { id: 'day', label: 'ימים', px: 30 },
  { id: 'week', label: 'שבועות', px: 13 },
  { id: 'month', label: 'חודשים', px: 4.2 },
  { id: 'quarter', label: 'רבעונים', px: 1.6 },
];

interface Column { id: string; title: string; width: number }
const EDIT_COLS: Column[] = [
  { id: 'wbs', title: '#', width: 46 },
  { id: 'name', title: 'שם המשימה', width: 280 },
  { id: 'dur', title: 'משך', width: 60 },
  { id: 'start', title: 'התחלה', width: 78 },
  { id: 'finish', title: 'סיום', width: 78 },
  { id: 'pct', title: 'התקדמות', width: 74 },
  { id: 'owner', title: 'אחראי', width: 112 },
  { id: 'status', title: 'מצב', width: 78 },
];
const PRESENT_COLS: Column[] = [
  { id: 'wbs', title: '#', width: 48 },
  { id: 'name', title: 'משימה', width: 320 },
  { id: 'start', title: 'התחלה', width: 86 },
  { id: 'finish', title: 'סיום', width: 86 },
  { id: 'pct', title: 'התקדמות', width: 84 },
  { id: 'status', title: 'מצב', width: 78 },
];

export interface Highlight { up: Set<number>; down: Set<number>; upDeps: Set<number>; downDeps: Set<number> }
export interface Ghost { start: string; finish: string; shift: number }

interface Props {
  model: Model;
  rows: Row[];
  mode: 'edit' | 'present';
  zoom: Zoom;
  selectedKey: string | null;
  onSelectRow: (row: Row | null) => void;
  onOpenRow?: (row: Row) => void;
  highlight: Highlight | null;
  showBaseline: boolean;
  showCritical: boolean;
  showOwners: boolean;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  editable: boolean;
  /** per-task edit permission (defaults to editable) */
  canEditTask?: (id: number) => boolean;
  onMoveTask?: (id: number, newStart: string) => void;
  onResizeTask?: (id: number, newDuration: number) => void;
  onLink?: (predId: number, succId: number) => void;
  onRename?: (id: number, name: string) => void;
  ghosts?: Map<number, Ghost> | null;
  blocked?: Set<number> | null;
  scrollToken?: number;
  revealId?: number | null;
  /** width of the task-name column; the divider between the table and the chart changes it */
  nameW?: number;
  onNameW?: (w: number) => void;
}

const HEAD_H = 52;
const C = {
  // theme variables (light / dark are set in styles.css)
  up: 'var(--up)', down: 'var(--down)', crit: 'var(--bad)', arrow: 'var(--g-arrow)', summary: 'var(--g-summary)', ms: 'var(--g-ms)',
  deadline: 'var(--g-deadline)', late: 'var(--bad)', today: 'var(--g-today)', baseline: 'var(--g-baseline)',
};

export function Gantt(p: Props) {
  const { model, rows, zoom } = p;
  // Changing the zoom does not jump: the scale glides from the old width of a day to the new
  // one in a quarter of a second, and the date in the middle of the view stays in the middle.
  const targetPx = ZOOMS.find((z) => z.id === zoom)!.px;
  const [px, setPx] = useState(targetPx);
  const pxRef = useRef(px);
  pxRef.current = px;
  useEffect(() => {
    const from = pxRef.current, to = targetPx;
    if (Math.abs(from - to) < 0.001) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setPx(to); return; }
    const dur = 240, t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      setPx(k >= 1 ? to : from * Math.pow(to / from, e)); // even steps on a zoom scale
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    const safety = window.setTimeout(() => setPx(to), dur + 200); // animation frames paused (hidden window)
    return () => { cancelAnimationFrame(raf); clearTimeout(safety); };
  }, [targetPx]);
  const present = p.mode === 'present';
  const rowH = present ? 40 : 34;
  const cols = present ? PRESENT_COLS : EDIT_COLS.map((c) => (c.id === 'name' && p.nameW ? { ...c, width: p.nameW } : c));
  const tableW = cols.reduce((s, c) => s + c.width, 0);
  const todayDay = toDay(model.data.today);

  // size of the visible area: the chart always fills it (no white block on a big screen)
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [sbW, setSbW] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { setViewW(el.clientWidth); setViewH(el.clientHeight); setSbW(el.offsetWidth - el.clientWidth); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [r0, r1] = useMemo(() => {
    let lo = todayDay, hi = todayDay;
    const add = (iso?: string | null) => { if (iso) { const d = toDay(iso); lo = Math.min(lo, d); hi = Math.max(hi, d); } };
    for (const r of rows) {
      if (r.type === 'task') { add(r.task.start); add(r.task.finish); add(r.task.deadline); if (p.showBaseline) { add(r.task.baseline_start); add(r.task.baseline_finish); } }
      else if (r.type === 'project') { add(r.project.start); add(r.project.finish); }
    }
    if (p.ghosts) for (const g of p.ghosts.values()) { add(g.start); add(g.finish); }
    const pad = { day: [7, 21], week: [21, 56], month: [45, 120], quarter: [90, 240] }[zoom];
    let a = lo - pad[0], b = hi + pad[1];
    // a short plan at a wide zoom: stretch the time range so it fills the whole width
    const minDays = Math.ceil(Math.max(0, viewW - tableW) / px) + 2;
    if (b - a + 1 < minDays) { const extra = minDays - (b - a + 1); a -= Math.floor(extra / 3); b += extra - Math.floor(extra / 3); }
    return [a, b];
  }, [rows, zoom, todayDay, p.showBaseline, p.ghosts, viewW, tableW, px]);

  const W = Math.ceil((r1 - r0 + 1) * px);
  const H = Math.max(rows.length * rowH, 1);
  const HC = H;
  const xR = (day: number) => (r1 - day + 1) * px; // right edge of a day = its start (RTL)
  const xL = (day: number) => (r1 - day) * px;     // left edge of a day  = its end

  const rowOf = useMemo(() => {
    const m = new Map<number, number>();
    rows.forEach((r, i) => { if (r.type === 'task' && !m.has(r.task.id)) m.set(r.task.id, i); });
    return m;
  }, [rows]);

  // ---------- scrolling
  const scrollToDay = (day: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const contentW = tableW + W;
    const s = xR(day) - contentW + tableW + (el.clientWidth - tableW) / 2;
    return Math.max(-(contentW - el.clientWidth), Math.min(0, s));
  };
  const jumpToDay = (day: number) => { const el = scrollRef.current; if (el) el.scrollLeft = scrollToDay(day)!; };
  // short, quick ease-out glide (used by the "today" button)
  const anim = useRef(0);
  const glideToDay = (day: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const from = el.scrollLeft, to = scrollToDay(day)!;
    cancelAnimationFrame(anim.current);
    if (Math.abs(to - from) < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.scrollLeft = to; return; }
    const dur = 280, t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / dur);
      el.scrollLeft = from + (to - from) * (1 - Math.pow(1 - k, 3));
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
    // safety net: if animation frames are paused (hidden window), still end up at the target
    window.setTimeout(() => { if (Math.abs(el.scrollLeft - to) > 1) { cancelAnimationFrame(anim.current); el.scrollLeft = to; } }, dur + 80);
  };
  // When the plan changes (drag, edit) the date range of the chart can grow or shrink.
  // Before re-positioning, work out which date was in the middle of the view using the
  // PREVIOUS geometry, then put that same date back in the middle - the view stays still.
  const geom = useRef<{ r1: number; W: number; px: number; tableW: number } | null>(null);
  const lastScroll = useRef(0);
  const lastToken = useRef(p.scrollToken);
  const first = useRef(true);
  const scaleRef = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = geom.current;
    // the date that was in the middle of the view, using the PREVIOUS geometry
    // (the scroll position as it was BEFORE this render: the browser may already have clipped el.scrollLeft
    // to the new, narrower chart)
    const centerBefore = () => {
      const x = lastScroll.current + prev!.W - (el!.clientWidth - prev!.tableW) / 2; // xR(day) before
      return prev!.r1 + 1 - x / prev!.px;
    };
    if (first.current || !el || !prev || !prev.W) { if (viewW) { jumpToDay(todayDay); first.current = false; } } // first show
    else if (p.scrollToken !== lastToken.current) glideToDay(todayDay);                // "today" button
    else el.scrollLeft = scrollToDay(centerBefore())!;                                 // zoom glide, plan changed: stay put
    lastToken.current = p.scrollToken;
    geom.current = { r1, W, px, tableW };
    if (el) lastScroll.current = el.scrollLeft;
    /* eslint-disable-next-line */
  }, [px, p.scrollToken, r0, r1, tableW, viewW]);

  // ---------- horizontal scrollbar under the chart only (the native one would span the table too)
  const hsRef = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);
  const onMainScroll = () => {
    const el = scrollRef.current, hs = hsRef.current;
    if (el && geom.current && geom.current.W === W) lastScroll.current = el.scrollLeft;
    if (!el || !hs || syncing.current) { syncing.current = false; return; }
    if (Math.abs(hs.scrollLeft - el.scrollLeft) > 0.5) { syncing.current = true; hs.scrollLeft = el.scrollLeft; }
  };
  const onBarScroll = () => {
    const el = scrollRef.current, hs = hsRef.current;
    if (!el || !hs || syncing.current) { syncing.current = false; return; }
    if (Math.abs(hs.scrollLeft - el.scrollLeft) > 0.5) { syncing.current = true; el.scrollLeft = hs.scrollLeft; }
  };
  useLayoutEffect(() => { const el = scrollRef.current, hs = hsRef.current; if (el && hs) hs.scrollLeft = el.scrollLeft; });

  // ---------- divider between the table and the chart
  const startSplit = (e: React.PointerEvent) => {
    if (!p.onNameW) return;
    e.preventDefault();
    const x0 = e.clientX, w0 = p.nameW || 280;
    document.body.classList.add('no-select', 'col-resizing');
    const mv = (ev: PointerEvent) => p.onNameW!(Math.max(140, Math.min(700, w0 + (x0 - ev.clientX)))); // RTL: dragging left widens the table
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); document.body.classList.remove('no-select', 'col-resizing'); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  useEffect(() => {
    if (p.revealId == null) return;
    const t = model.task(p.revealId);
    const i = rowOf.get(p.revealId);
    if (!t || i == null) return;
    jumpToDay(toDay(t.start));
    const el = scrollRef.current;
    if (el) el.scrollTop = Math.max(0, i * rowH - el.clientHeight / 3);
    // eslint-disable-next-line
  }, [p.revealId]);

  // ---------- drag (move / resize / link)
  const svgRef = useRef<SVGSVGElement>(null);
  const mayEdit = (id: number) => (p.canEditTask ? p.canEditTask(id) : true);
  type Drag = { mode: 'move' | 'resize' | 'link'; id: number; x0: number; dx: number; x: number; y: number; pid: number };
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<{ id: number; cx: number; cy: number } | null>(null);
  const pt = (e: React.PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const startDrag = (e: React.PointerEvent, mode: Drag['mode'], row: Row) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (row.type !== 'task') { p.onSelectRow(row); return; }
    const t = row.task;
    // moving/resizing needs rights on this task; a link needs rights on the TARGET (checked on drop)
    const canEdit = p.editable && !row.external && (mode === 'link' || (mayEdit(t.id) && t.kind !== 'summary'));
    if (!canEdit) { p.onSelectRow(row); return; }
    const q = pt(e);
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    document.body.classList.add('no-select');
    try { svgRef.current!.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    setDrag({ mode, id: t.id, x0: q.x, dx: 0, x: q.x, y: q.y, pid: e.pointerId });
  };
  useEffect(() => { if (!drag) document.body.classList.remove('no-select'); }, [drag]);

  /** While dragging a link: which task would it connect to, and is that allowed? */
  const SNAP = 12; // px: how close the pointer must be to a bar before the line snaps to it
  const barBox = (t: Task, i: number) => {
    const g = barGeom(t, i);
    if (t.kind === 'milestone') { const x = xL(toDay(t.finish)); return { l: x - 9, r: x + 9, t: g.cy - 9, b: g.cy + 9 }; }
    return { l: g.left, r: g.right, t: g.cy - 10, b: g.cy + 10 };
  };
  const linkTarget = (d: Drag) => {
    let best: { r: Row & { type: 'task' }; i: number; dist: number } | null = null;
    rows.forEach((r, i) => {
      if (r.type !== 'task' || r.external || r.task.id === d.id) return;
      if (Math.abs(i * rowH + rowH / 2 - d.y) > rowH) return; // only nearby rows
      const b = barBox(r.task, i);
      const dx = Math.max(b.l - d.x, 0, d.x - b.r), dy = Math.max(b.t - d.y, 0, d.y - b.b);
      const dist = Math.hypot(dx, dy);
      if (dist <= SNAP && (!best || dist < best.dist)) best = { r, i, dist };
    });
    if (!best) return null;
    const { r, i } = best as { r: Row & { type: 'task' }; i: number };
    const src = d.id, dst = r.task.id;
    let invalid = '';
    if (model.ancestors(dst).includes(src) || model.ancestors(src).includes(dst)) invalid = 'אי אפשר: אחת נמצאת בתוך השנייה';
    else if (model.data.dependencies.some((x) => (x.predecessor_id === src && x.successor_id === dst) || (x.predecessor_id === dst && x.successor_id === src))) invalid = 'המשימות כבר קשורות';
    else if (!mayEdit(dst)) invalid = `אין הרשאה: "${r.task.name}" באחריות ${model.ownerName(dst) || 'הנהלת הענף'}`;
    return { task: r.task, row: i, invalid };
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const q = pt(e);
    setDrag({ ...drag, dx: q.x - drag.x0, x: q.x, y: q.y });
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag) return;
    const t = model.task(drag.id)!;
    const row = rows[rowOf.get(drag.id)!];
    const delta = Math.round(-drag.dx / px);
    setDrag(null);
    try { svgRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (drag.mode === 'link') {
      const target = linkTarget(drag);
      if (target && !target.invalid) p.onLink?.(drag.id, target.task.id);
      else if (Math.abs(drag.dx) < 4) p.onSelectRow(row);
      return;
    }
    if (Math.abs(drag.dx) < 4 || delta === 0) { p.onSelectRow(row); return; }
    if (drag.mode === 'move') p.onMoveTask?.(drag.id, fromDay(toDay(t.start) + delta));
    else {
      const newFinish = Math.max(toDay(t.start), toDay(t.finish) + delta);
      p.onResizeTask?.(drag.id, Math.max(1, model.cal.between(toDay(t.start), newFinish)));
    }
  };

  // ---------- header ticks
  const header = useMemo(() => {
    const top: { x1: number; x2: number; label: string }[] = [];
    const bottom: { x1: number; x2: number; label: string; off?: boolean; hol?: string }[] = [];
    const seg = (a: number, b: number) => ({ x1: xL(b), x2: xR(a) });
    const yearOf = (d: number) => new Date(d * 86400000).getUTCFullYear();
    const monthOf = (d: number) => new Date(d * 86400000).getUTCMonth();
    let start = r0;
    for (let d = r0; d <= r1 + 1; d++) {
      const boundary = d > r1 || (zoom === 'month' || zoom === 'quarter' ? yearOf(d) !== yearOf(start) : monthOf(d) !== monthOf(start));
      if (boundary) {
        top.push({ ...seg(start, d - 1), label: zoom === 'month' || zoom === 'quarter' ? String(yearOf(start)) : fmtMonthYear(start) });
        start = d;
      }
    }
    start = r0;
    const key = (d: number) => {
      if (zoom === 'day') return d;
      if (zoom === 'week') return Math.floor((d + 4) / 7); // weeks starting Sunday
      if (zoom === 'month') return yearOf(d) * 12 + monthOf(d);
      return yearOf(d) * 4 + Math.floor(monthOf(d) / 3);
    };
    for (let d = r0; d <= r1 + 1; d++) {
      if (d > r1 || key(d) !== key(start)) {
        const s = seg(start, d - 1);
        let label = '';
        if (zoom === 'day') label = String(new Date(start * 86400000).getUTCDate());
        else if (zoom === 'week') label = fmtDM(fromDay(start));
        else if (zoom === 'month') label = fmtMonth(start);
        else label = `רבעון ${Math.floor(monthOf(start) / 3) + 1}`;
        bottom.push({ ...s, label, off: zoom === 'day' && !model.cal.isWork(start), hol: zoom === 'day' ? model.cal.label(start) : '' });
        start = d;
      }
    }
    return { top, bottom };
    // eslint-disable-next-line
  }, [r0, r1, zoom, px, model]);

  const offDays = useMemo(() => {
    if (zoom === 'month' || zoom === 'quarter') return [];
    const out: { d: number; hol: string }[] = [];
    for (let d = r0; d <= r1; d++) if (!model.cal.isWork(d)) out.push({ d, hol: model.cal.label(d) });
    return out;
  }, [r0, r1, zoom, model]);

  // special days of a unit: marked only on the rows of that unit's tasks
  const unitOff = useMemo(() => {
    if (zoom === 'month' || zoom === 'quarter' || !(model.data.unitDays || []).length) return [];
    const out: { i: number; d: number; label: string }[] = [];
    rows.forEach((r, i) => {
      if (r.type !== 'task') return;
      for (const u of model.unitDaysOf(r.task.id)) {
        const unit = model.units.get(u.unit_id)?.name || '';
        for (let d = Math.max(r0, toDay(u.start_day)); d <= Math.min(r1, toDay(u.end_day)); d++) {
          if (model.cal.isWork(d)) out.push({ i, d, label: `${u.label || 'יום מיוחד'} · ${unit}: לא עובדים ביום הזה` });
        }
      }
    });
    return out;
  }, [rows, r0, r1, zoom, model]);

  // ---------- geometry of a task bar
  const barGeom = (t: Task, i: number) => {
    const y = i * rowH;
    const s = toDay(t.start), f = toDay(t.finish);
    return { y, left: xL(f), right: xR(s), cy: y + rowH / 2 };
  };
  const anchor = (t: Task, end: 'start' | 'finish', i: number) => {
    const g = barGeom(t, i);
    if (t.kind === 'milestone') { const x = xL(toDay(t.finish)); return { x: end === 'start' ? x + 8 : x - 8, y: g.cy }; }
    return { x: end === 'start' ? g.right : g.left, y: g.cy };
  };

  const arrows = useMemo(() => {
    const out: { id: number; d: string; cls: string }[] = [];
    for (const dep of model.data.dependencies) {
      const ia = rowOf.get(dep.predecessor_id), ib = rowOf.get(dep.successor_id);
      if (ia == null || ib == null) continue;
      const a = model.task(dep.predecessor_id)!, b = model.task(dep.successor_id)!;
      const from = dep.type === 'SS' ? anchor(a, 'start', ia) : anchor(a, 'finish', ia);
      const to = dep.type === 'FF' ? anchor(b, 'finish', ib) : anchor(b, 'start', ib);
      const dirOut = dep.type === 'SS' ? 1 : -1;
      const dirIn = dep.type === 'FF' ? 1 : -1;
      const p1x = from.x + dirOut * 8;
      let d: string;
      if ((to.x - p1x) * dirIn >= 6 && ia !== ib) d = `M${from.x},${from.y}H${p1x}V${to.y}H${to.x}`;
      else {
        const midY = ib > ia ? (ia + 1) * rowH : ia * rowH;
        const ax = to.x - dirIn * 10;
        d = `M${from.x},${from.y}H${p1x}V${midY}H${ax}V${to.y}H${to.x}`;
      }
      let cls = 'arrow';
      if (p.highlight) {
        if (p.highlight.upDeps.has(dep.id)) cls += ' up';
        else if (p.highlight.downDeps.has(dep.id)) cls += ' down';
        else cls += ' faded';
      } else if (p.showCritical && a.critical && b.critical) cls += ' crit';
      out.push({ id: dep.id, d, cls });
    }
    return out;
    // eslint-disable-next-line
  }, [model, rowOf, p.highlight, p.showCritical, r1, px, rowH]);

  const selTaskId = p.selectedKey?.startsWith('t:') || p.selectedKey?.startsWith('x:') ? Number(p.selectedKey.slice(2)) : null;
  const dimmed = (id: number) => !!p.highlight && id !== selTaskId && !p.highlight.up.has(id) && !p.highlight.down.has(id);

  // ---------- rename inline
  const [renaming, setRenaming] = useState<number | null>(null);

  const hoverTask = hover ? model.task(hover.id) : null;

  return (
   <div className="gantt-wrap">
    <div className={`gantt ${present ? 'present' : ''}`} ref={scrollRef} onClick={() => p.onSelectRow(null)} onScroll={onMainScroll}>
      <div className="g-inner" style={{ width: tableW + W }}>
        {/* ---------------- header */}
        <div className="g-head" style={{ height: HEAD_H }}>
          <div className="g-table-head" style={{ width: tableW }}>
            {cols.map((c) => <div key={c.id} className={`cell c-${c.id}`} style={{ width: c.width }}>{c.title}</div>)}
          </div>
          <svg width={W} height={HEAD_H} className="g-scale" ref={scaleRef}>
            {header.top.map((s, i) => (
              <g key={'t' + i}>
                <line x1={s.x1} x2={s.x1} y1={0} y2={HEAD_H / 2} className="tick" />
                <text x={(s.x1 + s.x2) / 2} y={17} className="scale-top">{s.x2 - s.x1 > 60 ? s.label : ''}</text>
              </g>
            ))}
            <line x1={0} x2={W} y1={HEAD_H / 2} y2={HEAD_H / 2} className="tick" />
            {header.bottom.map((s, i) => (
              <g key={'b' + i}>
                {s.off && <rect x={s.x1} y={HEAD_H / 2} width={s.x2 - s.x1} height={HEAD_H / 2} className={s.hol ? 'hol-head' : 'off-head'} />}
                <line x1={s.x1} x2={s.x1} y1={HEAD_H / 2} y2={HEAD_H} className="tick" />
                <text x={(s.x1 + s.x2) / 2} y={HEAD_H - 9} className={`scale-bottom ${s.off ? 'off' : ''}`}>{s.x2 - s.x1 >= 14 ? s.label : ''}</text>
                {s.hol && <circle cx={(s.x1 + s.x2) / 2} cy={HEAD_H / 2 + 4} r={2.5} className="hol-dot"><title>{s.hol}</title></circle>}
                {s.hol && <title>{s.hol}</title>}
              </g>
            ))}
            <g>
              <rect x={xR(todayDay) - px / 2 - 16} y={HEAD_H / 2 - 9} width={32} height={15} rx={7} fill={C.today} />
              <text x={xR(todayDay) - px / 2} y={HEAD_H / 2 + 2} className="today-label">היום</text>
            </g>
          </svg>
        </div>

        {/* ---------------- body */}
        <div className="g-body" style={{ height: HC }}>
          <div className="g-table" style={{ width: tableW, height: HC }}>
            {rows.map((r, i) => (
              <GridRow key={r.key + i} row={r} cols={cols} rowH={rowH} model={model} present={present}
                selected={p.selectedKey === r.key}
                dim={r.type === 'task' && dimmed(r.task.id)}
                hl={r.type === 'task' ? (p.highlight?.up.has(r.task.id) ? 'up' : p.highlight?.down.has(r.task.id) ? 'down' : null) : null}
                collapsed={p.collapsed.has(r.key)}
                onToggle={() => p.onToggle(r.key)}
                onClick={(e) => { e.stopPropagation(); p.onSelectRow(r); }}
                onDouble={() => {
                  if (r.type === 'task' && p.editable && !r.external && mayEdit(r.task.id)) setRenaming(r.task.id);
                  else p.onOpenRow?.(r);
                }}
                renaming={r.type === 'task' && renaming === r.task.id}
                onRename={(name) => { setRenaming(null); if (r.type === 'task' && name && name !== r.task.name) p.onRename?.(r.task.id, name); }}
                blocked={r.type === 'task' && !!p.blocked?.has(r.task.id)}
                ghost={r.type === 'task' ? p.ghosts?.get(r.task.id) : undefined}
              />
            ))}
          </div>

          <svg ref={svgRef} width={W} height={HC} className="g-chart"
            onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => { if (e.target === svgRef.current) p.onSelectRow(null); }}>
            <defs>
              {(['arrow', 'up', 'down', 'crit', 'faded'] as const).map((k) => (
                <marker key={k} id={`ah-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z" fill={k === 'arrow' ? C.arrow : k === 'faded' ? 'var(--g-faded)' : k === 'crit' ? C.crit : C[k]} />
                </marker>
              ))}
              <marker id="ah-link" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="var(--g-deadline)" />
              </marker>
              <pattern id="hatch-unit" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="7" stroke="#e6a23c" strokeWidth="2.2" strokeOpacity=".55" />
              </pattern>
              <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" fill="var(--bad-soft)" /><line x1="0" y1="0" x2="0" y2="6" stroke="var(--bad)" strokeWidth="2" />
              </pattern>
            </defs>

            {/* background: rows, non-working days, today */}
            {rows.map((r, i) => (
              <rect key={'bg' + i} x={0} y={i * rowH} width={W} height={rowH}
                className={`row-bg ${p.selectedKey === r.key ? 'sel' : ''} ${r.type === 'project' ? 'proj' : ''} ${r.type === 'group' ? 'grp' : ''}`} />
            ))}
            {offDays.map((o) => (
              <rect key={'off' + o.d} x={xL(o.d)} y={0} width={px} height={HC} className={o.hol ? 'hol-col' : 'off-col'}>
                {o.hol && <title>{o.hol}</title>}
              </rect>
            ))}
            {unitOff.map((o) => (
              <rect key={`uo${o.i}-${o.d}`} x={xL(o.d)} y={o.i * rowH} width={px} height={rowH} className="unit-off"><title>{o.label}</title></rect>
            ))}
            {header.top.map((s, i) => <line key={'ml' + i} x1={s.x1} x2={s.x1} y1={0} y2={HC} className="month-line" />)}
            <line x1={xR(todayDay) - px / 2} x2={xR(todayDay) - px / 2} y1={0} y2={HC} className="today-line" />

            {/* dependency arrows */}
            <g className="arrows">
              {arrows.map((a) => (
                <path key={a.id} d={a.d} className={a.cls}
                  markerEnd={`url(#ah-${a.cls.includes('up') ? 'up' : a.cls.includes('down') ? 'down' : a.cls.includes('crit') ? 'crit' : a.cls.includes('faded') ? 'faded' : 'arrow'})`} />
              ))}
            </g>

            {/* bars */}
            {rows.map((r, i) => {
              if (r.type === 'group') return null;
              if (r.type === 'project') {
                const pr = r.project;
                if (!pr.roots.length) return null;
                const y = i * rowH + rowH / 2;
                const left = xL(toDay(pr.finish)), right = xR(toDay(pr.start));
                const w = right - left;
                const h = present ? 14 : 12;
                return (
                  <g key={r.key} className="bar-g" onPointerDown={(e) => { e.stopPropagation(); p.onSelectRow(r); }}>
                    {/* light bar = whole project, solid part = completed share */}
                    <g opacity={0.3}><Bracket left={left} right={right} y={y} h={h} color={pr.color} /></g>
                    <rect x={right - (w * pr.percent) / 100} y={y - h / 2} width={(w * pr.percent) / 100} height={h} fill={pr.color} />
                    <rect x={left} y={y - h / 2} width={3} height={h + 5} fill={pr.color} />
                    <rect x={right - 3} y={y - h / 2} width={3} height={h + 5} fill={pr.color} />
                    <text x={left - 8} y={y + 4} className="bar-label strong">{pr.percent}%</text>
                  </g>
                );
              }
              const t = r.task;
              const g = barGeom(t, i);
              const dim = dimmed(t.id);
              const hl = p.highlight?.up.has(t.id) ? 'up' : p.highlight?.down.has(t.id) ? 'down' : null;
              const sel = t.id === selTaskId;
              const color = p.showCritical && t.critical ? C.crit : r.project.color;
              const isDrag = drag?.id === t.id;
              let left = g.left, right = g.right;
              if (isDrag && drag!.mode === 'move') { left += drag!.dx; right += drag!.dx; }
              if (isDrag && drag!.mode === 'resize') left = Math.min(right - px, left + drag!.dx);
              const w = Math.max(2, right - left);
              const bh = present ? 22 : 18;
              const by = g.cy - bh / 2;
              const ghost = p.ghosts?.get(t.id);
              const isBlocked = p.blocked?.has(t.id);
              const label = present
                ? (p.showOwners && model.ownerName(t.id) ? `${t.name} · ${model.ownerName(t.id)}` : t.name)
                : (t.owner_unit_id != null ? model.ownerName(t.id) : '');
              const showBase = p.showBaseline && t.baseline_start && t.baseline_finish;
              return (
                <g key={r.key} className={`bar-g ${dim ? 'dim' : ''} ${r.external ? 'ext' : ''}`}
                  onPointerEnter={(e) => setHover({ id: t.id, cx: e.clientX, cy: e.clientY })}
                  onPointerMove={(e) => !drag && setHover({ id: t.id, cx: e.clientX, cy: e.clientY })}
                  onPointerLeave={() => setHover(null)}
                  onDoubleClick={(e) => { e.stopPropagation(); p.onOpenRow?.(r); }}>
                  {showBase && (t.kind === 'milestone'
                    ? <path d={diamond(xL(toDay(t.baseline_finish!)), g.cy + 9, 4)} fill={C.baseline} />
                    : <rect x={xL(toDay(t.baseline_finish!))} y={g.cy + bh / 2 + 2} width={xR(toDay(t.baseline_start!)) - xL(toDay(t.baseline_finish!))} height={4} rx={2} fill={C.baseline} />)}

                  {ghost && (t.kind === 'milestone'
                    ? <path d={diamond(xL(toDay(ghost.finish)), g.cy, 8)} className="ghost" />
                    : <rect x={xL(toDay(ghost.finish))} y={by - 2} width={xR(toDay(ghost.start)) - xL(toDay(ghost.finish))} height={bh + 4} rx={5} className="ghost" />)}

                  {t.kind === 'summary' ? (
                    <g onPointerDown={(e) => startDrag(e, 'move', r)}>
                      <Bracket left={left} right={right} y={g.cy} h={present ? 10 : 8} color={C.summary} />
                      {(hl || sel) && <rect x={left - 3} y={g.cy - 9} width={w + 6} height={18} rx={4} className={`hl-box ${sel ? 'sel' : hl}`} />}
                    </g>
                  ) : t.kind === 'milestone' ? (
                    <g onPointerDown={(e) => startDrag(e, 'move', r)}>
                      {(hl || sel) && <circle cx={left} cy={g.cy} r={13} className={`hl-box ${sel ? 'sel' : hl}`} />}
                      <path d={diamond(left, g.cy, present ? 9 : 8)} fill={isBlocked ? 'url(#hatch)' : p.showCritical && t.critical ? C.crit : t.percent >= 100 ? C.ms : 'var(--surface)'}
                        stroke={p.showCritical && t.critical ? C.crit : C.ms} strokeWidth={2} />
                    </g>
                  ) : (
                    <g>
                      {(hl || sel) && <rect x={left - 3} y={by - 3} width={w + 6} height={bh + 6} rx={6} className={`hl-box ${sel ? 'sel' : hl}`} />}
                      <rect x={left} y={by} width={w} height={bh} rx={4} fill={isBlocked ? 'url(#hatch)' : color} fillOpacity={isBlocked ? 1 : 0.22} stroke={color} strokeWidth={1.2}
                        className={p.editable && !r.external && mayEdit(t.id) ? 'draggable' : ''} onPointerDown={(e) => startDrag(e, 'move', r)} />
                      {t.percent > 0 && !isBlocked && (
                        <rect x={right - (w * t.percent) / 100} y={by} width={(w * t.percent) / 100} height={bh} rx={4} fill={color}
                          pointerEvents="none" />
                      )}
                      {!present && w > 34 && <text x={right - 6} y={g.cy + 4} className={`bar-pct ${t.percent >= 50 ? 'on' : ''}`} pointerEvents="none">{t.percent}%</text>}
                      {p.editable && !r.external && mayEdit(t.id) && (
                        <rect x={left - 3} y={by} width={7} height={bh} className="resize-h" onPointerDown={(e) => startDrag(e, 'resize', r)} />
                      )}
                    </g>
                  )}

                  {t.deadline && (
                    <path d={`M${xL(toDay(t.deadline)) - 5},${g.y + 2}h10l-5,7z`} fill={t.deadline_missed ? C.late : C.deadline}>
                      <title>{`תאריך יעד: ${fmtLong(t.deadline)}${t.deadline_missed ? ' (חריגה)' : ''}`}</title>
                    </path>
                  )}

                  {label && <text x={(t.kind === 'milestone' ? left - 12 : left - 8)} y={g.cy + 4} className={`bar-label ${t.kind === 'summary' ? 'strong' : ''}`} pointerEvents="none">
                    {t.kind === 'milestone' && !present ? fmtDM(t.finish) : label}
                  </text>}
                  {ghost && <text x={xL(toDay(ghost.finish)) - 8} y={g.cy - bh / 2 - 2} className="ghost-label">+{daysText(ghost.shift)}</text>}

                  {p.editable && !r.external && (
                    <circle cx={t.kind === 'milestone' ? left - 14 : left - 9} cy={g.cy} r={5} className="link-h"
                      onPointerDown={(e) => startDrag(e, 'link', r)}><title>גרור אל משימה אחרת כדי ליצור תלות</title></circle>
                  )}
                </g>
              );
            })}

            {drag?.mode === 'link' && (() => {
              const t = model.task(drag.id)!;
              const a = anchor(t, 'finish', rowOf.get(drag.id)!);
              const tg = linkTarget(drag);
              const ok = !!tg && !tg.invalid;
              const b = ok ? anchor(tg!.task, 'start', tg!.row) : { x: drag.x, y: drag.y };
              const label = !tg ? `"${t.name}" תשפיע על…` : tg.invalid ? tg.invalid : `"${t.name}" תשפיע על "${tg.task.name}"`;
              // keep the label along the line but never upside down
              let ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
              if (ang > 90) ang -= 180;
              if (ang < -90) ang += 180;
              const len = Math.hypot(b.x - a.x, b.y - a.y);
              return (
                <g pointerEvents="none">
                  {tg && (() => {
                    const bx = barBox(tg.task, tg.row);
                    return <rect x={bx.l - 4} y={bx.t - 4} width={bx.r - bx.l + 8} height={bx.b - bx.t + 8} rx={6} className={`link-target ${tg.invalid ? 'bad' : ''}`} />;
                  })()}
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`link-line ${tg?.invalid ? 'bad' : ok ? 'ok' : ''}`}
                    markerEnd={ok ? 'url(#ah-link)' : undefined} />
                  <circle cx={a.x} cy={a.y} r={4} className="link-dot" />
                  {len > 40 && (
                    <text transform={`translate(${(a.x + b.x) / 2},${(a.y + b.y) / 2}) rotate(${ang})`} y={-7}
                      textAnchor="middle" className={`link-label ${tg?.invalid ? 'bad' : ''}`}>{label}</text>
                  )}
                </g>
              );
            })()}
          </svg>
        </div>
      </div>

      {hoverTask && !drag && <Tooltip t={hoverTask} model={model} x={hover!.cx} y={hover!.cy} showOwner={!present || p.showOwners} />}
      {!rows.length && <div className="g-empty">אין משימות להצגה</div>}
    </div>
    {p.onNameW && <div className="g-split" style={{ right: tableW - 4 }} onPointerDown={startSplit} title="גרירה משנה את רוחב הטבלה" />}
    <div className="g-hscroll" ref={hsRef} onScroll={onBarScroll} style={{ width: Math.max(0, viewW - tableW), marginInlineEnd: sbW }}>
      <div style={{ width: W, height: 1 }} />
    </div>
   </div>
  );
}

function diamond(cx: number, cy: number, r: number) {
  return `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;
}

/** Summary bar: a flat bar with straight vertical legs at both ends. */
function Bracket({ left, right, y, h, color }: { left: number; right: number; y: number; h: number; color: string }) {
  const w = Math.max(4, right - left);
  const leg = Math.min(3, w / 2);
  const top = y - h / 2, bot = y + h / 2, legBot = bot + 5;
  return (
    <path fill={color} d={`M${left},${top}H${left + w}V${legBot}H${left + w - leg}V${bot}H${left + leg}V${legBot}H${left}Z`} />
  );
}

function Tooltip({ t, model, x, y, showOwner }: { t: Task; model: Model; x: number; y: number; showOwner: boolean }) {
  const rel = model.relations(t.id);
  const style: React.CSSProperties = { top: y + 16, left: Math.max(8, x - 300) };
  return (
    <div className="g-tip" style={style}>
      <div className="tip-path">{model.path(t.id)}</div>
      <div className="tip-name">{t.name}</div>
      <div className="tip-grid">
        <span>תאריכים</span><b>{fmtDate(t.start)}{t.kind !== 'milestone' && ` – ${fmtDate(t.finish)}`}</b>
        {t.kind !== 'milestone' && <><span>משך</span><b>{daysText(t.work_days)} עבודה</b></>}
        <span>התקדמות</span><b>{t.percent}% · {STATUS_LABEL[t.status]}</b>
        {showOwner && model.ownerName(t.id) && <><span>אחראי</span><b>{model.ownerName(t.id)}</b></>}
        {t.deadline && <><span>תאריך יעד</span><b className={t.deadline_missed ? 'bad' : ''}>{fmtDate(t.deadline)}{t.deadline_missed ? ' · חריגה' : ''}</b></>}
        {t.baseline_finish && t.baseline_finish !== t.finish && <><span>סיום מקורי</span><b>{fmtDate(t.baseline_finish)}</b></>}
      </div>
      {(rel.drivers.length > 0 || rel.driven.length > 0) && (
        <div className="tip-rel">
          {rel.drivers.length > 0 && <div><span className="dot up" />תלויה ב-{rel.drivers.length === 1 ? `"${model.task(rel.drivers[0].other)?.name}" (${depText(rel.drivers[0].dep.type, rel.drivers[0].dep.lag)})` : `${rel.drivers.length} משימות`}</div>}
          {rel.driven.length > 0 && <div><span className="dot down" />משפיעה על {rel.driven.length === 1 ? `"${model.task(rel.driven[0].other)?.name}"` : `${rel.driven.length} משימות`}</div>}
        </div>
      )}
    </div>
  );
}

interface GridRowProps {
  row: Row; cols: Column[]; rowH: number; model: Model; present: boolean; selected: boolean; dim: boolean;
  hl: 'up' | 'down' | null; collapsed: boolean; onToggle: () => void; onClick: (e: React.MouseEvent) => void;
  onDouble: () => void; renaming: boolean; onRename: (name: string) => void; blocked: boolean; ghost?: Ghost;
}

function GridRow(g: GridRowProps) {
  const { row: r, cols, rowH, model } = g;
  const cls = `g-row ${r.type} ${g.selected ? 'sel' : ''} ${g.dim ? 'dim' : ''} ${g.hl || ''} ${r.type === 'task' && r.task.kind === 'summary' ? 'summary' : ''} ${r.type === 'task' && r.external ? 'ext' : ''} ${r.type === 'task' && r.context ? 'ctx' : ''}`;
  if (r.type === 'group') {
    return <div className={cls} style={{ height: rowH }}><div className="cell c-group"><Icon name="external" size={14} /> {r.label}</div></div>;
  }
  const t = r.type === 'task' ? r.task : null;
  const pr = r.project;
  const hasKids = t ? t.children.length > 0 : pr.roots.length > 0;
  const indent = r.depth * 18;
  const cell = (id: string) => {
    switch (id) {
      case 'wbs': return t ? (r.type === 'task' && r.external ? '' : t.wbs) : '';
      case 'name':
        return (
          <div className="name-wrap" style={{ paddingInlineStart: indent }}>
            {Array.from({ length: r.depth }).map((_, k) => <span key={k} className="guide" style={{ insetInlineStart: k * 18 + 9 }} />)}
            {hasKids && !(t && r.type === 'task' && r.external)
              ? <button className={`tog ${g.collapsed ? 'closed' : ''}`} onClick={(e) => { e.stopPropagation(); g.onToggle(); }} aria-label={g.collapsed ? 'פתח' : 'סגור'}><Icon name="chevronDown" size={14} /></button>
              : <span className="tog-sp" />}
            {r.type === 'project' && <span className="proj-chip" style={{ background: pr.color }} />}
            {t?.kind === 'milestone' && <Icon name="diamond" size={12} className="ms-icon" />}
            {g.renaming && t ? (
              <input className="rename" autoFocus defaultValue={t.name}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === 'Enter') g.onRename((e.target as HTMLInputElement).value.trim()); if (e.key === 'Escape') g.onRename(t.name); }}
                onBlur={(e) => g.onRename(e.target.value.trim())} />
            ) : (
              <span className="name-text" title={t ? `${model.path(t.id)} › ${t.name}` : pr.name}>
                {r.type === 'task' && r.external && <span className="ext-path">{model.path(t!.id)} › </span>}
                {t ? t.name : pr.name}
              </span>
            )}
            {t && model.crossProject(t.id) && <span className="badge-link" title="קשורה למשימה בפרויקט אחר"><Icon name="link" size={12} /></span>}
            {t?.deadline_missed && <span className="badge-alert" title={`חורגת מתאריך היעד ${fmtDate(t.deadline)}`}><Icon name="alert" size={12} /></span>}
            {g.blocked && <span className="sim-badge blocked">חסומה</span>}
            {g.ghost && <span className="sim-badge">+{g.ghost.shift}</span>}
          </div>
        );
      case 'dur': return t ? (t.kind === 'milestone' ? '—' : `${t.work_days} י׳`) : '';
      case 'start': return fmtDate(t ? t.start : pr.roots.length ? pr.start : null);
      case 'finish': return fmtDate(t ? t.finish : pr.roots.length ? pr.finish : null);
      case 'pct': {
        const v = t ? t.percent : pr.percent;
        return <div className="pct"><div className="pct-bar"><i style={{ width: `${v}%`, background: pr.color }} /></div><span>{v}%</span></div>;
      }
      case 'owner': {
        if (!t) return '';
        const o = model.effOwner(t.id);
        const u = o.unit != null ? model.units.get(o.unit) : undefined;
        return u ? <span className={o.inherited ? 'inherited' : ''} title={`${u.name}${o.inherited ? ' (עובר מאב-המשימה)' : ''}`}>{u.name}</span> : '';
      }
      case 'status': {
        // a coloured status tag that fills the cell, with the status in words
        if (!t) {
          const late = pr.late_count + pr.deadline_issues, behind = pr.behind_count;
          if (pr.percent >= 100) return <span className="st-tag done">הושלם</span>;
          if (late) return <span className="st-tag late" title={`${late} משימות באיחור או בחריגה מתאריך יעד`}>באיחור</span>;
          if (behind) return <span className="st-tag behind" title={`${behind} משימות בפיגור`}>בפיגור</span>;
          return <span className="st-tag active">תקין</span>;
        }
        const bad = t.deadline_missed || (t.kind === 'summary' && t.has_deadline_issue);
        const label = t.kind === 'milestone'
          ? ({ done: 'הושגה', late: 'לא הושגה', planned: 'מתוכננת', active: 'מתוכננת', behind: 'מתוכננת' } as const)[t.status]
          : STATUS_LABEL[t.status];
        return (
          <span className={`st-tag ${t.status} ${bad ? 'over' : ''}`} title={`${label}${bad ? ' · חורגת מתאריך היעד' : ''}`}>
            {label}{bad && <Icon name="alert" size={11} className="st-alert" />}
          </span>
        );
      }
    }
    return null;
  };
  return (
    <div className={cls} style={{ height: rowH }} onClick={g.onClick} onDoubleClick={g.onDouble}>
      {cols.map((c) => <div key={c.id} className={`cell c-${c.id}`} style={{ width: c.width }}>{cell(c.id)}</div>)}
    </div>
  );
}

export function Legend({ showBaseline, showCritical }: { showBaseline: boolean; showCritical: boolean }) {
  const row = (icon: React.ReactNode, text: string) => <div className="lg-row"><span className="lg-ic">{icon}</span>{text}</div>;
  return (
    <div className="legend">
      <div className="lg-title">פסים</div>
      {row(<svg width="30" height="12"><rect x="1" y="1" width="28" height="10" rx="3" fill="#3b6fd8" fillOpacity=".22" stroke="#3b6fd8" /><rect x="15" y="1" width="14" height="10" rx="3" fill="#3b6fd8" /></svg>, 'משימה: החלק המלא = מה שהושלם')}
      {row(<svg width="30" height="14"><path d="M1,2H29V9H26V13H23V9H7V13H4V9H1Z" fill={C.summary} /></svg>, 'אב-משימה: מתפרסת על כל מה שבתוכה')}
      {row(<svg width="30" height="14"><g opacity=".3"><path d="M1,2H29V13H26V8H4V13H1Z" fill="#3b6fd8" /></g><rect x="15" y="2" width="14" height="6" fill="#3b6fd8" /></svg>, 'פרויקט: בהיר = כל הפרויקט, מלא = מה שהושלם')}
      {row(<svg width="16" height="16"><path d={diamond(8, 8, 6)} fill="var(--surface)" stroke={C.ms} strokeWidth="2" /></svg>, 'אבן דרך (מלאה = הושגה)')}
      {showBaseline && row(<svg width="30" height="8"><rect x="1" y="2" width="28" height="4" rx="2" fill={C.baseline} /></svg>, 'התכנון המקורי (תכנון מול ביצוע)')}
      {showCritical && row(<svg width="30" height="12"><rect x="1" y="1" width="28" height="10" rx="3" fill={C.crit} /></svg>, 'נתיב קריטי: עיכוב בה מזיז את סיום הפרויקט')}
      <div className="lg-title">סימונים</div>
      {row(<svg width="12" height="10"><path d="M1,1h10l-5,7z" fill={C.deadline} /></svg>, 'תאריך יעד')}
      {row(<svg width="12" height="10"><path d="M1,1h10l-5,7z" fill={C.late} /></svg>, 'חריגה מתאריך היעד')}
      {row(<svg width="30" height="12"><path d="M1,6H12V10H26" fill="none" stroke={C.arrow} strokeWidth="1.3" /><path d="M24,7L29,10L24,13z" fill={C.arrow} /></svg>, 'תלות: המשימה שמשמאל מחכה לזו שמימין')}
      {row(<svg width="30" height="12"><rect x="2" y="1" width="12" height="10" rx="3" fill="none" stroke={C.up} strokeWidth="2" /><rect x="17" y="1" width="12" height="10" rx="3" fill="none" stroke={C.down} strokeWidth="2" /></svg>, 'בהצגת התלויות: כתום משפיעה, סגול מושפעת')}
      {row(<svg width="4" height="14"><rect width="2" height="14" fill={C.today} /></svg>, 'היום')}
      <div className="lg-title">רקע</div>
      {row(<svg width="16" height="14"><rect width="16" height="14" fill="var(--g-off)" stroke="var(--border)" /></svg>, 'סוף שבוע')}
      {row(<svg width="16" height="14"><rect width="16" height="14" fill="var(--g-hol)" stroke="var(--g-hol-line)" /></svg>, 'חג או יום חופש של כל הענף')}
      {row(<svg width="16" height="14"><defs><pattern id="lg-h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="5" stroke="#e6a23c" strokeWidth="2" strokeOpacity=".6" /></pattern></defs><rect width="16" height="14" fill="url(#lg-h)" stroke="var(--g-hol-line)" /></svg>, 'יום מיוחד של מסגרת אחת: רק המשימות שלה לא עובדות בו')}
    </div>
  );
}
