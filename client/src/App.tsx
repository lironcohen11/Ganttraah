import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Model } from './model';
import type { AppData, User, Unit } from './types';
import { AppCtx, movedMessage, type Ctx, type SimOverlay } from './ctx';
import { GanttPage } from './components/GanttPage';
import { FocusView } from './components/FocusView';
import { PresentView } from './components/PresentView';
import { HistoryView } from './components/HistoryView';
import { SettingsView } from './components/SettingsView';
import { Icon } from './components/Icon';
import { OrgLogos } from './components/OrgLogos';
import { LandingBg } from './components/LandingBg';
import { getThemePref, setThemePref, type ThemePref } from './theme';
import logoUrl from './assets/logo.png';
import logoDarkUrl from './assets/logo-dark.png';
import { Tour, tourSeen, markTourSeen, PRESENT_STEPS, SETTINGS_STEPS, ORG_STEPS } from './components/Tour';

// Every new visit starts at the landing page ("choose your team"). Within the same browser
// tab the choice is kept, so refreshing the page does not send you back there.
const ss = {
  get: () => { try { return sessionStorage.getItem('gantraah.entered') === '1'; } catch { return false; } },
  set: (v: boolean) => { try { if (v) sessionStorage.setItem('gantraah.entered', '1'); else sessionStorage.removeItem('gantraah.entered'); } catch { /* ignore */ } },
};

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    if (!ss.get()) { setUser(null); return; }
    api.get<{ user: User | null }>('/me').then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);
  if (user === undefined) return <div className="splash"><Logo /></div>;
  if (!user) return <Landing onEnter={(u) => { ss.set(true); setUser(u); }} />;
  return <Shell user={user} onLogout={async () => { ss.set(false); await api.post('/logout'); setUser(null); }} />;
}

export function Logo({ small }: { small?: boolean }) {
  return (
    <span className={`logo ${small ? 'small' : ''}`}>
      <img className="logo-light" src={logoUrl} alt="Ganttraah" height={small ? 34 : 64} />
      <img className="logo-dark" src={logoDarkUrl} alt="Ganttraah" height={small ? 34 : 64} />
    </span>
  );
}

/**
 * Every entry (or switch of unit) starts from the same place: the owner filter shows the
 * unit's own tasks and those of the units below it, the project bar shows its own projects.
 */
function resetFilters(units: Unit[], u: User) {
  const below = (id: number): number[] => [id, ...units.filter((x) => x.parent_id === id).flatMap((x) => below(x.id))];
  const owners = u.role === 'admin' || u.unit_id == null ? [] : below(u.unit_id);
  try {
    localStorage.setItem('gantraah.owners', JSON.stringify(owners));
    localStorage.setItem('gantraah.filter', 'null');
    localStorage.setItem('gantraah.allProjects', 'false');
    localStorage.setItem('gantraah.favOnly', 'false');
    for (const k of ['gantraah.meet.pick', 'gantraah.meet.ownerFilter', 'gantraah.meet.favOnly', 'gantraah.whatif']) localStorage.removeItem(k);
  } catch { /* ignore */ }
  if (location.hash && location.hash !== '#/gantt') history.replaceState(null, '', '#/gantt');
}

