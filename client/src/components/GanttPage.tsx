import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import { buildRows, type Row } from '../model';
import type { Task } from '../types';
import { Gantt, Legend, ZOOMS, type Zoom } from './Gantt';
import { TaskPanel } from './TaskPanel';
import { ProjectDialog } from './ProjectDialog';
import { Icon } from './Icon';
import { OwnerFilter } from './OwnerFilter';
import { exportExcel, exportMsProject, download, fileStamp } from '../export';
import { ImportDialog } from './ImportDialog';

const ls = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem('gantraah.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem('gantraah.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

/** A button that opens a small menu under it, closed by clicking anywhere else. */
function Dropdown({ label, children, className, tour }: { label: React.ReactNode; children: (close: () => void) => React.ReactNode; className?: string; tour?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <span className="dd" ref={ref} data-tour={tour}>
      <button className={`btn ${className || ''} ${open ? 'pressed' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>{label}</button>
      {open && <div className="dd-menu">{children(() => setOpen(false))}</div>}
    </span>
  );
}

export function GanttPage({ openRequest }: { openRequest: { id: number; n: number } | null }) {
  const { model, user, canEdit, canEditTask, isAdmin, run, toast, focusTask, sim, setSim, undoRedo } = useApp();
  const [owners, setOwners] = useState<number[]>(() => ls.get('owners', []));
  const [zoom, setZoom] = useState<Zoom>(() => ls.get('zoom', 'week'));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(ls.get<string[]>('collapsed', [])));
  const [filter, setFilter] = useState<number[] | null>(() => ls.get('filter', null));
  const [allProjects, setAllProjects] = useState(() => ls.get('allProjects', false));
  const [favOnly, setFavOnly] = useState(() => ls.get('favOnly', false));
  const [showBaseline, setShowBaseline] = useState(() => ls.get('baseline.v2', false));
  const [showCritical, setShowCritical] = useState(() => ls.get('critical', false));
  const [chainOn, setChainOn] = useState(() => ls.get('chain.v2', false));
  const [nameW, setNameW] = useState(() => ls.get('nameW', 280));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [panelId, setPanelId] = useState<number | null>(null);
  const [projDialog, setProjDialog] = useState<number | 'new' | null>(null);
  const [scrollToken, setScrollToken] = useState(0);
  const [revealId, setRevealId] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => ls.set('zoom', zoom), [zoom]);
  useEffect(() => ls.set('collapsed', [...collapsed]), [collapsed]);
  useEffect(() => ls.set('filter', filter), [filter]);
  useEffect(() => ls.set('owners', owners), [owners]);
  useEffect(() => ls.set('allProjects', allProjects), [allProjects]);
  useEffect(() => ls.set('favOnly', favOnly), [favOnly]);
  useEffect(() => ls.set('baseline.v2', showBaseline), [showBaseline]);
  useEffect(() => ls.set('critical', showCritical), [showCritical]);
  useEffect(() => ls.set('chain.v2', chainOn), [chainOn]);
  useEffect(() => ls.set('nameW', nameW), [nameW]);

  const projectIds = filter?.filter((id) => model.project(id)) ?? null;
  const ownerIds = owners.filter((id) => model.units.has(id));
  const favSet = favOnly ? model.favorites : null;
  const rows = useMemo(() => buildRows(model, { projectIds: projectIds?.length ? projectIds : null, collapsed, owners: ownerIds, only: favSet }),
    [model, projectIds?.join(','), collapsed, ownerIds.join(','), favSet]);
  const selectedRow = rows.find((r) => r.key === selectedKey) || null;
  const selTask = selectedRow?.type === 'task' ? selectedRow.task : null;
  const selEditable = !!selTask && canEditTask(selTask.id);
  const highlight = useMemo(() => (chainOn && selTask ? model.chain(selTask.id) : null), [chainOn, selTask, model]);

  // "my projects": the ones that hold tasks of my unit or of the units below it
  const myUnits = useMemo(() => (isAdmin || user.unit_id == null ? [] : model.unitSubtree(user.unit_id)), [model, isAdmin, user.unit_id]);
  const mine = model.projectList.filter((p) => model.projectHasUnit(p.id, myUnits));
  const others = model.projectList.length - mine.length;
  const chipProjects = allProjects || !others ? model.projectList : model.projectList.filter((p) => mine.includes(p) || projectIds?.includes(p.id));

  const reveal = (id: number) => {
    const t = model.task(id);
    if (!t) return;
    const keys = ['p:' + t.project_id, ...model.ancestors(id).map((a) => 't:' + a)];
    setCollapsed((c) => { const n = new Set(c); keys.forEach((k) => n.delete(k)); return n; });
    if (projectIds?.length && !projectIds.includes(t.project_id)) setFilter(null);
    // a task hidden by the owner or favourites filter: show everything rather than nothing
    const o = model.effOwner(id).unit;
    if (ownerIds.length && !(o != null && ownerIds.some((u) => model.unitWithin(o, u)))) setOwners([]);
    if (favOnly && !model.favorites.has(id) && !model.ancestors(id).some((a) => model.favorites.has(a))) setFavOnly(false);
    setSelectedKey('t:' + id);
    setPanelId(id);
    setTimeout(() => setRevealId(id), 30);
  };
  useEffect(() => { if (openRequest) reveal(openRequest.id); /* eslint-disable-next-line */ }, [openRequest?.n]);
  useEffect(() => { if (panelId && !model.task(panelId)) setPanelId(null); }, [model, panelId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input,textarea,select')) { setSelectedKey(null); setPanelId(null); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const onSelectRow = (r: Row | null) => {
    if (!r) { setSelectedKey(null); return; }
    setSelectedKey(r.key);
    if (r.type === 'task') setPanelId(r.task.id);
    else setPanelId(null);
  };
  const toggle = (key: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const addTask = async (kind: 'task' | 'milestone', asChild = false) => {
    const body: Record<string, unknown> = { kind };
    if (!selectedRow || selectedRow.type === 'group') {
      const p = (projectIds?.length ? model.project(projectIds[0]) : null) || mine[0] || model.projectList[0];
      if (!p) { toast('צריך ליצור פרויקט קודם', 'error'); return; }
      body.project_id = p.id;
    } else if (selectedRow.type === 'project') body.project_id = selectedRow.project.id;
    else {
      const t = selectedRow.task;
      body.project_id = t.project_id;
      if (asChild) { body.parent_id = t.id; body.first = true; } // right under the task it was opened in
      else { body.parent_id = t.parent_id; body.after_id = t.id; }
    }
    const r = await run(() => api.post<Task>('/tasks', body));
    if (r) {
      if (asChild && selTask) setCollapsed((c) => { const n = new Set(c); n.delete('t:' + selTask.id); return n; });
      setCollapsed((c) => { const n = new Set(c); n.delete('p:' + r.project_id); return n; });
      if (favOnly) setFavOnly(false);
      setSelectedKey('t:' + r.id);
      setPanelId(r.id);
      setTimeout(() => setRevealId(r.id), 60);
    }
  };

  const move = (t: Task, dir: 'in' | 'out' | 'up' | 'down') => {
    const sibs = model.siblings(t);
    const idx = sibs.indexOf(t.id);
    if (dir === 'in') {
      if (idx <= 0) return toast('אין משימה מעליה שאפשר להכניס אליה', 'error');
      const parent = model.task(sibs[idx - 1])!;
      setCollapsed((c) => { const n = new Set(c); n.delete('t:' + parent.id); return n; });
      return run(() => api.post(`/tasks/${t.id}/move`, { parent_id: parent.id, index: parent.children.length }));
    }
    if (dir === 'out') {
      if (t.parent_id == null) return;
      const parent = model.task(t.parent_id)!;
      const gsibs = model.siblings(parent);
      return run(() => api.post(`/tasks/${t.id}/move`, { parent_id: parent.parent_id, project_id: t.project_id, index: gsibs.indexOf(parent.id) + 1 }));
    }
    const ni = dir === 'up' ? idx - 1 : idx + 1;
    if (ni < 0 || ni >= sibs.length) return;
    return run(() => api.post(`/tasks/${t.id}/move`, { parent_id: t.parent_id, project_id: t.project_id, index: ni }));
  };

  const ghosts = sim?.ghosts ?? null;
  const favCount = model.favorites.size;

  return (
    <div className="page gantt-page">
      <div className="toolbar">
        {canEdit && (
          <div className="tb-group icons" data-tour="undo">
            {(['undo', 'redo'] as const).map((k) => {
              const e = model.data.undo?.[k];
              const name = k === 'undo' ? 'ביטול' : 'ביצוע שוב';
              const keys = k === 'undo' ? 'Ctrl+Z' : 'Ctrl+Y';
              return (
                <button key={k} className="icon-btn" disabled={!e || e.blocked} onClick={() => undoRedo(k)}
                  title={!e ? `${name} (${keys})` : e.blocked ? `${name}: לא אפשרי, מישהו אחר שינה את התוכנית בינתיים` : `${name}: ${e.label} (${keys})`}>
                  <Icon name={k} size={17} />
                </button>
              );
            })}
          </div>
        )}
        {canEdit && (
          <div className="tb-group">
            <Dropdown tour="add" className="primary" label={<><Icon name="plus" size={15} /> יצירה <Icon name="chevronDown" size={13} /></>}>
              {(close) => (
                <>
                  <button className="dd-item" onClick={() => { close(); addTask('task'); }}>
                    <Icon name="plus" size={15} /><span><b>משימה</b><small>באותה רמה של המשימה המסומנת</small></span>
                  </button>
                  <button className="dd-item" disabled={!selTask} onClick={() => { close(); addTask('task', true); }}>
                    <Icon name="layers" size={15} /><span><b>תת-משימה</b><small>{selTask ? `בתוך "${selTask.name}"` : 'קודם מסמנים משימה'}</small></span>
                  </button>
                  <button className="dd-item" onClick={() => { close(); addTask('milestone'); }}>
                    <Icon name="diamond" size={14} /><span><b>אבן דרך</b><small>נקודה בזמן, בלי משך</small></span>
                  </button>
                  {isAdmin && (
                    <button className="dd-item" onClick={() => { close(); setProjDialog('new'); }}>
                      <Icon name="gantt" size={15} /><span><b>פרויקט</b><small>פרויקט חדש בתוכנית</small></span>
                    </button>
                  )}
                </>
              )}
            </Dropdown>
          </div>
        )}
        {canEdit && (
          <div className="tb-group icons">
            <button className="icon-btn" disabled={!selEditable} onClick={() => selTask && move(selTask, 'in')} title="הכנס לתוך המשימה שמעליה"><Icon name="indent" /></button>
            <button className="icon-btn" disabled={!selEditable || !selTask?.parent_id} onClick={() => selTask && move(selTask, 'out')} title="הוצא רמה אחת החוצה"><Icon name="outdent" /></button>
            <button className="icon-btn" disabled={!selEditable} onClick={() => selTask && move(selTask, 'up')} title="הזז למעלה"><Icon name="up" /></button>
            <button className="icon-btn" disabled={!selEditable} onClick={() => selTask && move(selTask, 'down')} title="הזז למטה"><Icon name="down" /></button>
          </div>
        )}
        <div className="tb-group">
          <div className="seg">
            {ZOOMS.map((z) => <button key={z.id} className={zoom === z.id ? 'on' : ''} onClick={() => setZoom(z.id)}>{z.label}</button>)}
          </div>
          <button className="btn" onClick={() => setScrollToken((n) => n + 1)}><Icon name="today" size={15} /> היום</button>
        </div>
        <div className="tb-group">
          <label className="toggle"><input type="checkbox" checked={chainOn} onChange={(e) => setChainOn(e.target.checked)} /> הצגת התלויות</label>
          <label className="toggle"><input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} /> תכנון מול ביצוע</label>
          <label className="toggle"><input type="checkbox" checked={showCritical} onChange={(e) => setShowCritical(e.target.checked)} /> נתיב קריטי</label>
        </div>
        <div className="tb-end" data-tour="owners">
          <OwnerFilter model={model} value={owners} onChange={setOwners} />
          <Dropdown label={<><Icon name="file" size={15} /> קובץ</>}>
            {(close) => {
              // what is exported: everything the current filters show, with every level open
              const scope = () => ({
                rows: buildRows(model, { projectIds: projectIds?.length ? projectIds : null, collapsed: new Set(), owners: ownerIds, only: favSet }),
                title: projectIds?.length === 1 ? model.project(projectIds[0])!.name : 'תכנית העבודה',
              });
              const fname = (ext: string) => `${scope().title} ${fileStamp(model.data.today)}.${ext}`;
              return (
                <>
                  <button className="dd-item" onClick={() => { close(); download(fname('xlsx'), exportExcel(model, scope()), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }}>
                    <Icon name="table" size={15} /><span><b>Excel</b><small>שני גיליונות: גאנט לפי שבועות, ורשימת משימות</small></span>
                  </button>
                  <button className="dd-item" onClick={() => { close(); download(fname('xml'), exportMsProject(model, scope()), 'application/xml'); }}>
                    <Icon name="file" size={15} /><span><b>XML של MS Project</b><small>נפתח ב-MS Project ובכלי תכנון אחרים</small></span>
                  </button>
                  <p className="dd-note">מיוצא מה שמוצג עכשיו לפי הסינון (פרויקטים, אחראים, מועדפים), עם כל הרמות פתוחות.</p>
                  {canEdit && <>
                    <div className="dd-sep" />
                    <button className="dd-item quiet" onClick={() => { close(); setImporting(true); }}>
                      <Icon name="upload" size={14} /><span><b>ייבוא מקובץ Excel / CSV</b><small>ניסיוני</small></span>
                    </button>
                  </>}
                </>
              );
            }}
          </Dropdown>
          <Dropdown label={<><Icon name="legend" size={15} /> מקרא</>}>
            {() => <Legend showBaseline={showBaseline} showCritical={showCritical} />}
          </Dropdown>
        </div>
      </div>

      <div className="filters" data-tour="filters">
        <button className={`fchip ${!projectIds?.length ? 'on' : ''}`} onClick={() => setFilter(null)}>הכול</button>
        {chipProjects.map((p) => {
          const on = !!projectIds?.includes(p.id);
          return (
            <span key={p.id} className={`fchip ${on ? 'on' : ''}`}>
              <button onClick={() => setFilter(on ? (projectIds!.filter((x) => x !== p.id)) : [...(projectIds || []), p.id])} title={`${p.name}: ${p.percent}% הושלמו`}>
                <span className="proj-chip" style={{ background: p.color }} />{p.name}<span className="fchip-pct">{p.percent}%</span>
              </button>
              {isAdmin && <button className="fchip-edit" title="עריכת פרויקט" onClick={() => setProjDialog(p.id)}><Icon name="edit" size={12} /></button>}
            </span>
          );
        })}
        {others > 0 && (
          <button className="link small more-proj" onClick={() => setAllProjects(!allProjects)}>
            {allProjects ? 'רק הפרויקטים שלי' : `+ עוד ${others === 1 ? 'פרויקט אחד' : `${others} פרויקטים`}`}
          </button>
        )}
        <span className="filters-sep" />
        <button className={`fchip fav ${favOnly ? 'on' : ''}`} onClick={() => setFavOnly(!favOnly)} disabled={!favCount && !favOnly}
          title={favCount ? 'הצגת המשימות שסימנת בכוכב בלבד' : 'עוד לא סימנת משימות. מסמנים בכוכב שבפאנל המשימה.'}>
          <Icon name="star" size={13} fill={favOnly ? 'currentColor' : undefined} /> מועדפים{favCount ? ` (${favCount})` : ''}
        </button>
        {selTask && highlight && (highlight.up.size > 0 || highlight.down.size > 0) && (
          <span className="chain-info">
            <span className="dot up" /> {highlight.up.size} משפיעות
            <span className="dot down" /> {highlight.down.size} מושפעות
            <button className="link" onClick={() => focusTask(selTask.id)}>למפת התלויות ›</button>
          </span>
        )}
      </div>

      {sim && (
        <div className="sim-banner">
          <Icon name="sim" size={16} /> <b>הדמיה:</b> {sim.label}. המיקום החדש של כל משימה מסומן במסגרת מקווקוות, והתוכנית עצמה לא השתנתה.
          <button className="btn small" onClick={() => setSim(null)}>ניקוי ההדמיה</button>
        </div>
      )}

      <div className="gantt-main">
        <Gantt model={model} rows={rows} mode="edit" zoom={zoom} selectedKey={selectedKey}
          onSelectRow={onSelectRow}
          onOpenRow={(r) => { if (r.type === 'project' && isAdmin) setProjDialog(r.project.id); if (r.type === 'task') focusTask(r.task.id); }}
          highlight={highlight} showBaseline={showBaseline} showCritical={showCritical} showOwners
          collapsed={collapsed} onToggle={toggle} editable={canEdit} canEditTask={canEditTask}
          onMoveTask={(id, start) => run(() => api.patch(`/tasks/${id}`, { start_constraint: start }))}
          onResizeTask={(id, duration) => run(() => api.patch(`/tasks/${id}`, { duration }))}
          onLink={(a, b) => run(() => api.post('/dependencies', { predecessor_id: a, successor_id: b, type: 'FS' }), 'התלות נוספה')}
          onRename={(id, name) => run(() => api.patch(`/tasks/${id}`, { name }))}
          ghosts={ghosts} blocked={sim?.blocked ?? null}
          nameW={nameW} onNameW={setNameW}
          scrollToken={scrollToken} revealId={revealId} />
        {panelId != null && model.task(panelId) && <TaskPanel key={panelId} taskId={panelId} onClose={() => { setPanelId(null); }} />}
      </div>

      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {projDialog != null && (
        <ProjectDialog project={projDialog === 'new' ? null : model.project(projDialog) || null}
          onClose={(created) => { setProjDialog(null); if (created) { setSelectedKey('p:' + created); if (projectIds?.length) setFilter([...projectIds, created]); } }} />
      )}
    </div>
  );
}
