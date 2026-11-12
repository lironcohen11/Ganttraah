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
  { title: 'ברוכים הבאים ל-Ganttraah', text: 'סיור קצר של חצי דקה: מה יש כאן ואיך עובדים. אפשר לדלג בכל רגע.' },
  { target: '[data-tour="nav"]', title: 'המסכים', text: 'תכנית עבודה: לעבודה היומיומית. מפת תלויות: מה משפיע על משימה ועל מה היא משפיעה. תצוגת מנהלים: למסך הגדול בחדר הישיבות.' },
  { target: '[data-tour="add"]', title: 'יצירה', text: 'מכאן יוצרים משימה, תת-משימה או אבן דרך. משימה חדשה שייכת למסגרת שלך.' },
  { target: '.g-table', title: 'רשימת המשימות', text: 'כל שורה היא משימה. לחיצה פותחת את הפרטים בצד, ולחיצה כפולה על השם משנה אותו.' },
  { target: '.g-chart', title: 'ציר הזמן', text: 'גוררים פס כדי להזיז משימה, ומושכים את הקצה שלו כדי לשנות את המשך. כדי לקשר בין משימות, גוררים מהעיגול שבקצה הפס אל משימה אחרת.' },
  { target: '[data-tour="undo"]', title: 'טעיתם?', text: 'החיצים מבטלים ומחזירים את הפעולה האחרונה. אפשר גם עם Ctrl+Z.' },
  { target: '[data-tour="filters"]', title: 'פרויקטים ומועדפים', text: 'כאן מופיעים הפרויקטים שלך ואחוז ההתקדמות שלהם. לחיצה מציגה רק אותם. משימות שסימנת בכוכב מוצגות בכפתור "מועדפים".' },
  { target: '[data-tour="owners"]', title: 'אחראים ומקרא', text: 'בכניסה מוצגות המשימות של המסגרת שלך ושל המסגרות שמתחתיה. מכאן משנים את זה, ו"מקרא" מסביר כל סימון בגאנט.' },
  { target: '[data-tour="help"]', title: 'זהו!', text: 'אפשר לחזור לסיור בכל זמן מהכפתור הזה.' },
];

export const PRESENT_STEPS: Step[] = [
  { target: '[data-tour="m-kpis"]', title: 'המספרים החשובים', text: 'כמה מהעבודה הושלם, מתי צפוי הסיום, מה דורש תשומת לב, ומהי אבן הדרך הבאה.' },
  { target: '[data-tour="m-timeline"]', action: 'reset', title: 'ציר הזמן', text: 'כל פס הוא שלב בעבודה, וצבע הפס הוא המצב שלו: ירוק בזמן, כתום בסיכון, אדום באיחור.' },
  { target: '.mt-row.popped .mt-hit|.mt-stack', need: '[data-tour="m-timeline"]', action: 'pop', title: 'מה משפיע ועל מה', text: 'עומדים עם העכבר שנייה על פס, ולידו קופצות המשימות שמשפיעות עליו (מימין, בכתום) והמשימות שמושפעות ממנו (משמאל, בסגול). לחיצה על אחת מהן פותחת את הפרטים שלה.' },
  { target: '.mt-row.tour-hl', need: '[data-tour="m-timeline"]', action: 'open', title: 'מה יש בתוך שלב', text: 'לחיצה על שלב פותחת מתחתיו את המשימות שבתוכו. לחיצה נוספת סוגרת.' },
  { target: '[data-tour="m-tools"]', title: 'הגדרות ומסך מלא', text: 'בגלגל השיניים בוחרים מה להציג. הכפתור שלידו פותח מסך מלא לחדר הישיבות.' },
];