/** Landing page: "Hello, choose your team" + the organisation tree. */
function Landing({ onEnter }: { onEnter: (u: User) => void }) {
  const [units, setUnits] = useState<Unit[] | null>(null);
  const [err, setErr] = useState('');
  const last = (() => { try { return Number(localStorage.getItem('gantraah.lastUnit')) || null; } catch { return null; } })();
  useEffect(() => { api.get<Unit[]>('/units').then(setUnits).catch((e) => setErr(e.message)); }, []);
  const [pwFor, setPwFor] = useState<Unit | null>(null);
  const [pw, setPw] = useState('');
  const [pwErr, setPwErr] = useState('');
  const enter = async (unitId: number | null, password?: string) => {
    const u = units?.find((x) => x.id === unitId);
    if (u && u.parent_id == null && password == null) { setPwFor(u); setPw(''); setPwErr(''); return; } // branch management: password first
    try {
      const r = await api.post<{ user: User }>('/enter', unitId == null ? { view_only: true } : { unit_id: unitId, password });
      try { if (unitId != null) localStorage.setItem('gantraah.lastUnit', String(unitId)); } catch { /* ignore */ }
      resetFilters(units || [], r.user);
      onEnter(r.user);
    } catch (e) { if (password != null) setPwErr((e as Error).message); else setErr((e as Error).message); }
  };
  const kids = (pid: number | null) => (units || []).filter((u) => u.parent_id === pid).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const root = kids(null)[0];
  const lastUnit = units?.find((u) => u.id === last);
  // hover a unit -> light up every unit below it (the ones it can also edit)
  const [hover, setHover] = useState<number | null>(null);
  const below = (id: number, of: number | null) => {
    if (of == null || id === of) return false;
    let x = units?.find((u) => u.id === id)?.parent_id ?? null;
    for (let i = 0; i < 20 && x != null; i++) { if (x === of) return true; x = units?.find((u) => u.id === x)?.parent_id ?? null; }
    return false;
  };
  const hu = units?.find((u) => u.id === hover);
  const coveredCount = hu ? (units || []).filter((u) => below(u.id, hu.id)).length : 0;
  // a plain render function (not a component), so hovering does not re-create the buttons
  const card = (u: Unit, big?: boolean) => (
    <button key={u.id} className={`org-card ${u.kind} ${big ? 'big' : ''} ${u.id === last ? 'last' : ''} ${u.id === hover ? 'hovered' : ''} ${below(u.id, hover) ? 'covered' : ''}`}
      onClick={() => enter(u.id)} onMouseEnter={() => setHover(u.id)} onMouseLeave={() => setHover((h) => (h === u.id ? null : h))}
      onFocus={() => setHover(u.id)} onBlur={() => setHover((h) => (h === u.id ? null : h))}>
      <span className="oc-name">{u.name}</span>
    </button>
  );
  return (
    <div className="landing">
      <LandingBg />
      <header className="landing-top">
        <Logo />
      </header>
      <h1>שלום, בחר/י את המסגרת שלך</h1>
      <p className="muted">כולם רואים את כל התוכנית. אפשר לערוך רק משימות שבאחריות היחידה שלך, או של היחידות שמתחתיה.</p>
      {lastUnit && (
        <button className="btn primary continue" onClick={() => enter(lastUnit.id)}>להמשיך כ{lastUnit.name} ›</button>
      )}
      {err && <p className="bad">{err}</p>}
      <p className={`hover-hint ${hu ? 'on' : ''}`}>
        {hu ? (hu.kind === 'branch' ? <>בכניסה כ<b>{hu.name}</b> אפשר לערוך את כל התוכנית.</>
          : coveredCount ? <>בכניסה כ<b>{hu.name}</b> אפשר לערוך את המשימות שלו ושל {coveredCount} היחידות שמתחתיו (מסומנות).</>
          : <>בכניסה כ<b>{hu.name}</b> אפשר לערוך את המשימות של הצוות.</>) : 'העבר/י את העכבר על יחידה כדי לראות מה היא יכולה לערוך.'}
      </p>
      {pwFor && (
        <div className="modal-bg" onClick={() => setPwFor(null)}>
          <form className="modal pw-modal" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); enter(pwFor.id, pw); }}>
            <h2><Icon name="lock" size={18} /> כניסה כ{pwFor.name}</h2>
            <p className="muted small">הנהלת הענף עורכת את כל התוכנית, ולכן הכניסה אליה מוגנת בסיסמה.</p>
            <input type="password" autoFocus placeholder="סיסמה" value={pw} onChange={(e) => { setPw(e.target.value); setPwErr(''); }} />
            {pwErr && <p className="bad small">{pwErr}</p>}
            <div className="modal-actions">
              <button className="btn primary" type="submit" disabled={!pw}>כניסה</button>
              <button className="btn" type="button" onClick={() => setPwFor(null)}>ביטול</button>
            </div>
          </form>
        </div>
      )}
      {root && (
        <div className="org-tree">
          <div className="org-root">{card(root, true)}</div>
          <div className="org-sections">
            {kids(root.id).map((s) => (
              <div key={s.id} className="org-col">
                {card(s)}
                <div className="org-teams">{kids(s.id).map((t) => card(t))}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      <footer className="landing-foot">
        <OrgLogos size={56} />
        <p>נוצר ע״י לירון כהן</p>
        <p className="muted">מתוחזק ע״י ?</p>
      </footer>
    </div>
  );
}

interface Toast { id: number; msg: string; kind: 'info' | 'ok' | 'error' }

/** the screens' tabs; a marker glides to the chosen one */
function NavTabs({ items, page }: { items: { id: string; label: string; icon: string; href: string }[]; page: string }) {
  const ref = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const first = useRef(true);
  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const measure = () => {
      const a = nav.querySelector<HTMLElement>('a.on');
      setPill(a ? { left: a.offsetLeft, width: a.offsetWidth } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(nav);
    return () => ro.disconnect();
  }, [page]);
  useEffect(() => { if (pill) first.current = false; }, [pill]);
  return (
    <nav data-tour="nav" ref={ref}>
      {pill && <span className={`nav-pill ${first.current ? 'still' : ''}`} style={{ left: pill.left, width: pill.width }} />}
      {items.map((n) => (
        <a key={n.id} href={n.href} className={page === n.id ? 'on' : ''}><Icon name={n.icon} size={16} />{n.label}</a>
      ))}
    </nav>
  );
}

/** light / dark / like the device: a sun or moon next to the unit's name, with a small menu */
const LOOKS: { id: ThemePref; label: string; icon: string }[] = [
  { id: 'light', label: 'בהירה', icon: 'sun' },
  { id: 'dark', label: 'כהה', icon: 'moon' },
  { id: 'system', label: 'לפי המכשיר', icon: 'auto' },
];
function ThemeButton() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const cur = LOOKS.find((l) => l.id === pref)!;
  return (
    <span className="dd" ref={ref}>
      <button className="icon-btn theme-btn" onClick={() => setOpen(!open)} title={`תצוגה: ${cur.label}`} aria-label={`תצוגה: ${cur.label}`}>
        <Icon name={cur.icon} size={17} />
      </button>
      {open && (
        <div className="dd-menu theme-menu">
          {LOOKS.map((l) => (
            <button key={l.id} className={`dd-item ${pref === l.id ? 'on' : ''}`} onClick={() => { setPref(l.id); setThemePref(l.id); setOpen(false); }}>
              <Icon name={l.icon} size={15} /><span><b>{l.label}</b></span>{pref === l.id && <Icon name="check" size={14} className="dd-check" />}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function Shell({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [data, setData] = useState<AppData | null>(null);
  const [hash, setHash] = useState(() => location.hash || '#/gantt');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [openRequest, setOpenRequest] = useState<{ id: number; n: number } | null>(null);
  const [lastFocus, setLastFocus] = useState<number | null>(null);
  const [sim, setSim] = useState<SimOverlay | null>(null);
  const [tour, setTour] = useState<false | 'main' | 'present' | 'settings' | 'org'>(false);
  // the tour of the screen you are on: the manager view has its own short one
  const startTour = () => {
    if (location.hash.startsWith('#/present')) { setTour('present'); return; }
    if (location.hash.startsWith('#/settings')) { setTour(document.querySelector('.org-tree.edit') ? 'org' : 'settings'); return; }
    if (location.hash && !location.hash.startsWith('#/gantt')) location.hash = '#/gantt';
    setTimeout(() => setTour('main'), 350);
  };
  // first visit on this computer: show the tour once
  // (only on the main screen, so it never pulls anyone away from the meeting-room view)
  useEffect(() => {
    const onMain = !location.hash || location.hash.startsWith('#/gantt');
    if (data && onMain && !tourSeen()) { const t = setTimeout(() => setTour('main'), 700); return () => clearTimeout(t); }
  }, [!!data]); // eslint-disable-line
  const [online, setOnline] = useState(true);
  const tid = useRef(1);

  const toast = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = tid.current++;
    setToasts((t) => [...t.slice(-3), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4500);
  }, []);

  const reload = useCallback(async () => {
    try { setData(await api.get<AppData>('/data')); }
    catch (e) { if ((e as { status?: number }).status === 401) location.reload(); else toast((e as Error).message, 'error'); }
  }, [toast]);
  useEffect(() => { reload(); }, [reload]);

  // live updates from other users
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let timer: number | undefined;
    if (import.meta.env.VITE_DEMO === '1') return; // the demo has no server: nobody else can change the plan
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => setOnline(true);
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.type === 'changed') {
            reload();
            if (m.by && m.by !== user.display_name && m.summary) toast(`${m.by}: ${m.summary}`);
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => { setOnline(false); if (!stop) timer = window.setTimeout(connect, 2500); };
    };
    connect();
    return () => { stop = true; clearTimeout(timer); ws?.close(); };
  }, [reload, toast, user.display_name]);

  useEffect(() => {
    const h = () => setHash(location.hash || '#/gantt');
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  const go = useCallback((h: string) => { if (location.hash !== h) location.hash = h; else setHash(h); }, []);

  const model = useMemo(() => (data ? new Model(data) : null), [data]);
  const canEdit = user.role === 'admin' || user.role === 'editor';

  const run = useCallback(async <T,>(fn: () => Promise<T>, okMsg?: string) => {
    try {
      const r = await fn();
      await reload();
      const mm = movedMessage(r);
      if (okMsg || mm) toast([okMsg, mm].filter(Boolean).join(' · '), 'ok');
      return r;
    } catch (e) {
      toast((e as Error).message, 'error');
      await reload();
      return undefined;
    }
  }, [reload, toast]);

  const undoBusy = useRef(false);
  const undoRedo = useCallback((kind: 'undo' | 'redo') => {
    if (undoBusy.current) return; // one at a time: wait for the previous undo/redo to finish
    const e = data?.undo?.[kind];
    if (!e) return;
    if (e.blocked) { toast(`אי אפשר ${kind === 'undo' ? 'לבטל' : 'לבצע שוב'}: מישהו אחר שינה את התוכנית בינתיים.`, 'error'); return; }
    undoBusy.current = true;
    run(() => api.post(`/${kind}`), kind === 'undo' ? `בוטל: ${e.label}` : `בוצע שוב: ${e.label}`)
      .finally(() => { undoBusy.current = false; });
  }, [data, run, toast]);

  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (by key position, so it works with a Hebrew keyboard layout too)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !canEdit) return;
      if (e.repeat) { if (e.code === 'KeyZ' || e.code === 'KeyY') e.preventDefault(); return; } // key held down: act once
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"]')) return; // keep native text undo
      if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undoRedo('undo'); }
      else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); undoRedo('redo'); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [undoRedo, canEdit]);

  if (!model) return <div className="splash"><Logo /></div>;

  const route = hash.replace(/^#\/?/, '').split('/');
  const page = route[0] || 'gantt';
  const focusId = page === 'focus' && route[1] ? Number(route[1]) : lastFocus;

  const ctx: Ctx = {
    model, user, canEdit, isAdmin: user.role === 'admin', reload, run, toast, go, sim, setSim, undoRedo,
    toggleFavorite: (id) => {
      const on = !model.favorites.has(id);
      api.post('/favorites', { task_id: id, on }).then(reload, (e) => toast((e as Error).message, 'error'));
      toast(on ? 'נוסף למועדפים' : 'הוסר מהמועדפים', 'ok');
    },
    canEditTask: (id) => {
      if (user.role === 'admin' || (user.role === 'editor' && user.edit_all)) return true;
      if (user.role !== 'editor' || user.unit_id == null) return false;
      const o = model.effOwner(id).unit;
      return o != null && model.unitWithin(o, user.unit_id);
    },
    assignable: user.role === 'admin' || user.edit_all ? model.unitTree().map((x) => x.unit) : user.unit_id != null ? model.unitTree(user.unit_id).map((x) => x.unit) : [],
    openTask: (id) => { setOpenRequest({ id, n: Date.now() }); go('#/gantt'); },
    focusTask: (id) => { setLastFocus(id); go(`#/focus/${id}`); },
  };

  const nav = [
    { id: 'gantt', label: 'תכנית עבודה', icon: 'gantt', href: '#/gantt' },
    { id: 'focus', label: 'מפת תלויות', icon: 'deps', href: focusId ? `#/focus/${focusId}` : '#/focus' },
    { id: 'present', label: 'תצוגת מנהלים', icon: 'present', href: '#/present' },
    { id: 'history', label: 'היסטוריה', icon: 'history', href: '#/history' },
    { id: 'settings', label: 'הגדרות', icon: 'settings', href: '#/settings' },
  ];
  const hasTour = page === 'gantt' || page === 'present' || page === 'settings';

  return (
    <AppCtx.Provider value={ctx}>
      <div className="shell">
        <header className="topbar">
          <a href="#/gantt" className="brand"><Logo small /></a>
          <NavTabs items={nav} page={page} />
          <span style={{ flex: 1 }} />
          {import.meta.env.VITE_DEMO === '1' && (
            <button className="icon-btn" title="החזרת נתוני הדוגמה למצב ההתחלתי" onClick={async () => {
              if (!confirm('להחזיר את נתוני הדוגמה למצב ההתחלתי? כל השינויים שנעשו כאן יימחקו.')) return;
              (await import('./demo/backend')).resetDemo();
              location.reload();
            }}><Icon name="refresh" size={16} /></button>
          )}
          {!online && <span className="offline">אין חיבור לשרת, מנסה להתחבר מחדש…</span>}
          {data!.cycle && <span className="chip bad">נמצאה תלות מעגלית</span>}
          <span className="me"><Icon name="user" size={15} />{user.display_name}</span>
          <ThemeButton />
          {hasTour && <button className="btn small" data-tour="help" title="סיור קצר במסך הזה" onClick={startTour}>סיור</button>}
          <button className="btn small" title="יציאה וחזרה לבחירת המסגרת" onClick={onLogout}><Icon name="logout" size={14} /> יציאה</button>
          <span className="topbar-sep" />
          <OrgLogos size={32} />
        </header>
        <main>
          {page === 'gantt' && <GanttPage openRequest={openRequest} />}
          {tour && <Tour steps={tour === 'present' ? PRESENT_STEPS : tour === 'settings' ? SETTINGS_STEPS : tour === 'org' ? ORG_STEPS : undefined} onClose={() => { if (tour === 'main') markTourSeen(); setTour(false); }} />}
          {page === 'focus' && <FocusView taskId={focusId && model.task(focusId) ? focusId : null} />}
          {page === 'present' && <PresentView />}
          {page === 'history' && <HistoryView />}
          {page === 'settings' && <SettingsView />}
        </main>
        <div className="toasts">
          {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.msg}</div>)}
        </div>
      </div>
    </AppCtx.Provider>
  );
}
