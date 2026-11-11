import { useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import type { Project } from '../types';
import { fmtDate } from '../dates';

export const PROJECT_COLORS = ['#3b6fd8', '#0f9d76', '#c2410c', '#7c3aed', '#be185d', '#0e7490', '#a16207', '#475569'];

export function ProjectDialog({ project, onClose }: { project: Project | null; onClose: (createdId?: number) => void }) {
  const { run, isAdmin, model } = useApp();
  const [name, setName] = useState(project?.name || '');
  const [start, setStart] = useState(project?.start_date || model.data.today);
  const [color, setColor] = useState(project?.color || PROJECT_COLORS[model.projectList.length % PROJECT_COLORS.length]);
  const [desc, setDesc] = useState(project?.description || '');
  const submit = async () => {
    if (!name.trim()) return;
    if (project) {
      await run(() => api.patch(`/projects/${project.id}`, { name, start_date: start, color, description: desc }), 'הפרויקט עודכן');
      onClose();
    } else {
      const r = await run(() => api.post<Project>('/projects', { name, start_date: start, color, description: desc }), 'הפרויקט נוצר');
      onClose(r?.id);
    }
  };
  return (
    <div className="modal-bg" onMouseDown={() => onClose()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{project ? 'עריכת פרויקט' : 'פרויקט חדש'}</h2>
        <label className="field"><span className="f-label">שם הפרויקט</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /></label>
        <label className="field"><span className="f-label">תאריך התחלה</span>
          <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          <span className="f-hint">משימות בלי תלויות יתחילו בתאריך הזה.</span></label>
        <div className="field"><span className="f-label">צבע</span>
          <div className="swatches">
            {PROJECT_COLORS.map((c) => <button key={c} className={`sw ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
          </div></div>
        <label className="field"><span className="f-label">תיאור</span>
          <textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>

        {project && (
          <div className="sec">
            <h3>תכנון מול ביצוע</h3>
            <p className="muted small">הכפתור שומר את התאריכים של היום כ"תכנון המקורי". אחר כך, כשהתיבה "תכנון מול ביצוע" מסומנת, רואים בגאנט פס אפור דק מתחת לכל משימה: איפה היא תוכננה במקור, לעומת איפה היא עכשיו.
              {project.baseline_finish && <> התכנון המקורי השמור מסתיים ב-{fmtDate(project.baseline_finish)}.</>}</p>
            <button className="btn" onClick={() => {
              if (!project.baseline_finish || confirm('להחליף את התכנון המקורי השמור בתאריכים הנוכחיים?')) run(() => api.post(`/projects/${project.id}/baseline`), 'התכנון המקורי נשמר');
            }}>שמירת התאריכים הנוכחיים כתכנון המקורי</button>
          </div>
        )}

        <div className="modal-actions">
          {project && isAdmin && (
            <button className="btn danger-outline" onClick={() => {
              if (confirm(`למחוק את הפרויקט "${project.name}" ואת כל המשימות שבו? (אפשר לבטל מיד אחר כך עם כפתור הביטול)`)) run(() => api.del(`/projects/${project.id}`), 'הפרויקט נמחק').then(() => onClose());
            }}>מחיקת פרויקט</button>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={() => onClose()}>ביטול</button>
          <button className="btn primary" disabled={!name.trim()} onClick={submit}>{project ? 'שמירה' : 'יצירה'}</button>
        </div>
      </div>
    </div>
  );
}