export const SETTINGS_STEPS: Step[] = [
  { target: '[data-tour="s-workdays"]', title: 'ימי עבודה', text: 'משך המשימות נספר בימי עבודה בלבד, א\'-ה\'. כל חג או יום מיוחד מזיז את התאריכים לבד.' },
  { target: '[data-tour="s-holidays"]', title: 'חגים ומועדים', text: 'כאן נקבע אילו חגים הם ימי חופש. רק הנהלת הענף משנה את זה.' },
  { target: '[data-tour="s-special"]', title: 'ימים מיוחדים', text: 'יום חופש או טווח של כמה ימים. יום של מסגרת משפיע רק על המשימות שלה ושל מי שמתחתיה, וכולם רואים אותו ברשימה.' },
  { target: '[data-tour="s-list"]', title: 'החגים של השנה', text: 'כל החגים והמועדים של השנה הנוכחית והבאה. הקו האדום מראה איפה אנחנו היום.' },
  { target: '[data-tour="s-org"]', title: 'מבנה ארגוני והרשאות', text: 'בלשונית הזו הנהלת הענף עורכת את המסגרות, מעבירה צוותים בגרירה, וקובעת לכל מסגרת אם היא צופה או עורכת. ללשונית יש סיור משלה: פותחים אותה ולוחצים שוב על "סיור".' },
];

export const ORG_STEPS: Step[] = [
  { target: '.org-tree.edit', title: 'המבנה הארגוני', text: 'כל המסגרות של הענף, כמו בדף הכניסה. כל שינוי כאן מופיע מיד בתכנית העבודה, בסינונים ובבחירת האחראי.' },
  { target: '.ou-card.section .ou-top', title: 'שינוי שם ומחיקה', text: 'העיפרון משנה את שם המסגרת, והפח מוחק אותה. אי אפשר למחוק מסגרת שיש באחריותה משימות פתוחות: קודם מעבירים אותן למסגרת אחרת. משימות שהושלמו עוברות למסגרת שמעליה.' },
  { target: '.ou-card.section .ou-meta', title: 'משימות והרשאה', text: 'כמה משימות פתוחות יש באחריות המסגרת. לחיצה על המספר מציגה אותן, ולחיצה על משימה פותחת אותה בתכנית העבודה. בתיבה בוחרים הרשאה: "צופה" עורכת רק את המשימות שלה ושל מי שמתחתיה, ו"עורך" עורכת גם משימות של אחרים.' },
  { target: '.ou-card.team', title: 'העברה בגרירה', text: 'גוררים צוות מהידית שליד השם ומשחררים על מדור אחר, והצוות עובר אליו עם כל המשימות שלו.' },
  { target: '.ou-card.section', action: 'org-add', title: 'הוספת מסגרת', text: 'כשהעכבר על מסגרת, מתחתיה מופיע הכפתור "+ צוות" (או "+ מדור" בהנהלת הענף), שמוסיף מסגרת חדשה תחתיה.' },
  { target: '[data-tour="s-pw"]', title: 'סיסמת הנהלת הענף', text: 'רק הכניסה כהנהלת הענף מוגנת בסיסמה. כאן מחליפים אותה: מזינים פעמיים את הסיסמה החדשה.' },
  { target: '.perm-note', title: 'מה כל הרשאה אומרת', text: 'ההסבר המלא נמצא כאן תמיד. ההגדרות והפרויקטים נשארים בידי הנהלת הענף בכל מקרה.' },
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
    document.body.classList.toggle('tour-org-add', step.action === 'org-add');
    if (step.action) act(step.action);
    // a step that demonstrates something (cards popping out, a phase opening) is measured once,
    // after the demonstration has settled, so the spotlight glides there in one move
    const demo = step.action === 'pop' || step.action === 'open';
    if (!demo) measure();
    const t1 = window.setTimeout(measure, demo ? 720 : 120), t2 = window.setTimeout(measure, demo ? 900 : 450);
    window.addEventListener('resize', measure);
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener('resize', measure); };
  }, [step]);
  useEffect(() => () => { act('reset'); document.body.classList.remove('tour-org-add'); }, []); // leave the page as it was

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
          <button className="btn primary small" onClick={next} autoFocus>{last ? 'סיום' : 'הבא'}</button>
        </div>
      </div>
    </div>
  );
}

const KEY = 'gantraah.tourDone';
export const tourSeen = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return true; } };
export const markTourSeen = () => { try { localStorage.setItem(KEY, '1'); } catch { /* ignore */ } };
