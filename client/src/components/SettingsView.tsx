import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import type { Unit } from '../types';
import { fmtDate, fmtWeekday, toDay } from '../dates';
import { Icon } from './Icon';

interface CalSettings { workDays: number[]; chagOff: boolean; independenceOff: boolean; cholHamoedOff: boolean; erevChagOff: boolean }
interface SpecialDay { id: number; unit_id: number | null; start_day: string; end_day: string; kind: 'off' | 'work'; label: string }
interface CalResp { settings: CalSettings; specialDays: SpecialDay[]; holidays: { day: string; label: string; cat: string; off: boolean }[]; year: number }

const CAT_LABEL: Record<string, string> = { chag: 'חג', chol: 'חול המועד', erev: 'ערב חג', independence: 'יום העצמאות', info: 'מועד' };

export function SettingsView() {
  const { isAdmin } = useApp();
  const [tab, setTab] = useState<'calendar' | 'org'>('calendar');
  return (
    <div className="page settings-page">
      <div className="page-head">
        <h1>הגדרות</h1>
        <div className="seg">
          <button className={tab === 'calendar' ? 'on' : ''} onClick={() => setTab('calendar')}>לוח עבודה וחגים</button>
          {isAdmin && <button className={tab === 'org' ? 'on' : ''} onClick={() => setTab('org')} data-tour="s-org">מבנה ארגוני והרשאות</button>}
        </div>
      </div>
      {tab === 'calendar' || !isAdmin ? <CalendarSettings /> : <OrgSettings />}
    </div>
  );
}

const rangeText = (a: string, b: string) => (a === b ? `${fmtDate(a)} (${fmtWeekday(a)})` : `${fmtDate(a)} – ${fmtDate(b)}`);

