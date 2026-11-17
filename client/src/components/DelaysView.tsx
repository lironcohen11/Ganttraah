import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import { DELAY_REASONS } from '../model';
import { fmtDate } from '../dates';

const workDays = (n: number) => (n === 1 ? 'יום עבודה אחד' : `${n} ימי עבודה`);
import { Icon } from './Icon';

interface DelayRow {
  id: number; at: string; task_id: number; name: string; kind: string; project_id: number; owner_unit_id: number | null;
  user_name: string; reason: string | null; reason_other: string; description: string;
  cause_task_id: number | null; cause_name: string | null; from_finish: string | null; to_finish: string | null; days: number | null;
}

/** a word in the sentence that opens a list: "all", or one or more items */
function MultiPick<K extends string | number>({ value, onChange, items, all, many }: {
  value: K[]; onChange: (v: K[]) => void; items: { id: K; label: string; color?: string }[]; all: string; many: (n: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const valid = value.filter((id) => items.some((x) => x.id === id));
  const label = !valid.length ? all : valid.length === 1 ? items.find((x) => x.id === valid[0])!.label : many(valid.length);
  const toggle = (id: K) => onChange(valid.includes(id) ? valid.filter((x) => x !== id) : [...valid, id]);
  return (
    <span className="dl-pp" ref={ref}>
      <button type="button" className="dl-pick" onClick={() => setOpen(!open)}>{label}<Icon name="down" size={16} /></button>
      {open && (
        <div className="dl-pop">
          <button type="button" className={`dl-all ${!valid.length ? 'on' : ''}`} onClick={() => { onChange([]); setOpen(false); }}>{all}</button>
          {items.map((x) => (
            <label key={String(x.id)} className="dl-proj">
              <input type="checkbox" checked={valid.includes(x.id)} onChange={() => toggle(x.id)} />
              {x.color && <span className="proj-chip" style={{ background: x.color }} />}{x.label}
            </label>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * The "delays" tab of the history page: everything postponed for a chosen reason, in the chosen
 * projects (or the whole plan), optionally of one owner. Each task with its reason and description,
 * and the task that pushed it when it moved because of another one.
 */
export function DelaysView() {
  const { model, focusTask, toast } = useApp();
  const [rows, setRows] = useState<DelayRow[] | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [projects, setProjects] = useState<number[]>([]);
  const [owner, setOwner] = useState('');
  const [withDeps, setWithDeps] = useState(false);
  useEffect(() => { api.get<DelayRow[]>('/delays').then(setRows).catch((e) => toast(e.message, 'error')); }, [model]);

  const shown = useMemo(() => (rows || []).filter((r) =>
    (withDeps || r.cause_task_id == null)
    && (!reasons.length || (r.reason != null && reasons.includes(r.reason)))
    && (!projects.length || projects.includes(r.project_id))
    && (!owner || (r.owner_unit_id != null && model.unitWithin(r.owner_unit_id, Number(owner)))))
    // in the order they happened
    .sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id), [rows, withDeps, reasons, projects, owner, model]);
  const tasks = new Set(shown.map((r) => r.task_id)).size;
  const days = shown.reduce((s, r) => s + (r.cause_task_id == null ? r.days || 0 : 0), 0);
  // all reasons: one heading per reason (in the list's order), its postponements under it
  const groups = useMemo(() => {
    if (reasons.length === 1) return [{ key: reasons[0], title: '', rows: shown }];
    const by = new Map<string, DelayRow[]>();
    for (const r of shown) { const k = r.reason || ''; by.set(k, [...(by.get(k) || []), r]); }
    return [...Object.keys(DELAY_REASONS), ''].filter((k) => by.has(k))
      .map((k) => ({ key: k || 'none', title: k ? DELAY_REASONS[k] : 'בלי סיבה', rows: by.get(k)! }));
  }, [shown, reasons]);

  const card = (r: DelayRow) => {
    const pr = model.project(r.project_id);
    const ownerName = r.owner_unit_id != null ? model.units.get(r.owner_unit_id)?.name : '';
    return (
      <li key={r.id} className="dl-item">
        <button className="dl-name" onClick={() => focusTask(r.task_id)}>{r.kind === 'milestone' && <Icon name="diamond" size={13} />} {r.name}</button>
        <div className="dl-meta">
          {pr && <span className="dl-proj-tag"><span className="proj-chip" style={{ background: pr.color }} />{pr.name}</span>}
          {ownerName && <span>{ownerName}</span>}
        </div>
        <div className="dl-when">
          <b>{r.days ? `נדחתה ב${r.days === 1 ? 'יום עבודה אחד' : `-${r.days} ימי עבודה`}` : 'נדחתה'}</b>
          {r.from_finish && r.to_finish && <span> · הסיום זז מ-<bdi>{fmtDate(r.from_finish)}</bdi> ל-<bdi>{fmtDate(r.to_finish)}</bdi></span>}
        </div>
        {r.reason === 'other' && r.reason_other && <div className="dl-other">{r.reason_other}</div>}
        {r.cause_task_id != null && (
          <div className="dl-cause">בעקבות דחייה של {r.cause_name
            ? <button className="link" onClick={() => focusTask(r.cause_task_id!)}>"{r.cause_name}" ›</button>
            : <b>משימה שנמחקה</b>}</div>
        )}
        {r.description && <p className="dl-desc">{r.description}</p>}
        <div className="dl-foot">{r.user_name} · <bdi>{fmtDate(r.at.slice(0, 10))}</bdi></div>
      </li>
    );
  };

  return (
    <div className="dl">
      <h2 className="dl-head">
        כל מה שנדחה בשל{' '}
        <MultiPick value={reasons} onChange={setReasons} all="כל סיבה" many={(n) => `${n} סיבות`}
          items={Object.entries(DELAY_REASONS).map(([id, label]) => ({ id, label }))} />{' '}
        מתוך <MultiPick value={projects} onChange={setProjects} all="התכנית כולה" many={(n) => `${n} פרויקטים`}
          items={model.projectList.map((p) => ({ id: p.id, label: p.name, color: p.color }))} />
      </h2>

      <div className="dl-bar">
        <label>אחראי
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">כל האחראים</option>
            {model.unitTree().map(({ unit, depth }) => <option key={unit.id} value={unit.id}>{'   '.repeat(depth)}{unit.name}</option>)}
          </select>
        </label>
        <label className="toggle"><input type="checkbox" checked={withDeps} onChange={(e) => setWithDeps(e.target.checked)} /> גם משימות שזזו בעקבות דחייה של משימה אחרת</label>
        <span className="muted dl-sum">
          {shown.length === 1 ? 'דחייה אחת' : `${shown.length} דחיות`}{tasks !== shown.length ? ` של ${tasks} משימות` : ''}{days ? ` · סה"כ ${workDays(days)}` : ''}
        </span>
      </div>

      {rows == null ? <p className="muted">טוען…</p>
        : !shown.length ? <p className="muted dl-empty">{rows.length ? 'אין דחיות שמתאימות לבחירה.' : 'עוד לא נדחו משימות. דחייה של משימה שנשמר לה תכנון מקורי נרשמת כאן עם הסיבה שלה.'}</p>
        : groups.map((g) => (
          <section key={g.key} className="dl-group">
            {g.title && <h3 className="dl-gh">{g.title}<span className="dl-gn">{g.rows.length}</span></h3>}
            <ul className="dl-grid">{g.rows.map(card)}</ul>
          </section>
        ))}
    </div>
  );
}
