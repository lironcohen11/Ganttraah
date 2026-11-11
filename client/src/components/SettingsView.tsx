import { useEffect, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import type { User, Role, Unit } from '../types';
import { fmtDate, fmtWeekday, HEB_DAYS } from '../dates';

interface CalSettings { workDays: number[]; chagOff: boolean; independenceOff: boolean; cholHamoedOff: boolean; erevChagOff: boolean }
interface CalResp { settings: CalSettings; exceptions: { day: string; kind: 'off' | 'work'; label: string }[]; holidays: { day: string; label: string; cat: string; off: boolean }[]; year: number }

const CAT_LABEL: Record<string, string> = { chag: 'חג', chol: 'חול המועד', erev: 'ערב חג', independence: 'יום העצמאות' };

export function SettingsView() {
  const { isAdmin } = useApp();
  const [tab, setTab] = useState<'calendar' | 'users'>('calendar');
  return (
    <div className="page settings-page">
      <div className="page-head">
        <h1>הגדרות</h1>
        <div className="seg">
          <button className={tab === 'calendar' ? 'on' : ''} onClick={() => setTab('calendar')}>לוח עבודה וחגים</button>
          {isAdmin && <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>מבנה ארגוני</button>}
        </div>
      </div>
      {tab === 'calendar' ? <CalendarSettings /> : <OrgSettings />}
    </div>
  );
}

function CalendarSettings() {
  const { run, isAdmin, model } = useApp();
  const [year, setYear] = useState(Number(model.data.today.slice(0, 4)));
  const [cal, setCal] = useState<CalResp | null>(null);
  const [exDay, setExDay] = useState('');
  const [exKind, setExKind] = useState<'off' | 'work'>('off');
  const [exLabel, setExLabel] = useState('');
  const load = () => api.get<CalResp>(`/calendar?year=${year}`).then(setCal);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [year, model]);
  if (!cal) return null;
  const s = cal.settings;
  const save = (patch: Partial<CalSettings>) => run(() => api.put('/calendar', { ...s, ...patch }), 'לוח העבודה עודכן. כל התאריכים חושבו מחדש.');
  const ro = !isAdmin;
  return (
    <div className="settings-grid">
      <section className="card">
        <h2>ימי עבודה</h2>
        <p className="muted small">משך המשימות נספר בימי עבודה בלבד. שינוי כאן מחשב מחדש את כל התאריכים בכל הפרויקטים.</p>
        <div className="days">
          {HEB_DAYS.map((d, i) => (
            <label key={i} className={`day ${s.workDays.includes(i) ? 'on' : ''}`}>
              <input type="checkbox" disabled={ro} checked={s.workDays.includes(i)}
                onChange={(e) => save({ workDays: e.target.checked ? [...s.workDays, i].sort() : s.workDays.filter((x) => x !== i) })} />
              {d}
            </label>
          ))}
        </div>
        <h3>חגים ומועדים</h3>
        <label className="toggle row"><input type="checkbox" disabled={ro} checked={s.chagOff} onChange={(e) => save({ chagOff: e.target.checked })} /> חגים (ראש השנה, יום כיפור, סוכות, שמחת תורה, פסח, שבועות) הם ימי חופש</label>
        <label className="toggle row"><input type="checkbox" disabled={ro} checked={s.independenceOff} onChange={(e) => save({ independenceOff: e.target.checked })} /> יום העצמאות הוא יום חופש</label>
        <label className="toggle row"><input type="checkbox" disabled={ro} checked={s.cholHamoedOff} onChange={(e) => save({ cholHamoedOff: e.target.checked })} /> חול המועד הוא יום חופש</label>
        <label className="toggle row"><input type="checkbox" disabled={ro} checked={s.erevChagOff} onChange={(e) => save({ erevChagOff: e.target.checked })} /> ערבי חג הם ימי חופש</label>

        <h3>ימים מיוחדים</h3>
        <p className="muted small">יום חופש ארגוני, או יום עבודה בתאריך שבדרך כלל אינו יום עבודה.</p>
        {isAdmin && (
          <div className="ex-form">
            <input type="date" value={exDay} onChange={(e) => setExDay(e.target.value)} />
            <select value={exKind} onChange={(e) => setExKind(e.target.value as 'off' | 'work')}><option value="off">יום חופש</option><option value="work">יום עבודה</option></select>
            <input placeholder="תיאור (לא חובה)" value={exLabel} onChange={(e) => setExLabel(e.target.value)} />
            <button className="btn primary small" disabled={!exDay} onClick={() => run(() => api.post('/calendar/exceptions', { day: exDay, kind: exKind, label: exLabel }), 'נשמר').then(() => { setExDay(''); setExLabel(''); })}>הוספה</button>
          </div>
        )}
        <ul className="ex-list">
          {cal.exceptions.map((e) => (
            <li key={e.day}><b>{fmtDate(e.day)}</b> {fmtWeekday(e.day)} · {e.kind === 'off' ? 'יום חופש' : 'יום עבודה'} {e.label && `· ${e.label}`}
              {isAdmin && <button className="link danger" onClick={() => run(() => api.del(`/calendar/exceptions/${e.day}`))}>הסרה</button>}</li>
          ))}
          {cal.exceptions.length === 0 && <li className="muted">אין ימים מיוחדים.</li>}
        </ul>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>חגים בשנת {year}</h2>
          <div className="seg small">
            <button onClick={() => setYear(year - 1)}>{year - 1}</button>
            <button className="on">{year}</button>
            <button onClick={() => setYear(year + 1)}>{year + 1}</button>
          </div>
        </div>
        <p className="muted small">החגים מחושבים אוטומטית לפי הלוח העברי, בלי חיבור לאינטרנט.</p>
        <table className="hol-table">
          <thead><tr><th>תאריך</th><th>יום</th><th>מועד</th><th>סוג</th><th>במערכת</th></tr></thead>
          <tbody>
            {cal.holidays.map((h) => (
              <tr key={h.day} className={h.off ? 'off' : ''}>
                <td>{fmtDate(h.day)}</td><td>{fmtWeekday(h.day)}</td><td>{h.label}</td><td className="muted">{CAT_LABEL[h.cat] || ''}</td>
                <td>{h.off ? <span className="chip bad">חופש</span> : <span className="chip">עבודה</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** Organisation structure: rename units (management only). */
function OrgSettings() {
  const { model, run } = useApp();
  const save = (u: Unit, patch: Partial<Unit>) => run(() => api.patch(`/units/${u.id}`, patch), 'נשמר');
  return (
    <div className="settings-grid">
      <section className="card wide">
        <h2>מבנה ארגוני</h2>
        <p className="muted small">בעמוד הכניסה כל אחד בוחר את היחידה שלו. יחידה יכולה לערוך משימות שבאחריותה ובאחריות היחידות שמתחתיה. הנהלת הענף עורכת הכול. השמות כאן הם שמות לדוגמה, ואפשר לשנות אותם.</p>
        <table className="users-table org-table">
          <thead><tr><th>מסגרת</th><th>משימות באחריות</th></tr></thead>
          <tbody>
            {model.unitTree().map(({ unit, depth }) => (
              <tr key={unit.id} className={`k-${unit.kind}`}>
                <td style={{ paddingInlineStart: 8 + depth * 22 }}>
                  <UnitInput value={unit.name} onSave={(v) => v && v !== unit.name && save(unit, { name: v })} />
                </td>
                <td className="muted">{model.data.tasks.filter((t) => t.owner_unit_id === unit.id).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function UnitInput({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onSave(v.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}
