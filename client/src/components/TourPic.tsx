/**
 * Small looping pictures for tour steps: the action is acted out on a few drawn shapes, so it can be
 * understood even when the plan is empty. Time runs from right to left, as in the Gantt. Every
 * picture has three phases of three seconds, each with its own caption.
 */
type Pic = 'timeline' | 'create' | 'undo' | 'deps' | 'whatif' | 'highlight';

function Cursor() {
  return <g className="tp-cursor"><path d="M0,0 L0,14 L4,10 L7,17 L9,16 L6,9 L11,9 Z" /></g>;
}
function Captions({ c }: { c: [string, string, string] }) {
  return <>{c.map((t, i) => <text key={i} x="160" y="104" className={`tp-cap c${i + 1}`}>{t}</text>)}</>;
}

export function TourPic({ name }: { name: Pic }) {
  return (
    <div className={`tour-pic tp-${name}`} aria-hidden="true">
      <svg viewBox="0 0 320 112" width="100%" height="112">
        {name === 'timeline' && <Timeline />}
        {name === 'create' && <Create />}
        {name === 'undo' && <Undo />}
        {name === 'deps' && <Deps />}
        {name === 'whatif' && <WhatIf />}
        {name === 'highlight' && <Highlight />}
      </svg>
    </div>
  );
}

function Timeline() {
  return (
    <>
      <defs>
        <marker id="tp-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="var(--g-arrow)" />
        </marker>
      </defs>
      <line x1="8" x2="312" y1="44" y2="44" className="tp-grid" />
      <line x1="8" x2="312" y1="84" y2="84" className="tp-grid" />
      {[60, 120, 180, 240].map((x) => <line key={x} x1={x} x2={x} y1="8" y2="84" className="tp-grid" />)}
      <rect x="190" y="17" width="100" height="16" rx="4" className="tp-bar" />
      <circle cx="190" cy="25" r="4.5" className="tp-dot" />
      <rect x="70" y="57" width="80" height="16" rx="4" className="tp-bar b" />
      <path d="M186,25 C158,25 162,65 134,65" className="tp-link" markerEnd="url(#tp-ah)" />
      <Cursor />
      <Captions c={['גוררים פס כדי להזיז משימה', 'מושכים את הקצה כדי לשנות משך', 'גוררים מהעיגול כדי לקשר משימות']} />
    </>
  );
}

function Create() {
  return (
    <>
      {/* the plan: a project row, and the new task that opens right under it */}
      <rect x="14" y="12" width="150" height="20" rx="4" className="tp-row" />
      <text x="156" y="26" className="tp-label strong">פרויקט</text>
      <g className="tp-new">
        <rect x="14" y="36" width="150" height="20" rx="4" className="tp-row new" />
        <text x="148" y="50" className="tp-label">משימה חדשה</text>
      </g>
      <g className="tp-old">
        <rect x="14" y="36" width="150" height="20" rx="4" className="tp-row" />
        <text x="148" y="50" className="tp-label muted">משימה קיימת</text>
      </g>
      {/* the button and its menu */}
      <rect x="226" y="8" width="80" height="22" rx="5" className="tp-btn" />
      <text x="266" y="23" className="tp-btn-t">+ יצירה</text>
      <g className="tp-menu">
        <rect x="196" y="34" width="110" height="60" rx="6" className="tp-menu-bg" />
        <rect x="200" y="38" width="102" height="16" rx="4" className="tp-menu-hl" />
        <text x="294" y="50" className="tp-label">משימה</text>
        <text x="294" y="68" className="tp-label">תת-משימה</text>
        <text x="294" y="86" className="tp-label">אבן דרך</text>
      </g>
      <Cursor />
      <Captions c={['לוחצים על "יצירה"', 'בוחרים מה ליצור', 'השורה החדשה נפתחת מתחת לשורה המסומנת']} />
    </>
  );
}

function Undo() {
  return (
    <>
      <line x1="8" x2="312" y1="70" y2="70" className="tp-grid" />
      {[60, 120, 180, 240].map((x) => <line key={x} x1={x} x2={x} y1="36" y2="70" className="tp-grid" />)}
      <rect x="150" y="45" width="100" height="16" rx="4" className="tp-bar u" />
      {/* the two arrows, like in the toolbar: undo (right) and redo (left) */}
      <g className="tp-k undo"><rect x="282" y="6" width="26" height="22" rx="5" className="tp-key" /><text x="295" y="22" className="tp-key-t">↶</text></g>
      <g className="tp-k redo"><rect x="252" y="6" width="26" height="22" rx="5" className="tp-key" /><text x="265" y="22" className="tp-key-t">↷</text></g>
      <Cursor />
      <Captions c={['הזזתם משהו בטעות?', 'ביטול מחזיר אחורה (Ctrl+Z)', 'ביצוע שוב מחזיר קדימה (Ctrl+Y)']} />
    </>
  );
}

