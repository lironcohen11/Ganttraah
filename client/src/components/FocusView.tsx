import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import { STATUS_LABEL, depText } from '../model';
import type { Impact, ImpactEdge, SimResult, Task } from '../types';
import { fmtDate, toDay, daysText } from '../dates';
import { Icon } from './Icon';
import { TaskPicker } from './TaskPicker';

export function FocusView({ taskId }: { taskId: number | null }) {
  const { model, focusTask, openTask, setSim, toast } = useApp();
  const [impact, setImpact] = useState<Impact | null>(null);
  const [sim, setLocalSim] = useState<SimResult | null>(null);
  const [days, setDays] = useState(5);
  const [busy, setBusy] = useState(false);
  const t = taskId != null ? model.task(taskId) : undefined;

  useEffect(() => { setLocalSim(null); }, [taskId]);
  useEffect(() => {
    if (taskId == null || !model.task(taskId)) { setImpact(null); return; }
    let live = true;
    api.get<Impact>(`/tasks/${taskId}/impact`).then((g) => live && setImpact(g)).catch((e) => toast(e.message, 'error'));
    return () => { live = false; };
  }, [taskId, model]);

  // ---- tree: every card gets ONE line, to the card it hangs on in the neighbouring column
  const tree = useMemo(() => {
    const parent = new Map<number, ImpactEdge>();
    const extra = new Map<number, number>();
    if (!impact) return { parent, extra };
    const node = new Map(impact.nodes.map((n) => [n.id, n]));
    for (const n of impact.nodes) {
      if (n.side === 'center') continue;
      const isPrev = (id: number) => {
        const m = node.get(id);
        return !!m && (m.side === 'center' ? n.level === 1 : m.side === n.side && m.level === n.level - 1);
      };
      const cands = impact.edges.filter((e) => (n.side === 'up' ? e.from === n.id && isPrev(e.to) : e.to === n.id && isPrev(e.from)));
      const pick = cands.find((e) => e.driving) || cands[0];
      if (pick) parent.set(n.id, pick);
      const touching = impact.edges.filter((e) => e.from === n.id || e.to === n.id).length;
      if (touching > 1) extra.set(n.id, touching - 1);
    }
    return { parent, extra };
  }, [impact]);

  // ---- layout columns, ordered so lines from one parent stay together and do not cross
  const layout = useMemo(() => {
    if (!impact) return null;
    const startOf = (id: number) => model.task(id)?.start || '';
    const parentId = (id: number) => { const e = tree.parent.get(id); return e ? (e.from === id ? e.to : e.from) : null; };
    const build = (side: 'up' | 'down') => {
      const nodes = impact.nodes.filter((n) => n.side === side);
      const maxL = Math.max(1, ...nodes.map((n) => n.level));
      let prevPos = new Map<number, number>([[impact.root, 0]]);
      const cols: { key: string; side: 'up' | 'down'; level: number; ids: number[] }[] = [];
      for (let l = 1; l <= maxL; l++) {
        const ids = nodes.filter((n) => n.level === l).map((n) => n.id).sort((a, b) => {
          const pa = prevPos.get(parentId(a) ?? -1) ?? 999, pb = prevPos.get(parentId(b) ?? -1) ?? 999;
          return pa - pb || startOf(a).localeCompare(startOf(b));
        });
        cols.push({ key: side[0] + l, side, level: l, ids });
        prevPos = new Map(ids.map((id, i) => [id, i]));
      }
      return cols;
    };
    return { upCols: build('up').reverse(), downCols: build('down') };
  }, [impact, model, tree]);

  const simMoved = useMemo(() => {
    const m = new Map<number, number>();
    if (sim?.mode === 'delay') for (const x of sim.moved) m.set(x.id, x.shift);
    return m;
  }, [sim]);
  const simBlocked = useMemo(() => new Set(sim?.mode === 'cancel' ? sim.blocked.map((b) => b.id) : []), [sim]);

  // ---- connectors
  const boxRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ key: string; d: string; cls: string; lx: number; ly: number; label: string }[]>([]);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !impact) { setLines([]); return; }
    const calc = () => {
      const br = box.getBoundingClientRect();
      const rect = (id: number) => {
        const el = box.querySelector<HTMLElement>(`[data-node="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { l: r.left - br.left, r: r.right - br.left, y: r.top - br.top + Math.min(r.height / 2, 34) };
      };
      const out: typeof lines = [];
      const sideOf = new Map(impact.nodes.map((n) => [n.id, n.side]));
      for (const e of tree.parent.values()) {
        const a = rect(e.from), b = rect(e.to);
        if (!a || !b) continue;
        // earlier task is on the right: leave from its left edge, enter the later task's right edge
        const x1 = a.l, y1 = a.y, x2 = b.r, y2 = b.y;
        const mx = (x1 + x2) / 2;
        const dy = y2 - y1;
        const r = Math.min(8, Math.abs(dy) / 2, Math.abs(x1 - mx));
        const s = Math.sign(dy);
        const d = Math.abs(dy) < 2
          ? `M${x1},${y1}H${x2}`
          : `M${x1},${y1}H${mx + r}Q${mx},${y1} ${mx},${y1 + s * r}V${y2 - s * r}Q${mx},${y2} ${mx - r},${y2}H${x2}`;
        const side = sideOf.get(e.from) === 'up' || sideOf.get(e.to) === 'up' ? 'up' : 'down';
        out.push({ key: `${e.from}-${e.to}-${e.dep_id}`, d, cls: `${side} ${e.driving ? 'driving' : ''}`, lx: 0, ly: 0, label: '' });
      }
      setLines(out);
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(box);
    return () => ro.disconnect();
  }, [impact, layout, sim, tree]);

  // bring the focused task to the middle of the map
  useLayoutEffect(() => {
    const center = () => {
      const c = boxRef.current?.querySelector<HTMLElement>('.ccard');
      const sc = boxRef.current?.parentElement;
      if (!c || !sc) return;
      const cr = c.getBoundingClientRect(), sr = sc.getBoundingClientRect();
      sc.scrollLeft += (cr.left + cr.width / 2) - (sr.left + sr.width / 2);
    };
    const raf = requestAnimationFrame(() => requestAnimationFrame(center));
    return () => cancelAnimationFrame(raf);
  }, [impact?.root]);

  const runSim = async (mode: 'delay' | 'cancel') => {
    if (!t) return;
    setBusy(true);
    try { setLocalSim(await api.post<SimResult>('/simulate', { task_id: t.id, mode, days })); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const showInGantt = () => {
    if (!sim || !t) return;
    if (sim.mode === 'delay') {
      const ghosts = new Map<number, { start: string; finish: string; shift: number }>();
      for (const m of sim.moved) ghosts.set(m.id, { start: m.to.start, finish: m.to.finish, shift: m.shift });
      ghosts.set(t.id, { start: t.start, finish: sim.self.to, shift: sim.days });
      setSim({ taskId: t.id, label: `"${t.name}" מתעכבת ב-${daysText(sim.days)} עבודה`, ghosts, blocked: new Set() });
    } else {
      setSim({ taskId: t.id, label: `"${t.name}" לא מתבצעת`, ghosts: new Map(), blocked: new Set(sim.blocked.map((b) => b.id)) });
    }
    openTask(t.id);
  };

  if (!t) {
    return (
      <div className="page focus-page">
        <div className="focus-empty">
          <Icon name="focus" size={40} />
          <h2>מפת השפעות</h2>
          <p>בחרו משימה, ותוצג בה כל השרשרת: מה משפיע על המשימה, מה מושפע ממנה, ואיפה היא יושבת בהיררכיה.</p>
          <div style={{ width: 420 }}><TaskPicker model={model} exclude={new Set()} placeholder="חיפוש משימה…" onPick={focusTask} /></div>
        </div>
      </div>
    );
  }

  const anc = model.ancestors(t.id).reverse();
  const pr = model.project(t.project_id)!;
  const edgeFor = (id: number) => tree.parent.get(id);

  return (
    <div className="page focus-page">
      <div className="focus-top">
        <div className="crumbs big">
          <span className="proj-chip" style={{ background: pr.color }} />
          <span>{pr.name}</span>
          {anc.map((a) => <span key={a} className="crumb-sep">›<button onClick={() => focusTask(a)}>{model.task(a)!.name}</button></span>)}
          <span className="crumb-sep">›<b>{t.name}</b></span>
        </div>
        <div className="focus-search"><TaskPicker model={model} exclude={new Set([t.id])} placeholder="מעבר למשימה אחרת…" onPick={focusTask} /></div>
      </div>

      <div className="whatif">
        <div className="wi-q">
          <Icon name="sim" size={18} />
          <span>מה קורה אם <b>{t.name}</b></span>
          <span className="wi-opt">
            מתעכבת ב-
            <input type="number" min={1} max={200} value={days} onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))} />
            ימי עבודה
            <button className="btn primary small" disabled={busy} onClick={() => runSim('delay')}>הדמיה</button>
          </span>
          <span className="wi-or">או</span>
          <button className="btn small" disabled={busy} onClick={() => runSim('cancel')}>לא מתבצעת בכלל</button>
          {sim && <button className="btn small ghost" onClick={() => setLocalSim(null)}>ניקוי</button>}
        </div>
        {sim && <SimSummary sim={sim} task={t} onShow={showInGantt} />}
      </div>

      <p className="focus-help">
        <span className="dot up" /> מימין: משימות שמשפיעות על המשימה &nbsp;·&nbsp; <span className="dot down" /> משמאל: משימות שמושפעות ממנה
        &nbsp;·&nbsp; קו מלא = קובע את התאריך בפועל &nbsp;·&nbsp; לחיצה על כרטיס עוברת למשימה
      </p>

      <div className="impact">
       <div className="impact-inner" ref={boxRef}>
        <svg className="impact-lines">
          {lines.map((l) => (
            <path key={l.key} d={l.d} className={`iline ${l.cls}`} />
          ))}
        </svg>
        {layout && (
          <div className="impact-grid">
            {layout.upCols.map((c) => (
              <Column key={c.key} title={c.level === 1 ? 'משפיעות ישירות' : `משפיעות בעקיפין · רמה ${c.level}`} side="up" empty={c.level === 1 && !c.ids.length ? 'שום משימה לא משפיעה עליה' : null}>
                {c.ids.map((id) => <NodeCard key={id} id={id} side="up" edge={edgeFor(id)} extra={tree.extra.get(id) || 0} shift={simMoved.get(id)} blocked={simBlocked.has(id)} />)}
              </Column>
            ))}
            <div className="impact-center">
              <Frames ancestors={anc} projectId={t.project_id}>
                <CenterCard t={t} shift={sim?.mode === 'delay' ? sim.days : undefined} />
              </Frames>
            </div>
            {layout.downCols.map((c) => (
              <Column key={c.key} title={c.level === 1 ? 'מושפעות ישירות' : `מושפעות בעקיפין · רמה ${c.level}`} side="down" empty={c.level === 1 && !c.ids.length ? 'שום משימה לא מחכה לה' : null}>
                {c.ids.map((id) => <NodeCard key={id} id={id} side="down" edge={edgeFor(id)} extra={tree.extra.get(id) || 0} shift={simMoved.get(id)} blocked={simBlocked.has(id)} />)}
              </Column>
            ))}
          </div>
        )}
       </div>
        {impact?.truncated && <p className="muted small" style={{ padding: 12 }}>השרשרת ארוכה במיוחד, ולכן מוצגות רק הרמות הקרובות.</p>}
      </div>
    </div>
  );
}

function Column({ title, side, children, empty }: { title: string; side: 'up' | 'down'; children: React.ReactNode; empty: string | null }) {
  return (
    <div className={`icol ${side}`}>
      <div className="icol-title"><span className={`dot ${side}`} />{title}</div>
      <div className="icol-body">
        {children}
        {empty && <div className="icol-empty">{empty}</div>}
      </div>
    </div>
  );
}

function NodeCard({ id, side, edge, extra, shift, blocked }: { id: number; side: 'up' | 'down'; edge?: ImpactEdge; extra: number; shift?: number; blocked?: boolean }) {
  const { model, focusTask } = useApp();
  const t = model.task(id);
  if (!t) return null;
  const pr = model.project(t.project_id)!;
  return (
    <button className={`ncard ${side} ${edge?.driving ? 'driving' : ''} ${blocked ? 'blocked' : ''} ${shift ? 'shifted' : ''}`} data-node={id} onClick={() => focusTask(id)}>
      <span className="ncard-stripe" style={{ background: pr.color }} />
      <span className="ncard-path">{model.path(id)}</span>
      <span className="ncard-name">{t.kind === 'milestone' && <Icon name="diamond" size={11} />} {t.name}</span>
      <span className="ncard-dates">{fmtDate(t.start)}{t.kind !== 'milestone' && ` – ${fmtDate(t.finish)}`}</span>
      <span className="ncard-foot">
        <span className={`st ${t.status}`} /> {STATUS_LABEL[t.status]} · {t.percent}%
        {t.children.length > 0 && <span className="muted"> · {t.children.length} תתי-משימות</span>}
      </span>
      {edge && <span className="ncard-dep">{depText(edge.type, edge.lag)}{edge.via ? ` · דרך "${model.task(edge.via)?.name}"` : ''}</span>}
      {extra > 0 && <span className="ncard-extra">קשורה גם ל-{extra === 1 ? 'משימה נוספת' : `${extra} משימות נוספות`} במפה</span>}
      {edge?.driving && side === 'up' && <span className="chip drive">קובעת את התאריך</span>}
      {shift ? <span className="sim-tag">+{daysText(shift)}</span> : null}
      {blocked && <span className="sim-tag blocked">חסומה</span>}
      {t.deadline_missed && <span className="chip bad">חורגת מתאריך היעד</span>}
    </button>
  );
}

function Frames({ ancestors, projectId, children }: { ancestors: number[]; projectId: number; children: React.ReactNode }) {
  const { model, focusTask, go } = useApp();
  const pr = model.project(projectId)!;
  let inner = children;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = model.task(ancestors[i])!;
    inner = (
      <div className="frame">
        <button className="frame-title" onClick={() => focusTask(a.id)}>
          <span className="wbs-tag">{a.wbs}</span>{a.name}<span className="muted"> · {a.children.length} תתי-משימות · {a.percent}%</span>
        </button>
        {inner}
      </div>
    );
  }
  return (
    <div className="frame project" style={{ borderColor: pr.color }}>
      <button className="frame-title" onClick={() => go('#/gantt')}>
        <span className="proj-chip" style={{ background: pr.color }} />{pr.name}<span className="muted"> · פרויקט · {pr.percent}%</span>
      </button>
      {inner}
    </div>
  );
}

function CenterCard({ t, shift }: { t: Task; shift?: number }) {
  const { model, focusTask, openTask } = useApp();
  const pr = model.project(t.project_id)!;
  const driving = model.relations(t.id).drivers.filter((r) => t.driving_dep_ids.includes(r.dep.id)).map((r) => model.task(r.other)?.name);
  const slip = t.baseline_finish ? toDay(t.finish) - toDay(t.baseline_finish) : 0;
  return (
    <div className="ccard" data-node={t.id}>
      <div className="ccard-head">
        <span className="wbs-tag">{t.wbs}</span>
        <h2>{t.kind === 'milestone' && <Icon name="diamond" size={16} />} {t.name}</h2>
        {shift ? <span className="sim-tag">+{daysText(shift)}</span> : null}
      </div>
      <div className="ccard-stats">
        <div><span>התחלה</span><b>{fmtDate(t.start)}</b></div>
        <div><span>סיום</span><b>{fmtDate(t.finish)}</b></div>
        {t.kind !== 'milestone' && <div><span>משך</span><b>{daysText(t.work_days)}</b></div>}
        <div><span>מצב</span><b><span className={`st ${t.status}`} /> {STATUS_LABEL[t.status]}</b></div>
        {model.ownerName(t.id) && <div><span>אחראי</span><b>{model.ownerName(t.id)}</b></div>}
        {t.deadline && <div><span>תאריך יעד</span><b className={t.deadline_missed ? 'bad' : ''}>{fmtDate(t.deadline)}</b></div>}
      </div>
      <div className="pct-bar big"><i style={{ width: `${t.percent}%`, background: pr.color }} /></div>
      <div className="ccard-notes">
        {driving.length > 0 && <p><b>מה קובע את מועד ההתחלה:</b> {driving.join(', ')}</p>}
        {t.constrained && <p><b>מועד ההתחלה נקבע ידנית</b> ({fmtDate(t.start_constraint)})</p>}
        {slip !== 0 && <p className={slip > 0 ? 'bad' : 'good'}><b>{slip > 0 ? 'מתעכבת' : 'מקדימה'} ב-{daysText(slip)}</b> לעומת התכנון המקורי ({fmtDate(t.baseline_finish)})</p>}
        {t.float != null && t.float > 0 && t.kind !== 'summary' && <p>מרווח: אפשר להתעכב עד {daysText(t.float)} עבודה בלי להזיז את סיום הפרויקט.</p>}
        {t.critical && <p className="bad">המשימה בנתיב הקריטי: כל עיכוב בה מזיז את סיום הפרויקט.</p>}
        {t.notes && <p className="muted">{t.notes}</p>}
      </div>
      {t.children.length > 0 && (
        <div className="ccard-kids">
          <div className="f-label">תתי-משימות ({t.children.length})</div>
          <div className="kids-grid">
            {t.children.map((c) => {
              const k = model.task(c)!;
              return (
                <button key={c} className="kid-card" onClick={() => focusTask(c)}>
                  <span className={`st ${k.status}`} />
                  <span className="kid-name">{k.kind === 'milestone' && <Icon name="diamond" size={10} />} {k.name}</span>
                  <span className="kid-meta">{fmtDate(k.finish)} · {k.percent}%{k.children.length ? ` · ${k.children.length} תתי-משימות` : ''}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="ccard-actions">
        <button className="btn" onClick={() => openTask(t.id)}><Icon name="gantt" size={15} /> הצגה בגאנט</button>
      </div>
    </div>
  );
}

function SimSummary({ sim, task, onShow }: { sim: SimResult; task: Task; onShow: () => void }) {
  const { model, focusTask } = useApp();
  const [all, setAll] = useState(false);
  const N = all ? 9999 : 8;
  if (sim.mode === 'cancel') {
    return (
      <div className="wi-result">
        {sim.blocked.length === 0
          ? <p className="good"><b>שום משימה אחרת לא תלויה בה.</b> אם היא לא תתבצע, שאר התוכנית לא נחסמת.</p>
          : <p className="bad"><b>{sim.blocked.length === 1 ? 'משימה אחת תיחסם' : `${sim.blocked.length} משימות ייחסמו`}</b>
            {sim.projects.length > 1 && <> ב-{sim.projects.length} פרויקטים ({sim.projects.map((p) => p.name).join(', ')})</>}.</p>}
        {sim.blocked.length > 0 && (
          <ul className="wi-list">
            {sim.blocked.slice(0, N).map((b) => (
              <li key={b.id}><button className="link" onClick={() => focusTask(b.id)}>{b.name}</button> <span className="muted">{b.path}</span>
                {b.deadline && <span className="chip bad">תאריך יעד {fmtDate(b.deadline)}</span>}</li>
            ))}
            {sim.blocked.length > N && <li><button className="link" onClick={() => setAll(true)}>הצגת כל {sim.blocked.length} המשימות</button></li>}
          </ul>
        )}
        {sim.blocked.length > 0 && <button className="btn small" onClick={onShow}>הצגה בגאנט</button>}
      </div>
    );
  }
  const other = sim.moved;
  return (
    <div className="wi-result">
      <p>סיום "{task.name}" יזוז מ-<b>{fmtDate(sim.self.from)}</b> ל-<b>{fmtDate(sim.self.to)}</b>.</p>
      {other.length === 0
        ? <p className="good"><b>אין השפעה על משימות אחרות.</b> יש מספיק מרווח בתוכנית כדי לספוג את העיכוב.</p>
        : <p className="bad"><b>{other.length === 1 ? 'משימה אחת נוספת תזוז' : `${other.length} משימות נוספות יזוזו`}</b> בעקבות העיכוב.</p>}
      {sim.projects.map((p) => <p key={p.id}>סיום הפרויקט <b>{p.name}</b> יזוז מ-{fmtDate(p.from)} ל-<b>{fmtDate(p.to)}</b>.</p>)}
      {sim.deadlines.map((d) => <p key={d.id} className="bad"><Icon name="alert" size={14} /> <b>{d.name}</b> תחרוג מתאריך היעד ({fmtDate(d.deadline)}). הסיום החדש: {fmtDate(d.finish)}.</p>)}
      {other.length > 0 && (
        <ul className="wi-list">
          {other.slice(0, N).map((m) => (
            <li key={m.id}><button className="link" onClick={() => focusTask(m.id)}>{m.name}</button> <span className="muted">{m.path || model.path(m.id)}</span>
              <span className="chip">{fmtDate(m.from.finish)} ← {fmtDate(m.to.finish)}</span> <span className="sim-tag">+{daysText(m.shift)}</span></li>
          ))}
          {other.length > N && <li><button className="link" onClick={() => setAll(true)}>הצגת כל {other.length} המשימות</button></li>}
        </ul>
      )}
      {other.length > 0 && <button className="btn small" onClick={onShow}>הצגה בגאנט</button>}
    </div>
  );
}
