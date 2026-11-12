import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import { STATUS_LABEL, DEP_LABEL, depText } from '../model';
import type { AuditEntry, DepType } from '../types';
import { fmtDate, fmtDateTime, toDay, daysText } from '../dates';
import { Icon } from './Icon';
import { TaskPicker } from './TaskPicker';

const DEADLINE_INFO = 'מועד חיצוני שהמשימה חייבת לעמוד בו, למשל התחייבות ללקוח. בניגוד לתאריך הסיום, שמחושב לבד וזז עם התלויות, תאריך היעד קבוע ולא זז. אם הסיום עובר אותו, המשימה מסומנת באדום.';

function Field({ label, children, hint, info }: { label: string; children: React.ReactNode; hint?: React.ReactNode; info?: string }) {
  return (
    <label className="field">
      <span className="f-label">{label}{info && <span className="f-info" title={info}><Icon name="info" size={13} /></span>}</span>
      {children}
      {hint && <span className="f-hint">{hint}</span>}
    </label>
  );
}

/** Input that commits on blur / Enter. */
function Commit({ value, onCommit, type = 'text', disabled, min, max, className, placeholder }: {
  value: string | number; onCommit: (v: string) => void; type?: string; disabled?: boolean; min?: number; max?: number; className?: string; placeholder?: string;
}) {
  const [v, setV] = useState(String(value ?? ''));
  useEffect(() => setV(String(value ?? '')), [value]);
  const commit = () => { if (v !== String(value ?? '')) onCommit(v); };
  return (
    <input className={className} type={type} value={v} disabled={disabled} min={min} max={max} placeholder={placeholder}
      onChange={(e) => { setV(e.target.value); if (type === 'date') { if (e.target.value !== String(value ?? '')) onCommit(e.target.value); } }}
      onBlur={type === 'date' ? undefined : commit}
      onKeyDown={(e) => { if (e.key === 'Enter' && type !== 'textarea') (e.target as HTMLInputElement).blur(); }} />
  );
}