function CalendarSettings() {
  const { run, isAdmin, model, user, assignable } = useApp();
  const thisYear = Number(model.data.today.slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [cal, setCal] = useState<CalResp | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<'off' | 'work'>('off');
  const [label, setLabel] = useState('');
  const [unit, setUnit] = useState<string>('');
  useEffect(() => { api.get<CalResp>(`/calendar?year=${year}`).then(setCal); }, [year, model]);
  if (!cal) return null;
  const s = cal.settings;
  const save = (patch: Partial<CalSettings>) => run(() => api.put('/calendar', { ...s, ...patch }), 'ההגדרה עודכנה. כל התאריכים חושבו מחדש.');
  const ro = !isAdmin;
  const unitName = (id: number | null) => (id == null ? 'כל הענף' : model.units.get(id)?.name || '');
  const mayRemove = (d: SpecialDay) => isAdmin || (d.unit_id != null && user.unit_id != null && model.unitWithin(d.unit_id, user.unit_id));
  const add = () => {
    const end = to && to >= from ? to : from;
    const body = { start_day: from, end_day: end, kind: isAdmin ? kind : 'off', label, unit_id: unit === '' ? (isAdmin ? null : user.unit_id) : Number(unit) };
    run(() => api.post('/calendar/special', body), 'נשמר. התאריכים חושבו מחדש.').then(() => { setFrom(''); setTo(''); setLabel(''); });
  };
  const days = [...cal.specialDays].sort((a, b) => a.start_day.localeCompare(b.start_day));

  // holidays: one row per run of consecutive days with the same name (Chol HaMoed, Rosh Hashana...)
  const groups: { start: string; end: string; label: string; cat: string; off: boolean }[] = [];
  for (const h of cal.holidays) {
    const g = groups[groups.length - 1];
    if (g && g.label === h.label && toDay(h.day) === toDay(g.end) + 1) g.end = h.day;
    else groups.push({ start: h.day, end: h.day, label: h.label, cat: h.cat, off: h.off });
  }
  const today = model.data.today;
  const todayAt = year === thisYear ? groups.findIndex((g) => g.end >= today) : -1;

  return (
    <div className="settings-grid">
      <section className="card">
        <h2>ימי עבודה</h2>
        <div className="workdays-note" data-tour="s-workdays">
          <Icon name="calendar" size={22} />
          <p>משך המשימות נספר בימי עבודה בלבד (א'-ה'). שינוי בחגים או בימים מיוחדים מחשב מחדש את התאריכים בכל הפרויקטים.</p>
        </div>

        <div data-tour="s-holidays">
        <h3>חגים ומועדים</h3>
        {ro && <p className="muted small">רק הנהלת הענף משנה את ההגדרות האלה.</p>}
        <label className="toggle row"><input type="checkbox" disabled={ro} checked={s.chagOff} onChange={(e) => save({ chagOff: e.target.checked })} /> חגים (ראש השנה, יום כיפור, סוכות, שמחת תורה, פסח, שבועות) הם ימי חופש</label>
        <label className="toggle row"><input type="checkbox" disabled={ro} checked={s.independenceOff} onChange={(e) => save({ independenceOff: e.target.checked })} /> יום העצמאות הוא יום חופש</label>
        <label className="toggle row"><input type="checkbox" disabled={ro} checked={s.cholHamoedOff} onChange={(e) => save({ cholHamoedOff: e.target.checked })} /> חול המועד הוא יום חופש</label>
        <label className="toggle row"><input type="checkbox" disabled={ro} checked={s.erevChagOff} onChange={(e) => save({ erevChagOff: e.target.checked })} /> ערבי חג הם ימי חופש</label>
        </div>

        <div data-tour="s-special">
        <h3>ימים מיוחדים</h3>
        <p className="muted small">יום חופש ארגוני, יום עבודה בתאריך שבדרך כלל אינו יום עבודה, או חג.</p>
        <p className="special-note"><Icon name="info" size={14} /> יום מיוחד של מסגרת משפיע רק על המשימות של אותה מסגרת ושל המסגרות שמתחתיה. כל השאר ממשיכים לעבוד כרגיל, אבל רואים אותו ברשימה כאן ובגאנט, בשורות של המשימות שהוא משפיע עליהן.</p>
        {user.unit_id != null && (
          <div className="ex-form">
            <label>מתאריך<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (!to || to < e.target.value) setTo(e.target.value); }} /></label>
            <label>עד תאריך<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
            {isAdmin && (
              <label>סוג<select value={kind} onChange={(e) => { setKind(e.target.value as 'off' | 'work'); if (e.target.value === 'work') setUnit(''); }}>
                <option value="off">יום חופש</option><option value="work">יום עבודה</option>
              </select></label>
            )}
            <label>למי<select value={unit} onChange={(e) => setUnit(e.target.value)} disabled={kind === 'work' && isAdmin}>
              {isAdmin ? <option value="">כל הענף</option> : <option value="">{user.display_name}</option>}
              {assignable.filter((u) => u.parent_id != null && u.id !== user.unit_id).map((u) => {
                const depth = model.unitTree().find((x) => x.unit.id === u.id)?.depth ?? 0;
                return <option key={u.id} value={u.id}>{'   '.repeat(Math.max(0, depth - 1))}{u.name}</option>;
              })}
            </select></label>
            <label className="grow">תיאור<input placeholder="למשל: יום גיבוש" value={label} onChange={(e) => setLabel(e.target.value)} /></label>
            <button className="btn primary small" disabled={!from} onClick={add}>הוספה</button>
          </div>
        )}
        <ul className="ex-list">
          {days.map((d) => (
            <li key={d.id} className={mayRemove(d) ? '' : 'ro'}>
              <b>{rangeText(d.start_day, d.end_day)}</b>
              <span className={`chip ${d.kind === 'work' ? 'st-active' : ''}`}>{d.kind === 'off' ? 'חופש' : 'עבודה'}</span>
              <span className={`chip unit-chip ${d.unit_id == null ? 'all' : ''}`} title={d.unit_id == null ? 'חל על כל הענף' : `חל על ${unitName(d.unit_id)} ועל המסגרות שמתחתיה`}>
                {unitName(d.unit_id)}{d.unit_id != null && model.unitSubtree(d.unit_id).length > 1 ? ' ומתחתיה' : ''}
              </span>
              {d.label && <span>{d.label}</span>}
              {mayRemove(d)
                ? <button className="link danger" onClick={() => run(() => api.del(`/calendar/special/${d.id}`), 'הוסר')}>הסרה</button>
                : <span className="muted tiny">לידיעה</span>}
            </li>
          ))}
          {days.length === 0 && <li className="muted">אין ימים מיוחדים.</li>}
        </ul>
        </div>
      </section>

      <section className="card" data-tour="s-list">
        <div className="card-head">
          <h2>חגים ומועדים בשנת {year}</h2>
          <div className="seg small">
            {[thisYear, thisYear + 1].map((y) => <button key={y} className={year === y ? 'on' : ''} onClick={() => setYear(y)}>{y}</button>)}
          </div>
        </div>
        <table className="hol-table">
          <thead><tr><th>תאריך</th><th>מועד</th><th>סוג</th><th>במערכת</th></tr></thead>
          <tbody>
            {groups.map((g, i) => (
              <HolRow key={g.start} g={g} today={i === todayAt ? today : null} />
            ))}
            {year === thisYear && todayAt === -1 && <TodayRow today={today} />}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function TodayRow({ today }: { today: string }) {
  return <tr className="today-row"><td colSpan={4}><span>היום · {fmtDate(today)}</span></td></tr>;
}
function HolRow({ g, today }: { g: { start: string; end: string; label: string; cat: string; off: boolean }; today: string | null }) {
  return (
    <>
      {today && <TodayRow today={today} />}
      <tr className={g.off ? 'off' : ''}>
        <td className="nowrap">{rangeText(g.start, g.end)}</td><td>{g.label}</td><td className="muted">{CAT_LABEL[g.cat] || ''}</td>
        <td>{g.cat === 'info' ? <span className="chip" title="מועד רשמי שאינו יום חופש לכולם">לידיעה</span> : g.off ? <span className="chip bad">חופש</span> : <span className="chip">עבודה</span>}</td>
      </tr>
    </>
  );
}

/* ------------------------------------------------------------------ organisation & permissions */

function OrgSettings() {
  const { model, run, openTask } = useApp();
  const [drag, setDrag] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [list, setList] = useState<number | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const units = model.unitTree().map((x) => x.unit);
  const root = units.find((u) => u.parent_id == null);
  // open tasks per unit: tasks without sub-tasks, not finished, whose owner (direct or inherited) is the unit
  const openOf = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const t of model.data.tasks) {
      if (t.kind === 'summary' || t.percent >= 100) continue;
      const o = model.effOwner(t.id).unit;
      if (o == null) continue;
      if (!m.has(o)) m.set(o, []);
      m.get(o)!.push(t.id);
    }
    return m;
  }, [model]);
  const openUnder = (id: number) => model.unitSubtree(id).reduce((n, x) => n + (openOf.get(x)?.length || 0), 0);
  if (!root) return null;
  const kids = (id: number) => units.filter((u) => u.parent_id === id);

  const rename = (u: Unit) => {
    const name = prompt('שם חדש למסגרת:', u.name)?.trim();
    if (name && name !== u.name) run(() => api.patch(`/units/${u.id}`, { name }), 'השם עודכן');
  };
  const addUnder = (u: Unit) => {
    const name = prompt(`שם המסגרת החדשה תחת "${u.name}":`)?.trim();
    if (name) run(() => api.post('/units', { parent_id: u.id, name }), 'המסגרת נוספה');
  };
  const remove = (u: Unit) => {
    const n = model.unitSubtree(u.id).length - 1;
    if (confirm(`למחוק את "${u.name}"${n ? ` ואת ${n} המסגרות שמתחתיה` : ''}? משימות שהושלמו יעברו לאחריות "${model.units.get(u.parent_id!)?.name}".`)) {
      run(() => api.del(`/units/${u.id}`), 'המסגרת נמחקה');
    }
  };
  const setAccess = (u: Unit, editAll: boolean) => run(() => api.patch(`/units/${u.id}`, { edit_all: editAll }), 'ההרשאה עודכנה');
  const drop = (target: Unit) => {
    const id = drag;
    setDrag(null); setOver(null);
    if (id == null || id === target.id) return;
    const u = model.units.get(id)!;
    if (u.parent_id === target.id || model.unitWithin(target.id, id)) return;
    run(() => api.patch(`/units/${id}`, { parent_id: target.id }), `"${u.name}" הועברה אל "${target.name}"`);
  };

  const card = (u: Unit) => {
    const open = openOf.get(u.id)?.length || 0;
    const under = openUnder(u.id);
    const isRoot = u.parent_id == null;
    return (
      <div key={u.id} className={`ou-card ${u.kind} ${over === u.id ? 'drop' : ''} ${drag === u.id ? 'dragging' : ''}`}
        draggable={!isRoot} onDragStart={(e) => { setDrag(u.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDrag(null); setOver(null); }}
        onDragOver={(e) => { if (drag != null && drag !== u.id && !model.unitWithin(u.id, drag)) { e.preventDefault(); setOver(u.id); } }}
        onDragLeave={() => setOver((o) => (o === u.id ? null : o))} onDrop={(e) => { e.preventDefault(); drop(u); }}>
        <div className="ou-top">
          {!isRoot && <span className="ou-grip" title="גרירה למסגרת אחרת"><Icon name="grip" size={14} /></span>}
          <span className="ou-name">{u.name}</span>
          <button className="icon-btn" title="שינוי שם" onClick={() => rename(u)}><Icon name="edit" size={17} /></button>
          {!isRoot && (
            <button className="icon-btn danger" title={under ? `אי אפשר למחוק: יש ${under} משימות פתוחות באחריות המסגרת או מתחתיה` : 'מחיקת המסגרת'}
              disabled={under > 0} onClick={() => remove(u)}><Icon name="trash" size={17} /></button>
          )}
        </div>
        <div className="ou-meta">
          {open > 0
            ? <button className="link tiny" onClick={() => setList(list === u.id ? null : u.id)}>{open === 1 ? 'משימה פתוחה אחת' : `${open} משימות פתוחות`}</button>
            : <span className="tiny muted">אין משימות פתוחות</span>}
          {!isRoot ? (
            <select className="ou-access" value={u.edit_all ? 'edit' : 'view'} onChange={(e) => setAccess(u, e.target.value === 'edit')}
              title="מה המסגרת יכולה לעשות במשימות של מסגרות אחרות">
              <option value="view">צופה</option>
              <option value="edit">עורך</option>
            </select>
          ) : <span className="tiny muted">עורכת הכול</span>}
        </div>
        {list === u.id && (
          <ul className="ou-tasks">
            {(openOf.get(u.id) || []).map((id) => { const t = model.task(id)!; return <li key={id}><button className="link" onClick={() => openTask(id)}>{t.name}</button> <span className="muted tiny">{model.path(id)}</span></li>; })}
          </ul>
        )}
        <button className="ou-add" onClick={() => addUnder(u)}><Icon name="plus" size={12} /> {isRoot ? 'מדור' : 'צוות'}</button>
      </div>
    );
  };

  return (
    <div className="settings-grid">
      <section className="card wide">
        <div className="card-head">
          <h2>מבנה ארגוני והרשאות</h2>
          <button className="btn" data-tour="s-pw" onClick={() => setPwOpen(true)}><Icon name="lock" size={15} /> החלף/י סיסמה</button>
        </div>
        <div className="perm-note">
          <p><b>צופה</b> (ברירת המחדל): רואה את כל התוכנית, ועורכת רק את המשימות שלה ושל המסגרות שמתחתיה.</p>
          <p><b>עורך</b>: עורכת גם משימות של מסגרות אחרות. לא כולל הגדרות ופרויקטים, שנשארים בידי הנהלת הענף.</p>
          <p className="muted small">גוררים צוות כדי להעביר אותו למדור אחר. אי אפשר למחוק מסגרת שיש באחריותה משימות פתוחות. כל שינוי כאן מופיע מיד בתכנית העבודה.</p>
        </div>
        <div className="org-tree edit">
          <div className="org-root">{card(root)}</div>
          <div className="org-sections" style={{ gridTemplateColumns: `repeat(${Math.max(1, kids(root.id).length)}, minmax(0, 1fr))` }}>
            {kids(root.id).map((s) => (
              <div key={s.id} className="org-col">
                {card(s)}
                <div className="org-teams">{kids(s.id).map((t) => <OrgBranch key={t.id} u={t} card={card} kids={kids} />)}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
      {pwOpen && <AdminPassword onClose={() => setPwOpen(false)} />}
    </div>
  );
}

/** the password for entering as branch management, changed in a small window */
function AdminPassword({ onClose }: { onClose: () => void }) {
  const { run } = useApp();
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const mismatch = again !== '' && next !== again;
  const save = () => run(() => api.put('/admin-password', { next }), 'הסיסמה הוחלפה').then((r) => { if (r) onClose(); });
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <form className="modal pw-modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (!mismatch) save(); }}>
        <h2><Icon name="lock" size={18} /> החלף/י סיסמה</h2>
        <p className="muted small">רק הכניסה כהנהלת הענף מוגנת בסיסמה. מי שכבר מחובר נשאר מחובר, והסיסמה החדשה תידרש בכניסה הבאה.</p>
        <label className="field"><span className="f-label">סיסמה חדשה (לפחות 4 תווים)</span><input type="password" autoFocus value={next} onChange={(e) => setNext(e.target.value)} /></label>
        <label className="field"><span className="f-label">שוב את הסיסמה החדשה</span><input type="password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
        {mismatch && <p className="bad small">הסיסמאות לא זהות</p>}
        <div className="modal-actions">
          <button className="btn primary" type="submit" disabled={next.length < 4 || next !== again}>החלפת הסיסמה</button>
          <button className="btn" type="button" onClick={onClose}>ביטול</button>
        </div>
      </form>
    </div>
  );
}

/** a team, and any units below it (rare, but the tree allows it) */
function OrgBranch({ u, card, kids }: { u: Unit; card: (u: Unit) => React.ReactNode; kids: (id: number) => Unit[] }) {
  const sub = kids(u.id);
  return <>{card(u)}{sub.length > 0 && <div className="org-teams nested">{sub.map((k) => <OrgBranch key={k.id} u={k} card={card} kids={kids} />)}</div>}</>;
}