/** the dependency map: the chosen task in the middle, what drives it on the right, what it drives on the left */
function Deps() {
  const card = (x: number, y: number, cls: string, label: string) => (
    <g className={`tp-card ${cls}`}>
      <rect x={x} y={y} width="74" height="22" rx="5" />
      <text x={x + 66} y={y + 15} className="tp-label">{label}</text>
    </g>
  );
  return (
    <>
      <path d="M232,24 C214,24 214,44 197,44" className="tp-dl up solid" />
      <path d="M232,66 C214,66 214,48 197,48" className="tp-dl up dash" />
      <path d="M123,44 C106,44 106,24 88,24" className="tp-dl down solid" />
      <path d="M123,48 C106,48 106,66 88,66" className="tp-dl down dash" />
      {card(232, 13, 'up a', 'משפיעה')}
      {card(232, 55, 'up b', 'משפיעה')}
      <g className="tp-card mid">
        <rect x="123" y="33" width="74" height="26" rx="6" />
        <text x="189" y="50" className="tp-label strong">המשימה</text>
      </g>
      {card(14, 13, 'down a', 'מושפעת')}
      {card(14, 55, 'down b', 'מושפעת')}
      <Captions c={['במרכז: המשימה שבחרת', 'מימין, בכתום: מה שמשפיע עליה', 'משמאל, בסגול: מה שהיא משפיעה עליו']} />
    </>
  );
}

/** selecting a task: what drives it turns orange, what it drives turns purple */
function Highlight() {
  return (
    <>
      <defs>
        {(['n', 'u', 'd'] as const).map((k) => (
          <marker key={k} id={`tph-ah-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className={`tph-head ${k}`} />
          </marker>
        ))}
      </defs>
      {[30, 62, 94].map((y) => <line key={y} x1="8" x2="312" y1={y} y2={y} className="tp-grid" />)}
      <rect x="126" y="36" width="78" height="20" rx="6" className="tph-sel" />
      <rect x="212" y="10" width="80" height="14" rx="4" className="tp-bar tph-a" />
      <rect x="130" y="40" width="70" height="14" rx="4" className="tp-bar" />
      <rect x="40" y="72" width="76" height="14" rx="4" className="tp-bar tph-c" />
      <path d="M212,17 C196,17 214,47 200,47" className="tph-arr up" markerEnd="url(#tph-ah-u)" />
      <path d="M130,47 C114,47 130,79 116,79" className="tph-arr down" markerEnd="url(#tph-ah-d)" />
      <Cursor />
      <Captions c={['לוחצים על משימה', 'בכתום: מה שמשפיע עליה', 'בסגול: מה שהיא משפיעה עליו']} />
    </>
  );
}

/** what-if: the task is late by 3 days, and the tasks after it move with it */
function WhatIf() {
  return (
    <>
      <line x1="8" x2="312" y1="36" y2="36" className="tp-grid" />
      <line x1="8" x2="312" y1="62" y2="62" className="tp-grid" />
      <line x1="8" x2="312" y1="88" y2="88" className="tp-grid" />
      <g className="tp-chip"><rect x="208" y="0" width="104" height="18" rx="9" /><text x="260" y="13" className="tp-chip-t">מתעכבת ב-3 ימים</text></g>
      {/* where things were (dashed) and where they move to */}
      <rect x="200" y="22" width="90" height="12" rx="3" className="tp-ghost" />
      <rect x="200" y="22" width="90" height="12" rx="3" className="tp-bar w1" />
      <rect x="120" y="48" width="70" height="12" rx="3" className="tp-ghost" />
      <rect x="120" y="48" width="70" height="12" rx="3" className="tp-bar w2" />
      <rect x="50" y="74" width="60" height="12" rx="3" className="tp-ghost" />
      <rect x="50" y="74" width="60" height="12" rx="3" className="tp-bar w2" />
      <text x="96" y="58" className="tp-plus p1">+3</text>
      <text x="26" y="84" className="tp-plus p2">+3</text>
      <Captions c={['בוחרים: מתעכבת ב-3 ימים', 'המשימה מתארכת', 'ורואים מי זז בעקבותיה, ובכמה']} />
    </>
  );
}
