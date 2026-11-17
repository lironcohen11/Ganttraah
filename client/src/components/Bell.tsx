import { useEffect, useRef, useState } from 'react';
import { useApp } from '../ctx';
import { api } from '../api';
import { fmtDateTime, fmtDate } from '../dates';
import { Icon } from './Icon';

interface Notif { id: number; at: string; actor_name: string; kind: 'dep_add' | 'dep_edit' | 'dep_del' | 'task_del' | 'assign_new' | 'assign' | 'assign_many' | 'moved'; task_id: number | null;
  pred_id: number; succ_id: number; pred_name: string; succ_name: string; detail: string; unit_id: number; read: boolean }

/**
 * The bell: updates made by someone else about my unit (or a unit below it): a task handed to it
 * (new or existing), and dependencies linked, changed or removed on its tasks. Branch management has no bell.
 */
export function Bell() {
  const { model, openTask, reload, user } = useApp();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notif[] | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const unread = model.data.notif_unread || 0;
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    // opening the list reads nothing: an update is read when it is clicked, or with "read all"
    const r = await api.get<{ items: Notif[]; seen: number }>('/notifications');
    setItems(r.items);
  };
  const markRead = (n: Notif) => {
    if (n.read) return;
    setItems((l) => l && l.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    api.post(`/notifications/${n.id}/read`).then(reload, () => {});
  };
  const readAll = () => {
    setItems((l) => l && l.map((x) => ({ ...x, read: true })));
    api.post('/notifications/read-all').then(reload, () => {});
  };
  const newCount = items?.filter((n) => !n.read).length ?? 0;
  const text = (n: Notif) => {
    const mineIsSucc = n.task_id === n.succ_id;
    const mine = mineIsSucc ? n.succ_name : n.pred_name, other = mineIsSucc ? n.pred_name : n.succ_name;
    const whose = model.units.get(n.unit_id)?.name;
    const yours = n.unit_id === user.unit_id ? 'המשימה שלך' : `המשימה של ${whose}`;
    const toYou = n.unit_id === user.unit_id ? 'אליך' : `אל ${whose}`;
    const proj = n.detail ? <span className="muted"> (בפרויקט {n.detail})</span> : null;
    if (n.kind === 'moved') {
      // another unit's change moved my task's dates (detail: how many moved, first one's old/new dates)
      let d: { n: number; from: { start: string; finish: string }; to: { start: string; finish: string }; why: string };
      try { d = JSON.parse(n.detail); } catch { return <>שינה/תה משהו שהזיז את {yours} <b>"{n.succ_name}"</b>.</>; }
      const span = (a: string, b: string) => <>מ-<bdi>{fmtDate(a)}</bdi> ל-<bdi>{fmtDate(b)}</bdi></>;
      const dates = d.from.finish !== d.to.finish ? <>הסיום {span(d.from.finish, d.to.finish)}</> : <>ההתחלה {span(d.from.start, d.to.start)}</>;
      const theirs = n.unit_id === user.unit_id ? 'שלך' : `של ${whose}`;
      return <>{n.pred_name ? <>שינה/תה את <b>"{n.pred_name}"</b>, ובעקבות זה </> : <>{d.why ? <>שינה/תה ({d.why}), ובעקבות זה </> : 'עשה/תה שינוי, ובעקבותיו '}</>}
        {yours} <b>"{n.succ_name}"</b> זזה: {dates}.{d.n > 1 && <> {d.n === 2 ? 'זזה גם עוד משימה אחת' : `זזו גם עוד ${d.n - 1} משימות`} {theirs}.</>}</>;
    }
    if (n.kind === 'assign_new') return <>יצר/ה משימה חדשה ושייך/ה אותה {toYou}: <b>"{n.succ_name}"</b>{proj}.</>;
    if (n.kind === 'assign') return <>שייך/ה {toYou} את המשימה <b>"{n.succ_name}"</b>{proj}.</>;
    if (n.kind === 'assign_many') return <>ייבא/ה מקובץ {n.detail === '1' ? 'משימה אחת' : `${n.detail} משימות`} ושייך/ה אותן {toYou}, בפרויקט <b>"{n.succ_name}"</b>.</>;
    if (n.kind === 'task_del') return mineIsSucc
      ? <>מחק/ה את המשימה <b>"{other}"</b>{proj}, ש{yours} <b>"{mine}"</b> הייתה תלויה בה. התלות הוסרה, כדאי לבדוק את התאריכים.</>
      : <>מחק/ה את המשימה <b>"{other}"</b>{proj}, שהייתה תלויה ב{yours === 'המשימה שלך' ? 'משימה שלך' : yours.replace('המשימה', 'משימה')} <b>"{mine}"</b>. התלות הוסרה.</>;
    if (n.kind === 'dep_del') return <>הסיר/ה את התלות בין {yours} <b>"{mine}"</b> לבין <b>"{other}"</b>.</>;
    if (n.kind === 'dep_edit') return <>שינה/תה את התלות בין {yours} <b>"{mine}"</b> לבין <b>"{other}"</b>{n.detail ? ` (${n.detail})` : ''}.</>;
    return mineIsSucc
      ? <>קישר/ה תלות: {yours} <b>"{mine}"</b> תלויה עכשיו ב-<b>"{other}"</b>{n.detail ? ` (${n.detail})` : ''}.</>
      : <>קישר/ה תלות: {yours} <b>"{mine}"</b> משפיעה עכשיו על <b>"{other}"</b>.</>;
  };
  return (
    <span className="dd bell" ref={ref}>
      <button className={`icon-btn bell-btn ${unread ? 'has' : ''}`} onClick={toggle} title="עדכונים: משימות ששויכו אליך ותלויות במשימות שלך" aria-label={`עדכונים${unread ? `: ${unread} חדשים` : ''}`}>
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="bell-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="dd-menu bell-menu">
          <div className="bell-head"><b><Icon name="bell" size={15} /> עדכונים{newCount > 0 && <span className="bell-new">{newCount} חדשים</span>}
            {newCount > 0 && <button className="link small bell-readall" onClick={readAll}><Icon name="check" size={13} /> סמן הכול כנקרא</button>}</b><span className="muted small">משימות ששויכו אליך, משימות שלך שזזו בגלל שינוי של אחרים, ותלויות שאחרים קישרו, שינו או הסירו במשימות שלך ושל מי שמתחתיך</span></div>
          {items == null ? <p className="muted small bell-empty">טוען…</p>
            : !items.length ? <p className="muted small bell-empty">אין עדכונים עדיין.</p>
            : (
              <ul className="bell-list">
                {items.map((n) => (
                  <li key={n.id} className={n.read ? '' : 'new'} onClick={() => markRead(n)} title={n.read ? undefined : 'לחיצה מסמנת את העדכון כנקרא'}>
                    <span className={`bell-ic ${n.kind}`}><Icon name={n.kind === 'task_del' ? 'trash' : n.kind === 'dep_del' ? 'x' : n.kind === 'moved' ? 'calendar' : n.kind.startsWith('assign') ? 'user' : 'link'} size={13} /></span>
                    <div className="bell-body">
                      <div><b>{n.actor_name}</b> {text(n)}</div>
                      <div className="bell-meta">
                        <span className="muted tiny">{fmtDateTime(n.at)}</span>
                        {n.task_id != null && model.task(n.task_id) && (
                          <button className="link small" onClick={(e) => { e.stopPropagation(); markRead(n); setOpen(false); openTask(n.task_id!); }}>למשימה ›</button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </span>
  );
}
