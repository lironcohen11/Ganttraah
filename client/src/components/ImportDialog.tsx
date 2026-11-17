import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import { toDay } from '../dates';
import { fmtDate } from '../dates';
import { readXlsx, readCsv, guessFields, headerRow, toIso, toPercent, toNumber, parsePreds, FIELDS, type Sheet, type Field, type Cell } from '../import';
import { Icon } from './Icon';

// The file we receive from the other system always has the same columns (by letter):
// C = finish, J + K = description (joined), N = task name, O = start. Everything else is left out,
// and the owner is the unit doing the import.
const FX = { finish: 2, notes: [9, 10], name: 13, start: 14 };
const lsGet = (k: string, d: string) => { try { return localStorage.getItem('gantraah.' + k) || d; } catch { return d; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem('gantraah.' + k, v); } catch { /* ignore */ } };

interface Item { key: string; parent_key: string | null; name: string; kind: 'task' | 'milestone'; duration: number; start: string | null; finish: string | null;
  percent: number; owner: string; deadline: string | null; notes: string; preds: string; wbs: string; depth: number; warn: string[];
  /** the fixed file: was the start in the file itself, and are both dates there (so the duration is known) */
  fileStart?: boolean; range?: boolean }

/**
 * Import tasks from an Excel (.xlsx) or CSV file. The columns are matched to our fields by their
 * header names (a fixed list of names); the user confirms every match before anything is saved.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const { model, run, isAdmin, assignable, user } = useApp();
  const [file, setFile] = useState('');
  const [sheets, setSheets] = useState<Sheet[] | null>(null);
  const [si, setSi] = useState(0);
  const [hdr, setHdr] = useState(0);
  const [fields, setFields] = useState<Field[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<string>(() => (isAdmin ? 'new' : String(model.projectList[0]?.id ?? '')));
  const [pname, setPname] = useState('');
  const [ownerMap, setOwnerMap] = useState<Record<string, string>>({});
  // the fixed layout of the other system's file, or any file matched by its headers
  const [fmt, setFmtState] = useState<'fixed' | 'free'>(() => (lsGet('importFmt', 'fixed') === 'free' ? 'free' : 'fixed'));
  const setFmt = (f: 'fixed' | 'free') => { setFmtState(f); lsSet('importFmt', f); };
  const fixed = fmt === 'fixed';
  const myUnit = user.unit_id != null ? model.units.get(user.unit_id) : undefined;

  const load = async (f: File) => {
    setErr(''); setBusy(true);
    try {
      const sh = /\.csv$/i.test(f.name) ? readCsv(await f.text()) : await readXlsx(await f.arrayBuffer());
      const good = sh.filter((s) => s.rows.some((r) => r.some((c) => c?.text)));
      if (!good.length) throw new Error('לא נמצאו נתונים בקובץ.');
      setSheets(good); setSi(0); setFile(f.name); setPname(f.name.replace(/\.[^.]+$/, ''));
      choose(good[0]);
    } catch (e) { setErr((e as Error).message || 'לא הצלחתי לקרוא את הקובץ.'); setSheets(null); }
    finally { setBusy(false); }
  };
  const choose = (s: Sheet) => {
    const h = headerRow(s.rows);
    setHdr(h);
    setFields(guessFields((s.rows[h] || []).map((c) => c?.text || '')));
    setOwnerMap({});
  };

  const sheet = sheets?.[si];
  const headers = sheet ? (sheet.rows[hdr] || []).map((c) => c?.text || '') : [];
  const width = sheet ? Math.max(headers.length, ...sheet.rows.slice(hdr + 1, hdr + 30).map((r) => r.length)) : 0;
  const col = (f: Field) => fields.indexOf(f);

  // ---- the rows as tasks, with the current matching
  const items = useMemo<Item[]>(() => {
    if (sheet && fixed) {
      // the data starts at the first row with a date in C or O (the rows above are titles)
      const first = sheet.rows.findIndex((r) => toIso(r[FX.start]) || toIso(r[FX.finish]));
      const data = (first < 0 ? [] : sheet.rows.slice(first)).filter((r) => (r[FX.name]?.text || '').trim());
      return data.map((r, i) => {
        const warn: string[] = [];
        const sc = r[FX.start], fc = r[FX.finish];
        let start = toIso(sc);
        const finish = toIso(fc);
        if (sc?.text && !start) warn.push(`תאריך התחלה לא מובן: "${sc.text}"`);
        if (fc?.text && !finish) warn.push(`מועד סיום לא מובן: "${fc.text}"`);
        let duration = 1;
        const fileStart = !!start, range = !!(start && finish && finish >= start);
        if (start && finish) {
          if (finish < start) warn.push('הסיום לפני ההתחלה');
          else duration = Math.max(1, model.cal.between(toDay(start), toDay(finish)));
        } else if (finish) { start = finish; warn.push('אין תאריך התחלה: המשימה תהיה ביום הסיום'); }
        else if (start) warn.push('אין מועד סיום: משך של יום אחד');
        const notes = FX.notes.map((c) => (r[c]?.text || '').trim()).filter(Boolean).join('\n\n');
        return {
          key: String(i), parent_key: null, name: r[FX.name]!.text.trim(), kind: 'task' as const, duration, start, finish,
          percent: 0, owner: '', deadline: null, notes, preds: '', wbs: '', depth: 0, warn, fileStart, range,
        };
      });
    }
    if (!sheet || col('name') < 0) return [];
    const get = (r: Cell[], f: Field) => (col(f) >= 0 ? r[col(f)] : undefined);
    const data = sheet.rows.slice(hdr + 1).filter((r) => (get(r, 'name')?.text || '').trim());
    const pcol = col('percent');
    const fraction = pcol >= 0 && data.every((r) => r[pcol]?.num == null || r[pcol]!.num! <= 1);
    const useWbs = col('wbs') >= 0 && data.some((r) => /\d+\.\d+/.test(get(r, 'wbs')?.text || ''));
    const useIndent = !useWbs && data.some((r) => (get(r, 'name')?.indent || 0) > 0);
    const byWbs = new Map<string, string>();
    const stack: { depth: number; key: string }[] = [];
    return data.map((r, i) => {
      const warn: string[] = [];
      const key = String(i);
      const wbs = (get(r, 'wbs')?.text || '').replace(/\.0+$/, '');
      let parent: string | null = null, depth = 0;
      if (useWbs && wbs) {
        const up = wbs.split('.').slice(0, -1).join('.');
        parent = up ? byWbs.get(up) ?? null : null;
        depth = wbs.split('.').length - 1;
        byWbs.set(wbs, key);
      } else if (useIndent) {
        depth = get(r, 'name')!.indent;
        while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
        parent = stack.length ? stack[stack.length - 1].key : null;
        stack.push({ depth, key });
      }
      if (wbs && !useWbs) byWbs.set(wbs, key);
      const sc = get(r, 'start'), fc = get(r, 'finish'), dc = get(r, 'deadline');
      const start = toIso(sc), finish = toIso(fc);
      if (sc?.text && !start) warn.push(`תאריך התחלה לא מובן: "${sc.text}"`);
      if (fc?.text && !finish) warn.push(`תאריך סיום לא מובן: "${fc.text}"`);
      let duration = 1;
      const dn = toNumber(get(r, 'duration'));
      if (dn != null) duration = Math.round(dn);
      else if (start && finish) {
        if (finish < start) warn.push('הסיום לפני ההתחלה');
        else duration = Math.max(1, model.cal.between(toDay(start), toDay(finish)));
      }
      const kind = dn === 0 ? 'milestone' : 'task';
      return {
        key, parent_key: parent, name: get(r, 'name')!.text.trim(), kind, duration: Math.max(kind === 'milestone' ? 0 : 1, duration),
        start, finish, percent: toPercent(get(r, 'percent'), fraction), owner: (get(r, 'owner')?.text || '').trim(),
        deadline: toIso(dc), notes: get(r, 'notes')?.text || '', preds: get(r, 'preds')?.text || '', wbs, depth, warn,
      };
    });
    // eslint-disable-next-line
  }, [sheet, hdr, fields, model, fixed]);

  // ---- task or milestone, row by row: the file's guess (a duration of 0 = milestone) can be changed
  const [kinds, setKinds] = useState<Record<string, 'task' | 'milestone'>>({});
  useEffect(() => setKinds({}), [items]);
  const parents = useMemo(() => new Set(items.map((x) => x.parent_key).filter(Boolean)), [items]);
  const kindOf = (x: Item) => (parents.has(x.key) ? 'task' : kinds[x.key] ?? x.kind);
  const durOf = (x: Item) => (kindOf(x) === 'milestone' ? 0 : Math.max(1, x.duration));
  const milestones = items.filter((x) => kindOf(x) === 'milestone').length;

  // ---- owners named in the file -> our units (a first guess by name; the user can change it)
  const ownerNames = fixed ? [] : [...new Set(items.map((x) => x.owner).filter(Boolean))];
  const units = assignable.filter((u) => isAdmin || u.id !== undefined);
  const guessUnit = (name: string) => {
    const n = name.replace(/\s+/g, ' ').trim();
    return units.find((u) => u.name === n) || units.find((u) => u.name.includes(n) || n.includes(u.name));
  };
  const ownerOf = (name: string) => (name in ownerMap ? ownerMap[name] : String(guessUnit(name)?.id ?? ''));

  // ---- the fixed file again: a row whose name is already a task of the same unit in that project
  // updates that task; the same name under another unit is a new task (a different job)
  type Match = { id: number; changes: string[] } | { other: string };
  const myOwner = user.unit_id ?? null;
  const matches = useMemo(() => {
    const m = new Map<string, Match>();
    if (!fixed || target === 'new') return m;
    const pid = Number(target), norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const byName = new Map<string, typeof model.data.tasks>();
    for (const t of model.data.tasks) {
      if (t.project_id !== pid || t.children.length) continue;
      const k = norm(t.name);
      byName.set(k, [...(byName.get(k) || []), t]);
    }
    const used = new Set<number>();
    for (const x of items) {
      const same = byName.get(norm(x.name)) || [];
      const mine = same.find((t) => model.effOwner(t.id).unit === myOwner && !used.has(t.id));
      if (mine) {
        used.add(mine.id);
        const changes: string[] = [];
        if (x.fileStart && (mine.start_constraint || null) !== x.start) changes.push('התחלה');
        if (x.range && mine.kind !== 'milestone' && mine.duration !== Math.max(1, x.duration)) changes.push('משך');
        if (x.notes && (mine.notes || '') !== x.notes) changes.push('תיאור');
        m.set(x.key, { id: mine.id, changes });
      } else if (same.length) m.set(x.key, { other: model.ownerName(same[0].id) || 'בלי אחראי' });
    }
    return m;
  }, [items, fixed, target, model, myOwner]);
  const upd = (x: Item) => { const m = matches.get(x.key); return m && 'id' in m ? m : null; };
  const toAdd = items.filter((x) => !upd(x));
  const toUpdate = items.filter((x) => upd(x)?.changes.length);
  const same = items.length - toAdd.length - toUpdate.length;

  const minStart = items.reduce((m, x) => (x.start && (!m || x.start < m) ? x.start : m), '' as string) || model.data.today;
  const warnings = items.reduce((n, x) => n + x.warn.length, 0);

  const submit = async () => {
    const byWbsKey = new Map(items.filter((x) => x.wbs).map((x) => [x.wbs, x.key]));
    const deps = items.flatMap((x) => parsePreds(x.preds).map((p) => {
      const from = byWbsKey.get(p.ref) ?? (/^\d+$/.test(p.ref) && items[Number(p.ref) - 1] ? items[Number(p.ref) - 1].key : null);
      return from == null ? null : { from, to: x.key, type: p.type, lag: p.lag };
    })).filter(Boolean);
    const body: Record<string, unknown> = {
      file,
      tasks: items.filter((x) => !upd(x) || upd(x)!.changes.length).map((x) => upd(x) ? {
        key: x.key, update_id: upd(x)!.id, owner_unit_id: user.unit_id ?? null,
        ...(x.fileStart ? { start: x.start } : {}), ...(x.range ? { duration: Math.max(1, x.duration) } : {}), ...(x.notes ? { notes: x.notes } : {}),
      } : ({
        key: x.key, parent_key: x.parent_key, name: x.name, kind: kindOf(x), duration: durOf(x), start: x.start,
        percent: x.percent, deadline: x.deadline, notes: x.notes,
        owner_unit_id: fixed ? user.unit_id ?? null : x.owner && ownerOf(x.owner) ? Number(ownerOf(x.owner)) : null,
      })),
      deps,
    };
    if (target === 'new') body.new_project = { name: pname.trim() || 'פרויקט מיובא', start_date: minStart };
    else body.project_id = Number(target);
    setBusy(true);
    const r = await run(() => api.post<{ tasks: number; deps: number }>('/import', body));
    setBusy(false);
    if (r) onClose();
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="imp-head">
          <h2><Icon name="upload" size={18} /> ייבוא משימות מקובץ <span className="chip">ניסיוני</span></h2>
          <button className="icon-btn" onClick={onClose} aria-label="סגירה"><Icon name="x" /></button>
        </div>
        <div className="imp-row imp-fmt">
          <span className="seg small">
            <button className={fixed ? 'on' : ''} onClick={() => setFmt('fixed')}>הקובץ הקבוע</button>
            <button className={!fixed ? 'on' : ''} onClick={() => setFmt('free')}>קובץ אחר</button>
          </span>
          <span className="muted small">{fixed ? 'העמודות נלקחות לפי האות שלהן, בלי לבחור כלום.' : 'העמודות מותאמות לפי שמות הכותרות.'}</span>
        </div>
        <p className="muted small">קובץ Excel (xlsx) או CSV, {fixed ? 'משימה אחת בכל שורה' : 'עם שורת כותרות ומשימה אחת בכל שורה'}. שום דבר לא נשמר עד הלחיצה על "ייבוא", ואחריה אפשר לבטל את כל הייבוא בפעולה אחת (Ctrl+Z).</p>
        <label className="imp-file">
          <input type="file" accept=".xlsx,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); }} />
          {file ? <><Icon name="file" size={15} /> {file}</> : <><Icon name="upload" size={15} /> בחירת קובץ…</>}
        </label>
        {busy && !sheets && <p className="muted">קורא את הקובץ…</p>}
        {err && <p className="bad">{err}</p>}

        {sheet && (
          <div className="imp-body">
            <div className="imp-row">
              {sheets!.length > 1 && (
                <label>גיליון
                  <select value={si} onChange={(e) => { setSi(Number(e.target.value)); choose(sheets![Number(e.target.value)]); }}>
                    {sheets!.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
                  </select>
                </label>
              )}
              {!fixed && <label>שורת הכותרות
                <select value={hdr} onChange={(e) => { const h = Number(e.target.value); setHdr(h); setFields(guessFields((sheet.rows[h] || []).map((c) => c?.text || ''))); }}>
                  {sheet.rows.slice(0, 15).map((r, i) => <option key={i} value={i}>שורה {i + 1}: {(r || []).map((c) => c?.text).filter(Boolean).slice(0, 3).join(' · ').slice(0, 50)}</option>)}
                </select>
              </label>}
            </div>

            {fixed ? (
              <>
                <h3>1. מה נלקח מהקובץ</h3>
                <div className="imp-fixed">
                  <span><b>N</b> שם המשימה</span>
                  <span><b>O</b> תאריך התחלה</span>
                  <span><b>C</b> מועד סיום</span>
                  <span><b>J + K</b> תיאור (שורה ריקה ביניהם)</span>
                  <span><b>אחראי</b> {myUnit?.name || user.display_name}</span>
                </div>
                <p className="muted small">שאר העמודות לא נלקחות. שורות בלי שם משימה בעמודה N מדולגות.</p>
              </>
            ) : (<>
            <h3>1. מה כל עמודה בקובץ</h3>
            <p className="muted small">ההתאמה הראשונית לפי שמות הכותרות. בודקים ומתקנים לפי הצורך. חובה רק "שם המשימה".</p>
            <div className="imp-map">
              {Array.from({ length: width }, (_, i) => (
                <div key={i} className={`imp-col ${fields[i] && fields[i] !== 'ignore' ? 'on' : ''}`}>
                  <b>{headers[i] || `עמודה ${i + 1}`}</b>
                  <span className="muted tiny">{sheet.rows.slice(hdr + 1).map((r) => r[i]?.text).find(Boolean)?.slice(0, 30) || '—'}</span>
                  <select value={fields[i] || 'ignore'} onChange={(e) => setFields((f) => { const n = [...f]; const v = e.target.value as Field; if (v !== 'ignore') { const j = n.indexOf(v); if (j >= 0) n[j] = 'ignore'; } n[i] = v; return n; })}>
                    {FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </select>
                </div>
              ))}
            </div>
            </>)}

            {ownerNames.length > 0 && (
              <>
                <h3>2. האחראים בקובץ</h3>
                <p className="muted small">לכל שם בקובץ בוחרים מסגרת אצלנו.{!isAdmin && ` בלי בחירה, המשימה תהיה של ${user.display_name}.`}</p>
                <div className="imp-owners">
                  {ownerNames.map((n) => (
                    <label key={n}><span>{n}</span>
                      <select value={ownerOf(n)} onChange={(e) => setOwnerMap((m) => ({ ...m, [n]: e.target.value }))}>
                        <option value="">{isAdmin ? 'בלי אחראי' : user.display_name}</option>
                        {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
              </>
            )}

            <h3>{ownerNames.length ? 3 : 2}. לאן לייבא</h3>
            <div className="imp-row">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                {isAdmin && <option value="new">פרויקט חדש</option>}
                {model.projectList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {target === 'new' && <label>שם הפרויקט<input value={pname} onChange={(e) => setPname(e.target.value)} /></label>}
              {target === 'new' && <span className="muted small">יתחיל ב-{fmtDate(minStart)}</span>}
            </div>

            <h3>תצוגה מקדימה <span className="muted small">({items.length} שורות{milestones ? (milestones === 1 ? ', מתוכן אבן דרך אחת' : `, מתוכן ${milestones} אבני דרך`) : ''}{warnings ? `, ${warnings} אזהרות` : ''})</span></h3>
            <p className="muted small">בכל שורה אפשר לבחור אם היא משימה או אבן דרך. שורה שיש תחתיה משימות היא משימת סיכום, ולכן תמיד משימה.</p>
            {fixed && target !== 'new' && <p className="muted small">משימה שכבר קיימת בפרויקט באותו שם ובאחריות {myUnit?.name || user.display_name} מתעדכנת: התחלה, משך ותיאור מהקובץ. ההתקדמות שלה לא משתנה. אותו שם באחריות צוות אחר נחשב משימה חדשה.</p>}
            {fixed && !items.length ? <p className="bad small">לא נמצאו משימות: בקובץ הקבוע שם המשימה בעמודה N והתאריכים בעמודות C ו-O. אם זה קובץ אחר, בוחרים למעלה "קובץ אחר".</p>
              : !fixed && col('name') < 0 ? <p className="bad small">צריך לבחור איזו עמודה היא "שם המשימה".</p> : (
              <div className="imp-preview">
                <table className="hol-table">
                  <thead><tr><th>שם</th>{fixed && target !== 'new' && <th>מה יקרה</th>}<th>סוג</th><th>התחלה</th>{fixed && <th>סיום</th>}<th>משך</th>{fixed ? <th>תיאור</th> : <><th>הושלמה</th><th>אחראי</th></>}<th></th></tr></thead>
                  <tbody>
                    {items.map((x) => (
                      <tr key={x.key} className={x.warn.length ? 'warn' : ''}>
                        <td style={{ paddingInlineStart: 8 + x.depth * 16 }}>{kindOf(x) === 'milestone' && <Icon name="diamond" size={10} />} {x.name}</td>
                        {fixed && target !== 'new' && <td className="imp-what">{(() => {
                          const m = matches.get(x.key);
                          if (!m) return <span className="imp-tag new">חדשה</span>;
                          if ('other' in m) return <span title={`יש בפרויקט משימה בשם הזה, באחריות ${m.other}. צוות אחר = משימה אחרת.`}><span className="imp-tag new">חדשה</span><small className="muted imp-sub">אותו שם אצל {m.other}</small></span>;
                          return m.changes.length ? <span className="imp-tag upd">עדכון: {m.changes.join(', ')}</span> : <span className="muted small">ללא שינוי</span>;
                        })()}</td>}
                        <td>
                          {upd(x) ? <span className="muted small">קיימת</span> : parents.has(x.key) ? <span className="muted small">סיכום</span> : (
                            <span className="seg small imp-kind">
                              <button className={kindOf(x) === 'task' ? 'on' : ''} onClick={() => setKinds((k) => ({ ...k, [x.key]: 'task' }))}>משימה</button>
                              <button className={kindOf(x) === 'milestone' ? 'on' : ''} onClick={() => setKinds((k) => ({ ...k, [x.key]: 'milestone' }))}>אבן דרך</button>
                            </span>
                          )}
                        </td>
                        <td>{x.start ? fmtDate(x.start) : <span className="muted">לפי הפרויקט</span>}</td>
                        {fixed && <td>{x.finish ? fmtDate(x.finish) : <span className="muted">—</span>}</td>}
                        <td>{kindOf(x) === 'milestone' || parents.has(x.key) ? <span className="muted">—</span> : `${durOf(x)} י׳`}</td>
                        {fixed ? <td className="imp-notes" title={x.notes}>{x.notes ? x.notes.replace(/\s*\n\s*/g, ' · ') : <span className="muted">—</span>}</td> : <><td>{x.percent >= 100 ? '✓' : <span className="muted">—</span>}</td>
                        <td>{x.owner ? (model.units.get(Number(ownerOf(x.owner)))?.name || <span className="muted">{isAdmin ? '—' : user.display_name}</span>) : <span className="muted">—</span>}</td></>}
                        <td className="bad tiny">{x.warn.join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small imp-note">
              התאריכים אצלנו מחושבים: ההתחלה מהקובץ נשמרת כ"לא להתחיל לפני", והמשך נספר בימי עבודה בלי חגים. לכן סיום של משימה יכול לצאת אחר מהקובץ ביום-יומיים.
              {fixed ? ' המשך מחושב מההתחלה עד מועד הסיום.' : col('wbs') >= 0 ? ' ההיררכיה נבנית מעמודת המספור.' : ' בלי עמודת מספור, ההיררכיה נבנית מהזחת השם (אם יש).'}
            </p>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn primary" disabled={!sheet || !items.length || busy || (matches.size > 0 && !toAdd.length && !toUpdate.length)} onClick={submit}><Icon name="upload" size={15} /> {!matches.size ? `ייבוא ${items.length ? `${items.length} משימות` : ''}`
            : !toAdd.length && !toUpdate.length ? 'אין מה לעדכן'
            : [toAdd.length && `ייבוא ${toAdd.length === 1 ? 'משימה חדשה' : `${toAdd.length} חדשות`}`, toUpdate.length && `עדכון ${toUpdate.length === 1 ? 'משימה אחת' : `${toUpdate.length}`}`].filter(Boolean).join(' · ')}</button>
          {same > 0 && <span className="muted small">{same === 1 ? 'משימה אחת בלי שינוי' : `${same} משימות בלי שינוי`}</span>}
          <button className="btn" onClick={onClose}>ביטול</button>
        </div>
      </div>
    </div>
  );
}
