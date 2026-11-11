import { useEffect, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import type { AuditEntry } from '../types';
import { fmtDateTime, fmtDate, daysText } from '../dates';

const ACTION_LABEL: Record<string, string> = { create: 'יצירה', update: 'עדכון', delete: 'מחיקה', move: 'העברה', baseline: 'תכנון מקורי', undo: 'ביטול', redo: 'ביצוע שוב' };

export function HistoryView() {
  const { model, focusTask, toast } = useApp();
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [project, setProject] = useState<string>('');
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    api.get<AuditEntry[]>(`/history?limit=500${project ? `&project_id=${project}` : ''}`).then(setRows).catch((e) => toast(e.message, 'error'));
  }, [project, model]);
  return (
    <div className="page history-page">
      <div className="page-head">
        <h1>היסטוריית שינויים</h1>
        <p className="muted">כל שינוי בתוכנית נרשם כאן: מי שינה, מה שינה, מתי, ואילו משימות זזו בעקבות השינוי.</p>
        <select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">כל הפרויקטים</option>
          {model.projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="hist-table">
        <div className="hist-row head"><span>מתי</span><span>מי</span><span>פעולה</span><span>מה השתנה</span></div>
        {rows.map((h) => {
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
        {rows.length === 0 && <p className="muted" style={{ padding: 20 }}>אין שינויים רשומים.</p>}
      </div>
    </div>
  );
}
