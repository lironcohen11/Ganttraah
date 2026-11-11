import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * A very short guided tour of the main screen: a soft spotlight on one thing at a time
 * and a bubble with one or two sentences. Steps whose element is not on screen
 * (e.g. edit buttons when they don't apply) are skipped.
 */
interface Step {
  target?: string;   // CSS selector; several joined by "|" are highlighted together
  need?: string;     // element that must exist for the step to be shown (default: target)
  action?: string;   // something to show on screen first (sent to the page as a "gantraah-tour" event)
  title: string;
  text: string;
}

const act = (name: string) => window.dispatchEvent(new CustomEvent('gantraah-tour', { detail: name }));

export const MAIN_STEPS: Step[] = [
  { title: 'ברוכים הבאים ל-Gantraah', text: 'סיור קצר של חצי דקה: מה יש כאן ואיך עובדים. אפשר לדלג בכל רגע.' },
  { target: '[data-tour="nav"]', title: 'המסכים', text: 'תכנית עבודה: לעבודה היומיומית. מפת השפעות: מה משפיע על משימה ומה היא משפיעה. תצוגת מנהלים: למסך הגדול בחדר הישיבות.' },
  { target: '[data-tour="add"]', title: 'הוספת משימות', text: 'מכאן מוסיפים משימה, תת-משימה או אבן דרך. משימה חדשה שייכת למסגרת שלך.' },
  { target: '.g-table', title: 'רשימת המשימות', text: 'כל שורה היא משימה. לחיצה פותחת את הפרטים בצד, ולחיצה כפולה על השם משנה אותו.' },
  { target: '.g-chart', title: 'ציר הזמן', text: 'גוררים פס כדי להזיז משימה, ומושכים את הקצה שלו כדי לשנות את המשך. כדי לקשר בין משימות, גוררים מהעיגול שבקצה הפס אל משימה אחרת.' },
  { target: '[data-tour="undo"]', title: 'טעיתם?', text: 'החיצים מבטלים ומחזירים את הפעולה האחרונה. אפשר גם עם Ctrl+Z.' },
  { target: '[data-tour="filters"]', title: 'סינון', text: 'מכאן מציגים רק פרויקט מסוים, או רק את המשימות של מסגרות מסוימות.' },
  { target: '[data-tour="help"]', title: 'זהו!', text: 'אפשר לחזור לסיור בכל זמן מהכפתור הזה.' },
];

export const PRESENT_STEPS: Step[] = [
  { target: '[data-tour="m-kpis"]', title: 'המספרים החשובים', text: 'כמה מהעבודה הושלם, מתי צפוי הסיום, מה דורש תשומת לב, ומהי אבן הדרך הבאה.' },
  { target: '[data-tour="m-timeline"]', action: 'reset', title: 'ציר הזמן', text: 'כל פס הוא שלב בעבודה, וצבע הפס הוא המצב שלו: ירוק בזמן, כתום בסיכון, אדום באיחור.' },
  { target: '.mt-row.popped .mt-hit|.mt-stack', need: '[data-tour="m-timeline"]', action: 'pop', title: 'מה משפיע ועל מה', text: 'עומדים עם העכבר שנייה על פס, ולידו קופצות המשימות שמשפיעות עליו (מימין, בכתום) והמשימות שמושפעות ממנו (משמאל, בסגול). לחיצה על אחת מהן פותחת את הפרטים שלה.' },
  { target: '.mt-row.tour-hl', need: '[data-tour="m-timeline"]', action: 'open', title: 'מה יש בתוך שלב', text: 'לחיצה על שלב פותחת מתחתיו את המשימות שבתוכו. לחיצה נוספת סוגרת.' },
  { target: '[data-tour="m-tools"]', title: 'הגדרות ומסך מלא', text: 'בגלגל השיניים בוחרים מה להציג. הכפתור שלידו פותח מסך מלא לחדר הישיבות.' },
];

export function Tour({ onClose, steps: all = MAIN_STEPS }: { onClose: () => void; steps?: Step[] }) {
  const steps = all.filter((s) => !(s.need ?? s.target) || document.querySelector((s.need ?? s.target)!.split('|')[0]));
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = steps[Math.min(i, steps.length - 1)];

  useLayoutEffect(() => {
    const measure = () => {
      if (step.target?.includes('|') || step.action) {
        // union of everything the selectors match (e.g. a bar and the cards next to it)
        const els = (step.target || '').split('|').flatMap((q) => [...document.querySelectorAll(q)]);
        if (els.length) {
          const rs = els.map((e) => e.getBoundingClientRect());
          const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top));
          const r = Math.max(...rs.map((r) => r.right)), b = Math.max(...rs.map((r) => r.bottom));
          setRect(new DOMRect(l, t, r - l, b - t));
          return;
        }
      }
      const el = step.target ? document.querySelector(step.target.split('|')[0]) : null;
      if (el && step.target === '.g-chart') {
        // only the visible part of the timeline, without the task table next to it
        const c = el.getBoundingClientRect();
        const g = document.querySelector('.gantt')?.getBoundingClientRect();
        const t = document.querySelector('.g-table')?.getBoundingClientRect();
        if (g && t) { setRect(new DOMRect(g.left, c.top, Math.max(80, t.left - g.left), Math.min(c.bottom, g.bottom) - c.top)); return; }
      }
      if (el && step.target === '.g-table') {
        const c = el.getBoundingClientRect();
        const g = document.querySelector('.gantt')?.getBoundingClientRect();
        if (g) { setRect(new DOMRect(c.left, c.top, c.width, Math.min(c.bottom, g.bottom) - c.top)); return; }
      }
      setRect(el ? el.getBoundingClientRect() : null);
    };
    if (step.action) act(step.action);
    measure();
    // give the page a moment to show what the step demonstrates, then measure again
    const t1 = window.setTimeout(measure, 120), t2 = window.setTimeout(measure, 450);
    window.addEventListener('resize', measure);
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener('resize', measure); };
  }, [step]);
  useEffect(() => () => { act('reset'); }, []); // leave the page as it was

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' || e.key === 'Enter') next();
      if (e.key === 'ArrowRight') setI((n) => Math.max(0, n - 1));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  const last = i >= steps.length - 1;
  const next = () => (last ? onClose() : setI(i + 1));

  // spotlight box (clamped to the window) and the bubble under it, or above when there is no room
  const pad = 6;
  const vw = window.innerWidth, vh = window.innerHeight;
  const box = rect && {
    left: Math.max(4, rect.left - pad), top: Math.max(4, rect.top - pad),
    width: Math.min(vw - 8, rect.width + pad * 2), height: Math.min(vh - 8, rect.height + pad * 2),
  };
  const BW = 360;
  let bubble: React.CSSProperties = { left: (vw - BW) / 2, top: vh / 2 - 90 };
  if (box) {
    const below = box.top + box.height + 14;
    const left = Math.min(vw - BW - 12, Math.max(12, box.left + box.width / 2 - BW / 2));
    bubble = below + 190 < vh ? { left, top: below } : { left, top: Math.max(12, box.top - 190) };
    if (box.height > vh * 0.6) bubble = { left, top: Math.max(12, box.top + 40) }; // big area: bubble inside it
  }

  return (
    <div className="tour" role="dialog" aria-label="סיור במערכת">
      {box ? <div className="tour-spot" style={box} /> : <div className="tour-dim" />}
      <div className="tour-bubble" style={{ ...bubble, width: BW }} key={i}>
        <div className="tour-title">{step.title}</div>
        <p className="tour-text">{step.text}</p>
        <div className="tour-foot">
          <span className="tour-dots">{steps.map((_, k) => <i key={k} className={k === i ? 'on' : ''} />)}</span>
          <span style={{ flex: 1 }} />
          {!last && <button className="link" onClick={onClose}>דלג</button>}
          {i > 0 && <button className="btn small" onClick={() => setI(i - 1)}>הקודם</button>}
          <button className="btn primary small" onClick={next} autoFocus>{last ? 'סיום' : i === 0 ? 'יאללה' : 'הבא'}</button>
        </div>
      </div>
    </div>
  );
}

const KEY = 'gantraah.tourDone';
export const tourSeen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return true; } };
export const markTourSeen = () => { try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } };
