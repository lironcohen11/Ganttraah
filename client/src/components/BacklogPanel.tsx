import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import type { BacklogItem, Task } from '../types';
import { Icon } from './Icon';

/**
 * The task pool (backlog): tasks that have no date yet. Kept apart from the plan on purpose: they
 * are not scheduled and not in the Gantt, the manager view or exports. Each one is placed in the
 * Gantt when it gets a date ("שיבוץ בגאנט"): it then becomes an ordinary task and leaves the pool.
 */
export function BacklogPanel({ onClose, onScheduled }: { onClose: () => void; onScheduled: (taskId: number) => void }) {
  const { model, user, isAdmin, canEdit, assignable, run } = useApp();
  const items = model.data.backlog || [];
  // dragged sideways from its head, like the task card (the place is kept)
  const panelRef = useRef<HTMLElement>(null);
  const [panelX, setPanelX] = useState<number>(() => { try { return Number(localStorage.getItem('gantraah.poolX')) || 0; } catch { return 0; } });
  useEffect(() => { try { localStorage.setItem('gantraah.poolX', String(panelX)); } catch { /* ignore */ } }, [panelX]);
  const maxX = () => { const el = panelRef.current, box = el?.parentElement; return el && box ? Math.max(0, box.clientWidth - el.offsetWidth - 20) : 0; };
  useEffect(() => { const m = maxX(); if (panelX > m) setPanelX(m); });
  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
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
  const [scope, setScope] = useState<'mine' | 'all'>(() => (isAdmin || user.unit_id == null ? 'all' : 'mine'));
  const [openId, setOpenId] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const adding = useRef(false);

  const mayEdit = (b: BacklogItem) => canEdit && (isAdmin || !!user.edit_all || (b.owner_unit_id != null && model.unitWithin(b.owner_unit_id, user.unit_id)));
  const shown = scope === 'mine' && user.unit_id != null
    ? items.filter((b) => b.owner_unit_id != null && model.unitWithin(b.owner_unit_id, user.unit_id)) : items;
  // grouped by the project it is expected to go to; items with no project last
  const groups = useMemo(() => {
    const out: { id: number | null; name: string; color: string; list: BacklogItem[] }[] = [];
    for (const p of model.projectList) {
      const list = shown.filter((b) => b.project_id === p.id);
      if (list.length) out.push({ id: p.id, name: p.name, color: p.color, list });
    }
    const none = shown.filter((b) => b.project_id == null || !model.project(b.project_id));
    if (none.length) out.push({ id: null, name: 'בלי פרויקט', color: '', list: none });
    return out;
  }, [shown, model]);

  const add = async () => {
    const name = newName.trim();
    if (!name || adding.current) return;
    adding.current = true;
    try {
      const r = await run(() => api.post<BacklogItem>('/backlog', { name }));
      if (r) { setNewName(''); setOpenId(r.id); }
    } finally { adding.current = false; }
  };

  return (
    <aside className="panel pool-panel" aria-label="Backlog" ref={panelRef} style={{ left: 10 + panelX }}>
      <div className="panel-drag" onPointerDown={startDrag} onDoubleClick={() => setPanelX(0)} role="separator" aria-orientation="vertical" aria-label="הזזת הפאנל ימינה או שמאלה">
        <span className="pd-arrow r"><Icon name="chevronRight" size={13} /></span>
        <span className="pd-dots"><Icon name="grip" size={16} /></span>
        <span className="pd-arrow l"><Icon name="chevronLeft" size={13} /></span>
      </div>
      <div className="panel-head pool-head" onPointerDown={startDrag} onDoubleClick={(e) => { if (!(e.target as HTMLElement).closest('button')) setPanelX(0); }}>
        <span className="pool-title"><Icon name="inbox" size={17} /> Backlog</span>
        <span className="pool-count">{items.length}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="סגירה (Esc)"><Icon name="x" /></button>
      </div>
      <div className="panel-body pool-body">
        <p className="pool-intro">משימות שעוד אין להן תאריך. הן <b>לא</b> מופיעות בגאנט ולא משפיעות על התוכנית, עד שמשבצים אותן.</p>

        {canEdit && (
          <div className="pool-add">
            <input value={newName} placeholder="משימה חדשה למאגר…" maxLength={500}
              onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
            <button className="btn primary small" disabled={!newName.trim()} onClick={add}><Icon name="plus" size={14} /> הוספה</button>
          </div>
        )}

        {user.unit_id != null && !isAdmin && (
          <div className="seg pool-scope">
            <button className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>של המסגרת שלי</button>
            <button className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>הכול</button>
          </div>
        )}

        {!shown.length && (
          <div className="pool-empty">
            {items.length ? 'אין במאגר משימות של המסגרת שלך.' : 'המאגר ריק. משימה שעוד אין לה מועד נכנסת לכאן, ומשבצים אותה בגאנט כשמתברר מתי.'}
          </div>
        )}

        {groups.map((g) => (
          <section key={g.id ?? 'none'} className="pool-group">
            <h4>{g.color ? <span className="proj-chip" style={{ background: g.color }} /> : null}{g.name}<span className="muted"> · {g.list.length}</span></h4>
            {g.list.map((b) => (
              <PoolItem key={b.id} item={b} open={openId === b.id} editable={mayEdit(b)} assignable={assignable}
                onToggle={() => setOpenId(openId === b.id ? null : b.id)} onScheduled={onScheduled} />
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}

function PoolItem({ item, open, editable, assignable, onToggle, onScheduled }: {
  item: BacklogItem; open: boolean; editable: boolean; assignable: { id: number; name: string }[];
  onToggle: () => void; onScheduled: (taskId: number) => void;
}) {
  const { model, run, isAdmin } = useApp();
  const owner = item.owner_unit_id != null ? model.units.get(item.owner_unit_id)?.name : null;
  const save = (patch: Record<string, unknown>) => run(() => api.patch(`/backlog/${item.id}`, patch));
  const [placing, setPlacing] = useState(false);
  useEffect(() => { if (!open) setPlacing(false); }, [open]);
  // the owner list: the units you may assign, and the current owner even when it is not one of them
  const owners = assignable.some((u) => u.id === item.owner_unit_id) || item.owner_unit_id == null
    ? assignable : [...assignable, { id: item.owner_unit_id, name: owner || '' }];

  return (
    <div className={`pool-item ${open ? 'open' : ''}`}>
      <button className="pool-item-head" onClick={onToggle} aria-expanded={open}>
        <span className="pool-name">{item.name}</span>
        <span className="pool-meta">
          {owner || 'בלי אחראי'}{item.duration ? ` · כ-${item.duration} ימי עבודה` : ''}
        </span>
        <Icon name={open ? 'chevronDown' : 'chevronLeft'} size={14} className="pool-chev" />
      </button>
      {open && (
        <div className="pool-item-body">
          {placing ? (
            <PlaceForm item={item} onCancel={() => setPlacing(false)} onDone={onScheduled} />
          ) : (
            <>
              <label className="field"><span className="f-label">שם</span>
                <Text value={item.name} disabled={!editable} onCommit={(v) => v.trim() && save({ name: v })} />
              </label>
              <div className="pool-row">
                <label className="field"><span className="f-label">פרויקט צפוי</span>
                  <select value={item.project_id ?? ''} disabled={!editable} onChange={(e) => save({ project_id: e.target.value || null })}>
                    <option value="">עוד לא ידוע</option>
                    {model.projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label className="field pool-dur"><span className="f-label">משך משוער</span>
                  <Text value={item.duration ?? ''} type="number" disabled={!editable} placeholder="ימים" onCommit={(v) => save({ duration: v || null })} />
                </label>
              </div>
              <label className="field"><span className="f-label">אחראי</span>
                <select value={item.owner_unit_id ?? ''} disabled={!editable} onChange={(e) => save({ owner_unit_id: e.target.value || null })}>
                  {(isAdmin || item.owner_unit_id == null) && <option value="">בלי אחראי</option>}
                  {owners.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
              <label className="field"><span className="f-label">הערות</span>
                <Text value={item.notes} type="textarea" disabled={!editable} placeholder="פרטים, למה עוד אין תאריך, ממה זה תלוי…" onCommit={(v) => save({ notes: v })} />
              </label>
              {editable && (
                <div className="pool-actions">
                  <button className="btn primary small" onClick={() => setPlacing(true)}><Icon name="gantt" size={14} /> שיבוץ בגאנט</button>
                  <span style={{ flex: 1 }} />
                  <button className="btn small danger-outline" onClick={() => { if (confirm(`למחוק את "${item.name}" מהמאגר?`)) run(() => api.del(`/backlog/${item.id}`)); }}>
                    <Icon name="trash" size={14} /> מחיקה
                  </button>
                </div>
              )}
              {!editable && <p className="f-hint">רק {owner ? `"${owner}" ומי שמעליה` : 'הנהלת הענף'} יכולים לשנות ולשבץ את המשימה הזו.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** choosing where and when the item goes: project, parent task (optional), start date and length */
function PlaceForm({ item, onCancel, onDone }: { item: BacklogItem; onCancel: () => void; onDone: (taskId: number) => void }) {
  const { model, run } = useApp();
  const [projectId, setProjectId] = useState<number | ''>(item.project_id && model.project(item.project_id) ? item.project_id : (model.projectList[0]?.id ?? ''));
  const [parentId, setParentId] = useState<number | ''>('');
  const [start, setStart] = useState(model.data.today);
  const [duration, setDuration] = useState(String(item.duration || 5));
  const [busy, setBusy] = useState(false);
  // the tasks of the chosen project, in the order of the Gantt, to put the new task under one of them
  const parents = useMemo(() => {
    const out: Task[] = [];
    const p = projectId === '' ? null : model.project(projectId);
    const walk = (ids: number[]) => ids.forEach((id) => { const t = model.task(id); if (t && t.input_kind !== 'milestone') { out.push(t); walk(t.children); } });
    if (p) walk(p.roots);
    return out;
  }, [projectId, model]);
  useEffect(() => setParentId(''), [projectId]);
  const ok = projectId !== '' && !!start && Number(duration) >= 1;
  const place = async () => {
    if (!ok || busy) return;
    setBusy(true);
    try {
      const t = await run(() => api.post<Task>(`/backlog/${item.id}/schedule`, { project_id: projectId, parent_id: parentId === '' ? null : parentId, start, duration: Number(duration) }),
        `"${item.name}" שובצה בגאנט`);
      if (t) onDone(t.id);
    } finally { setBusy(false); }
  };
  if (!model.projectList.length) return <p className="f-hint">אין עדיין פרויקטים. צריך ליצור פרויקט קודם. <button className="link" onClick={onCancel}>חזרה</button></p>;
  return (
    <div className="pool-place">
      <p className="pool-place-title">שיבוץ "{item.name}" בגאנט</p>
      <label className="field"><span className="f-label">פרויקט</span>
        <select value={projectId} onChange={(e) => setProjectId(Number(e.target.value))}>
          {model.projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label className="field"><span className="f-label">בתוך</span>
        <select value={parentId} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">ישירות בפרויקט (רמה עליונה)</option>
          {parents.map((t) => <option key={t.id} value={t.id}>{'  '.repeat(t.level)}{t.wbs} {t.name}</option>)}
        </select>
      </label>
      <div className="pool-row">
        <label className="field"><span className="f-label">התחלה</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </label>
        <label className="field pool-dur"><span className="f-label">משך (ימי עבודה)</span>
          <input type="number" min={1} max={5000} value={duration} onChange={(e) => setDuration(e.target.value)} />
        </label>
      </div>
      <p className="f-hint">אחרי השיבוץ זו משימה רגילה בגאנט: אפשר לגרור אותה, לחבר אליה תלויות ולשנות את התאריך. היא יוצאת מהמאגר.</p>
      <div className="pool-actions">
        <button className="btn primary small" disabled={!ok || busy} onClick={place}><Icon name="check" size={14} /> שיבוץ</button>
        <button className="btn small ghost" onClick={onCancel}>ביטול</button>
      </div>
    </div>
  );
}

/** a field that saves on leaving it or on Enter (like the task panel) */
function Text({ value, onCommit, type = 'text', disabled, placeholder }: {
  value: string | number; onCommit: (v: string) => unknown; type?: 'text' | 'number' | 'textarea'; disabled?: boolean; placeholder?: string;
}) {
  const [v, setV] = useState(String(value ?? ''));
  useEffect(() => setV(String(value ?? '')), [value]);
  const commit = () => { if (v !== String(value ?? '')) onCommit(v); };
  if (type === 'textarea') {
    return <textarea className="pool-notes" value={v} disabled={disabled} placeholder={placeholder} rows={3}
      onChange={(e) => setV(e.target.value)} onBlur={commit} />;
  }
  return <input type={type} value={v} disabled={disabled} placeholder={placeholder} min={type === 'number' ? 1 : undefined}
    onChange={(e) => setV(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />;
}