export function TaskPanel({ taskId, onClose }: { taskId: number; onClose: () => void }) {
  const { model, user, canEdit, canEditTask, assignable, isAdmin, run, focusTask, openTask, toggleFavorite } = useApp();
  const t = model.task(taskId);
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [notes, setNotes] = useState(t?.notes || '');
  const [histOpen, setHistOpen] = useState(false);
  useEffect(() => setNotes(t?.notes || ''), [t?.notes, taskId]);
  useEffect(() => {
    let live = true;
    api.get<AuditEntry[]>(`/history?task_id=${taskId}&limit=8`).then((h) => live && setHistory(h)).catch(() => {});
    return () => { live = false; };
  }, [taskId, model]);

  const rel = useMemo(() => (t ? model.relations(t.id) : { drivers: [], driven: [] }), [model, t]);
  const excludeLinks = useMemo(() => {
    if (!t) return new Set<number>();
    const s = new Set<number>([...model.subtree(t.id), ...model.ancestors(t.id)]);
    for (const r of [...rel.drivers, ...rel.driven]) if (!r.via) s.add(r.other);
    return s;
  }, [model, t, rel]);
  // a new "affected" task must be one the user may edit (the link changes its dates)
  const excludeDriven = useMemo(() => {
    const s = new Set(excludeLinks);
    for (const x of model.data.tasks) if (!canEditTask(x.id)) s.add(x.id);
    return s;
  }, [excludeLinks, model, canEditTask]);

  if (!t) return null;
  const pr = model.project(t.project_id)!;
  const isSummary = t.kind === 'summary';
  const ed = canEditTask(t.id);
  const own = model.effOwner(t.id);
  const ownUnit = own.unit != null ? model.units.get(own.unit) : undefined;
  const save = (patch: Record<string, unknown>) => run(() => api.patch(`/tasks/${t.id}`, patch));
  const drivingNames = rel.drivers.filter((r) => t.driving_dep_ids.includes(r.dep.id)).map((r) => model.task(r.other)?.name).filter(Boolean);
  const anc = model.ancestors(t.id).reverse();

  // status in plain words, and where it comes from
  const isMs = t.kind === 'milestone';
  const statusLabel = isMs
    ? ({ done: 'הושגה', late: 'התאריך עבר', planned: 'מתוכננת', active: 'מתוכננת', behind: 'מתוכננת' } as const)[t.status]
    : STATUS_LABEL[t.status];
  const statusExplain = t.status === 'late'
    ? isMs
      ? `התאריך של אבן הדרך (${fmtDate(t.finish)}) כבר עבר, והיא עוד לא סומנה כהושגה. אם היא הושגה, לחצו "סמן כהושגה".`
      : `תאריך הסיום המתוכנן (${fmtDate(t.finish)}) כבר עבר, והמשימה מסומנת רק כ-${t.percent}% הושלמה.`
    : t.status === 'behind'
      ? `לפי התאריכים המתוכננים (${fmtDate(t.start)} – ${fmtDate(t.finish)}) עבר כבר חלק מהזמן, ולכן עד היום היה צפוי שיושלמו כ-${t.expected_percent}%. בפועל מסומן ${t.percent}%.`
      : t.status === 'done' ? 'מסומנת כהושלמה (100%).'
      : t.status === 'planned' ? `עוד לא הגיע מועד ההתחלה (${fmtDate(t.start)}).`
      : `בביצוע לפי לוח הזמנים (צפוי עד היום כ-${t.expected_percent}%, מסומן ${t.percent}%).`;

  const depRow = (r: { dep: { id: number; type: DepType; lag: number }; other: number; via: number | null }, side: 'up' | 'down') => {
    const o = model.task(r.other);
    if (!o) return null;
    const direct = !r.via;
    const driving = side === 'up' && t.driving_dep_ids.includes(r.dep.id);
    return (
      <div key={r.dep.id + '-' + r.other} className={`dep-row ${side}`}>
        <button className="dep-task" onClick={() => openTask(o.id)} title="פתח את המשימה">
          <span className="proj-chip" style={{ background: model.project(o.project_id)?.color }} />
          <span className="dep-name">{o.name}</span>
          <span className="dep-path">{model.path(o.id)}</span>
        </button>
        <div className="dep-meta">
          {direct && (side === 'up' ? ed : canEditTask(r.other)) ? (
            <>
              <select value={r.dep.type} onChange={(e) => run(() => api.patch(`/dependencies/${r.dep.id}`, { type: e.target.value }))}>
                {Object.entries(DEP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <Commit className="lag" type="number" value={r.dep.lag} onCommit={(v) => run(() => api.patch(`/dependencies/${r.dep.id}`, { lag: Number(v) || 0 }))} />
              <span className="unit">ימים</span>
              <button className="icon-btn danger" title="הסר תלות" onClick={() => run(() => api.del(`/dependencies/${r.dep.id}`), 'התלות הוסרה')}><Icon name="x" size={14} /></button>
            </>
          ) : (
            <span className="dep-type">{depText(r.dep.type, r.dep.lag)}</span>
          )}
          {driving && <span className="chip drive" title="התלות הזו היא שקובעת את מועד ההתחלה">קובעת את התאריך</span>}
          {r.via && <span className="chip via">דרך "{model.task(r.via)?.name}"</span>}
        </div>
      </div>
    );
  };

  return (
    <aside className="panel" onClick={(e) => e.stopPropagation()}>
      <div className="panel-head">
        <div className="crumbs">
          <span className="proj-chip" style={{ background: pr.color }} />
          <span>{pr.name}</span>
          {anc.map((a) => <span key={a} className="crumb-sep">›<button onClick={() => openTask(a)}>{model.task(a)!.name}</button></span>)}
        </div>
        {user.unit_id != null && (
          <button className={`icon-btn star ${model.favorites.has(t.id) ? 'on' : ''}`} onClick={() => toggleFavorite(t.id)}
            title={model.favorites.has(t.id) ? 'הסרה מהמועדפים' : `הוספה למועדפים של ${user.display_name}`}>
            <Icon name="star" size={17} fill={model.favorites.has(t.id) ? 'currentColor' : undefined} />
          </button>
        )}
        <button className="icon-btn" onClick={onClose} aria-label="סגור"><Icon name="x" /></button>
      </div>

      <div className="panel-body">
        <div className="title-row">
          <span className="wbs-tag" title={`מספר המשימה בתכנית: ${t.wbs}. המספר משקף את המיקום בהיררכיה (למשל 2.3 = המשימה השלישית בתוך משימה 2), כמו בעמודה # בטבלה.`}>{t.wbs}</span>
          {ed ? <Commit className="title-input" value={t.name} onCommit={(v) => v.trim() && save({ name: v.trim() })} />
            : <h2 className="title-ro">{t.name}</h2>}
        </div>
        {!ed && canEdit && (
          <p className="ro-banner"><Icon name="eye" size={14} /> צפייה בלבד: המשימה באחריות <b>{ownUnit?.name || 'הנהלת הענף'}</b>. אפשר לערוך רק משימות של היחידה שלך ושל היחידות שמתחתיה.</p>
        )}
        <div className="chips">
          {t.kind === 'milestone' && <span className="chip"><Icon name="diamond" size={11} /> אבן דרך</span>}
          {isSummary && <span className="chip">אב-משימה · {t.children.length} תתי-משימות</span>}
          <span className={`chip st-${t.status}`} title={statusExplain}>{statusLabel}</span>
          {t.critical && <span className="chip crit" title="כל עיכוב במשימה הזו מזיז את סיום הפרויקט">בנתיב הקריטי</span>}
          {t.deadline_missed && <span className="chip bad">חורגת מתאריך היעד</span>}
          {model.crossProject(t.id) && <span className="chip"><Icon name="link" size={12} /> קשורה לפרויקט אחר</span>}
        </div>
        {statusExplain && (t.status === 'late' || t.status === 'behind') && <p className="small bad status-why">{statusExplain}</p>}

        {!isSummary && ed && (
          <div className="seg">
            <button className={t.kind === 'task' ? 'on' : ''} onClick={() => t.kind !== 'task' && save({ kind: 'task' })}>משימה</button>
            <button className={t.kind === 'milestone' ? 'on' : ''} onClick={() => t.kind !== 'milestone' && save({ kind: 'milestone' })}>אבן דרך</button>
          </div>
        )}

        <section className="sec">
          <h3>{t.kind === 'milestone' ? 'תאריך' : 'לוח זמנים'}</h3>
          {isSummary ? (
            <div className="ro-dates">
              <div><span>התחלה</span><b>{fmtDate(t.start)}</b></div>
              <div><span>סיום</span><b>{fmtDate(t.finish)}</b></div>
              <div><span>משך</span><b>{daysText(t.work_days)}</b></div>
              <p className="muted small">התאריכים של אב-משימה מחושבים אוטומטית מתתי-המשימות שבתוכה.</p>
            </div>
          ) : (
            <div className="grid2">
              <Field label={t.kind === 'milestone' ? 'תאריך' : 'התחלה'}
                hint={t.constrained
                  ? <>התאריך נקבע ידנית: המשימה לא תתחיל לפניו, גם אם מה שלפניה יסתיים מוקדם. אם משהו לפניה יתעכב, היא עדיין תידחה.{' '}
                      {ed && <button className="link" onClick={() => save({ start_constraint: null })}>לחשב לפי התלויות</button>}</>
                  : drivingNames.length ? <>מחושב אוטומטית: מגיע אחרי {drivingNames.map((n) => `"${n}"`).join(', ')}</>
                  : <>מחושב אוטומטית: תחילת הפרויקט</>}>
                <Commit type="date" value={t.start} disabled={!ed} onCommit={(v) => v && save({ start_constraint: v })} />
              </Field>
              {t.kind !== 'milestone' && <>
                <Field label="משך (ימי עבודה)">
                  <Commit type="number" min={1} value={t.duration} disabled={!ed} onCommit={(v) => save({ duration: Math.max(1, Number(v) || 1) })} />
                </Field>
                <Field label="סיום">
                  <Commit type="date" value={t.finish} disabled={!ed} onCommit={(v) => {
                    if (!v) return;
                    const f = Math.max(toDay(t.start), toDay(v));
                    save({ duration: Math.max(1, model.cal.between(toDay(t.start), f)) });
                  }} />
                </Field>
              </>}
              {t.kind !== 'milestone' && (
                <Field label="תאריך יעד" info={DEADLINE_INFO} hint={t.deadline_missed ? <span className="bad">הסיום המתוכנן ({fmtDate(t.finish)}) מאוחר מתאריך היעד</span> : null}>
                  <div className="with-clear">
                    <Commit type="date" value={t.deadline || ''} disabled={!ed} onCommit={(v) => save({ deadline: v || null })} />
                    {t.deadline && ed && <button className="icon-btn" title="הסר" onClick={() => save({ deadline: null })}><Icon name="x" size={13} /></button>}
                  </div>
                </Field>
              )}
            </div>
          )}
          {isSummary && (
            <Field label="תאריך יעד" info={DEADLINE_INFO} hint={t.deadline_missed ? <span className="bad">הסיום המתוכנן מאוחר מתאריך היעד</span> : null}>
              <div className="with-clear">
                <Commit type="date" value={t.deadline || ''} disabled={!ed} onCommit={(v) => save({ deadline: v || null })} />
                {t.deadline && ed && <button className="icon-btn" title="הסר" onClick={() => save({ deadline: null })}><Icon name="x" size={13} /></button>}
              </div>
            </Field>
          )}
          {t.baseline_finish && (
            <p className="muted small">תכנון מקורי: {fmtDate(t.baseline_start)} – {fmtDate(t.baseline_finish)}
              {t.baseline_finish !== t.finish && <b className={toDay(t.finish) > toDay(t.baseline_finish) ? 'bad' : 'good'}> · {toDay(t.finish) > toDay(t.baseline_finish) ? 'מתעכב' : 'מקדים'} ב-{daysText(Math.abs(toDay(t.finish) - toDay(t.baseline_finish)))}</b>}
            </p>
          )}
        </section>

        <section className="sec">
          <h3>התקדמות</h3>
          <p className="muted small prog-help">
            {isSummary ? 'מחושבת אוטומטית מתתי-המשימות (משימה ארוכה משפיעה יותר).'
              : t.kind === 'milestone' ? 'אבן דרך מסומנת כהושגה או לא הושגה.'
              : 'כמה מהעבודה בוצע בפועל, לפי הדיווח של האחראי. זה לא משנה את התאריכים. המערכת משווה את הדיווח למה שצפוי לפי התאריכים, ומסמנת "בפיגור" אם יש פער.'}
          </p>
          {isSummary || t.kind === 'milestone' ? (
            <div className="prog-ro">
              <div className="pct-bar big"><i style={{ width: `${t.percent}%`, background: pr.color }} /></div>
              <b>{t.percent}%</b>
              {t.kind === 'milestone' && ed && (
                <button className="btn small" onClick={() => save({ percent: t.percent >= 100 ? 0 : 100 })}>{t.percent >= 100 ? 'סמן כלא הושגה' : 'סמן כהושגה'}</button>
              )}
            </div>
          ) : (
            <div className="prog">
              <div className="pct-steps" role="group" aria-label="התקדמות">
                {[0, 25, 50, 75, 100].map((v) => (
                  <button key={v} className={t.own_percent === v ? 'on' : ''} disabled={!ed} onClick={() => t.own_percent !== v && save({ percent: v })}>{v}%</button>
                ))}
              </div>
              <Commit type="number" min={0} max={100} className="pct-input" value={t.own_percent} disabled={!ed} onCommit={(v) => save({ percent: Number(v) || 0 })} />
              <span>%</span>
            </div>
          )}
        </section>

        <section className="sec">
          <Field label="אחראי" hint={t.owner_unit_id == null && ownUnit ? `לא נקבע ישירות, ולכן עובר מאב-המשימה: ${ownUnit.name}` : null}>
            {ed ? (
              <select value={t.owner_unit_id ?? ''} onChange={(e) => save({ owner_unit_id: e.target.value === '' ? null : Number(e.target.value) })}>
                {(isAdmin || t.owner_unit_id == null) && <option value="">{t.parent_id && ownUnit ? `כמו אב-המשימה (${ownUnit.name})` : 'ללא אחראי'}</option>}
                {t.owner_unit_id != null && !assignable.some((u) => u.id === t.owner_unit_id) && <option value={t.owner_unit_id}>{model.units.get(t.owner_unit_id)?.name}</option>}
                {assignable.map((u) => {
                  const depth = model.unitTree().find((x) => x.unit.id === u.id)?.depth ?? 0;
                  return <option key={u.id} value={u.id}>{'   '.repeat(depth)}{u.name}</option>;
                })}
              </select>
            ) : (
              <div className="ro-value">{ownUnit ? ownUnit.name : '—'}</div>
            )}
          </Field>
          <Field label="הערות">
            <textarea value={notes} disabled={!ed} rows={3} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== t.notes && save({ notes })} />
          </Field>
        </section>

        {isSummary && (
          <section className="sec">
            <h3>תתי-משימות</h3>
            <div className="kids">
              {t.children.map((c) => {
                const k = model.task(c)!;
                return (
                  <button key={c} className="kid" onClick={() => openTask(c)}>
                    <span className={`st ${k.status}`} />
                    <span className="kid-name">{k.kind === 'milestone' && <Icon name="diamond" size={11} />} {k.name}</span>
                    {k.children.length > 0 && <span className="muted small">{k.children.length} תתי-משימות</span>}
                    <span className="kid-pct">{k.percent}%</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <section className="sec">
          <h3><span className="dot up" /> משפיעות על המשימה <span className="count">{rel.drivers.length}</span></h3>
          {rel.drivers.length === 0 && <p className="muted small">אין משימות שהמשימה הזו מחכה להן.</p>}
          {rel.drivers.map((r) => depRow(r, 'up'))}
          {ed && <TaskPicker model={model} exclude={excludeLinks} placeholder="+ הוספת משימה שהמשימה הזו תלויה בה…"
            onPick={(id) => run(() => api.post('/dependencies', { predecessor_id: id, successor_id: t.id, type: 'FS' }), 'התלות נוספה')} />}
        </section>

        <section className="sec">
          <h3><span className="dot down" /> מושפעות מהמשימה <span className="count">{rel.driven.length}</span></h3>
          {rel.driven.length === 0 && <p className="muted small">אין משימות שמחכות למשימה הזו.</p>}
          {rel.driven.map((r) => depRow(r, 'down'))}
          {canEdit && <TaskPicker model={model} exclude={excludeDriven} placeholder="+ הוספת משימה שתלויה במשימה הזו…"
            onPick={(id) => run(() => api.post('/dependencies', { predecessor_id: t.id, successor_id: id, type: 'FS' }), 'התלות נוספה')} />}
        </section>

        <div className="actions-row">
          <button className="btn primary" onClick={() => focusTask(t.id)}><Icon name="deps" size={15} /> פתיחה במפת התלויות ומה-אם</button>
          <p className="muted small">כל השרשרת של המשימה במסך אחד, והדמיה של מה יקרה אם היא תתעכב.</p>
        </div>

        <section className="sec">
          <button className={`sec-toggle ${histOpen ? 'open' : ''}`} onClick={() => setHistOpen(!histOpen)} aria-expanded={histOpen}>
            <Icon name="chevronDown" size={15} />
            <span>היסטוריית שינויים</span>
            <span className="count">{history.length}{history.length >= 8 ? '+' : ''}</span>
          </button>
          {histOpen && (
            <>
              {history.length === 0 && <p className="muted small">אין שינויים רשומים.</p>}
              <ul className="hist-mini">
                {history.map((h) => (
                  <li key={h.id}><span className="muted">{fmtDateTime(h.at)} · {h.user_name}</span><div>{h.summary}</div></li>
                ))}
              </ul>
            </>
          )}
        </section>

        {ed && (
          <div className="danger-zone">
            <button className="btn danger-outline" onClick={() => {
              const n = model.subtree(t.id).size - 1;
              if (confirm(`למחוק את "${t.name}"${n ? ` ואת ${n} תתי-המשימות שלה` : ''}? הפעולה תירשם בהיסטוריה.`)) {
                run(() => api.del(`/tasks/${t.id}`), 'המשימה נמחקה').then(onClose);
              }
            }}><Icon name="trash" size={14} /> מחיקת המשימה</button>
          </div>
        )}
      </div>
    </aside>
  );
}
