import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import type { AuditEntry } from '../types';
import { fmtDateTime, fmtDate, daysText } from '../dates';
import { Icon } from './Icon';

const ACTION_LABEL: Record<string, string> = { create: 'יצירה', update: 'עדכון', delete: 'מחיקה', move: 'העברה', baseline: 'תכנון מקורי', undo: 'ביטול', redo: 'ביצוע שוב' };

const PAGE = 300;
type HistoryMeta = { count: number; people: string[]; actions: string[]; days: number };

export function HistoryView() {
  const { model, focusTask, toast } = useApp();
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [meta, setMeta] = useState<HistoryMeta>({ count: 0, people: [], actions: [], days: 365 });
  const [project, setProject] = useState('');
  const [who, setWho] = useState('');
  const [action, setAction] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  // filtering runs on the server, so it covers the whole year and not only the rows loaded so far
  const filter = useMemo(() => {
    const q = new URLSearchParams();
    if (project) q.set('project_id', project);
    if (who) q.set('user', who);
    if (action) q.set('action', action);
    return q.toString();
  }, [project, who, action]);
  const shownRef = useRef(0);
  shownRef.current = rows.length;
  const filterRef = useRef(filter);
  // on a filter change start from the newest page; on a live change reload as many rows as are shown
  useEffect(() => {
    const changed = filterRef.current !== filter;
    filterRef.current = filter;
    const limit = changed ? PAGE : Math.min(1000, Math.max(PAGE, shownRef.current));
    Promise.all([api.get<AuditEntry[]>(`/history?limit=${limit}&${filter}`), api.get<HistoryMeta>(`/history/meta?${filter}`)])
      .then(([r, m]) => { if (filterRef.current === filter) { setRows(r); setMeta(m); } })
      .catch((e) => toast(e.message, 'error'));
  }, [model, filter]);
  const more = () => {
    if (!rows.length || loading) return;
    setLoading(true);
    api.get<AuditEntry[]>(`/history?limit=${PAGE}&before=${rows[rows.length - 1].id}&${filter}`)
      .then((r) => setRows((s) => [...s, ...r.filter((x) => !s.some((y) => y.id === x.id))]))
      .catch((e) => toast(e.message, 'error'))
      .finally(() => setLoading(false));
  };
  const people = useMemo(() => [...meta.people].sort((a, b) => a.localeCompare(b, 'he')), [meta.people]);
  const actions = meta.actions;
  const shown = rows;
  const any = project || who || action;
  const keep = meta.days === 365 ? 'שנה' : `${meta.days} ימים`;
  return (
    <div className="page history-page">
      <div className="page-head col">
        <h1>היסטוריית שינויים</h1>
        <p className="muted">כל שינוי בתוכנית נרשם כאן: מי שינה, מה שינה, מתי, ואילו משימות זזו בעקבות השינוי. נשמרים השינויים של ה{keep} האחרונה, וישנים יותר נמחקים מעצמם.</p>
        <div className="hist-filters">
          <Icon name="filter" size={15} />
          <label>פרויקט
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">הכול</option>
              {model.projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>מי שינה
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">כולם</option>
              {people.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label>סוג פעולה
            <select value={action} onChange={(e) => setAction(e.target.value)}>
              <option value="">הכול</option>
              {actions.map((a) => <option key={a} value={a}>{ACTION_LABEL[a] || a}</option>)}
            </select>
          </label>
          {any && <button className="link" onClick={() => { setProject(''); setWho(''); setAction(''); }}>ניקוי הסינון</button>}
          <span className="muted small">{any ? (meta.count === 1 ? 'שינוי אחד מתאים' : `${meta.count} שינויים מתאימים`) : `${meta.count === 1 ? 'שינוי אחד' : `${meta.count} שינויים`} ב${keep} האחרונה`}</span>
        </div>
      </div>
      <div className="hist-table">
        <div className="hist-row head"><span>מתי</span><span>מי</span><span>פעולה</span><span>מה השתנה</span></div>
        {shown.map((h) => {
          const moved = h.details?.moved || [];
          return (
            <div key={h.id} className="hist-item">
              <div className="hist-row" onClick={() => setOpen(open === h.id ? null : h.id)}>
                <span className="muted">{fmtDateTime(h.at)}</span>
                <span>{h.user_name}</span>
                <span><span className={`act act-${h.action}`}>{ACTION_LABEL[h.action] || h.action}</span></span>
                <span>
                  {h.summary}
                  {h.task_id && model.task(h.task_id) && <button className="link" onClick={(e) => { e.stopPropagation(); focusTask(h.task_id!); }}> · למשימה</button>}
                </span>
              </div>
              {open === h.id && moved.length > 0 && (
                <ul className="hist-moved">
                  {moved.map((m) => (
                    <li key={m.id}><b>{m.name}</b>: {fmtDate(m.from.start)}–{fmtDate(m.from.finish)} ← {fmtDate(m.to.start)}–{fmtDate(m.to.finish)}
                      <span className={m.shift > 0 ? 'bad' : 'good'}> ({m.shift > 0 ? '+' : '−'}{daysText(m.shift)})</span></li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {shown.length === 0 && <p className="muted" style={{ padding: 20 }}>{any ? 'אין שינויים שמתאימים לסינון.' : 'אין שינויים רשומים.'}</p>}
        {rows.length > 0 && rows.length < meta.count && (
          <div className="hist-more">
            <span className="muted small">מוצגים {rows.length} מתוך {meta.count}</span>
            <button className="btn small" onClick={more} disabled={loading}>{loading ? 'טוען…' : 'הצגת שינויים קודמים'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
