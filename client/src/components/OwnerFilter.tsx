import { useEffect, useRef, useState } from 'react';
import type { Model } from '../model';
import { Icon } from './Icon';

/**
 * Filter by owner. Ticking a unit ticks every unit below it; unticking a unit also
 * unticks the units above it (they no longer cover everything).
 */
export function OwnerFilter({ model, value, onChange }: { model: Model; value: number[]; onChange: (v: number[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const tree = model.unitTree();
  const s = q.trim();
  const shown = s ? tree.filter(({ unit }) => unit.name.includes(s)) : tree;
  const valid = value.filter((id) => model.units.has(id));
  const set = new Set(valid);
  const ancestors = (id: number) => { const out: number[] = []; let x = model.units.get(id)?.parent_id ?? null; while (x != null) { out.push(x); x = model.units.get(x)?.parent_id ?? null; } return out; };
  const toggle = (id: number) => {
    const sub = model.unitSubtree(id);
    if (set.has(id)) {
      const drop = new Set([...sub, ...ancestors(id)]);
      onChange(valid.filter((x) => !drop.has(x)));
    } else {
      const next = new Set([...valid, ...sub]);
      // every unit whose units below are now all ticked becomes ticked too
      for (const a of ancestors(id)) if (model.unitSubtree(a).every((x) => x === a || next.has(x))) next.add(a);
      onChange([...next]);
    }
  };
  // the button names the top-most ticked units ("מדור פיתוח" rather than its three teams)
  const tops = valid.filter((id) => !ancestors(id).some((a) => set.has(a)));
  const all = tree.length > 0 && tree.every(({ unit }) => set.has(unit.id));
  const label = !valid.length || all ? 'כל המסגרות' : tops.length === 1 ? model.units.get(tops[0])!.name : `${tops.length} מסגרות`;
  return (
    <span className="owner-filter" ref={ref}>
      <button className={`btn ${valid.length && !all ? 'on-filter' : ''}`} onClick={() => setOpen(!open)} title="סינון לפי המסגרת האחראית">
        <Icon name="filter" size={14} /> אחראים: {label}
      </button>
      {open && (
        <div className="of-pop" onClick={(e) => e.stopPropagation()}>
          <input autoFocus placeholder="חיפוש מסגרת…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="of-actions">
            <button className="link" onClick={() => onChange(tree.map((x) => x.unit.id))}>בחירת הכול</button>
            <button className="link" onClick={() => onChange([])}>ביטול הבחירה</button>
          </div>
          <div className="of-list">
            {shown.map(({ unit, depth }) => (
              <label key={unit.id} className={`of-item k-${unit.kind}`} style={{ paddingInlineStart: 8 + depth * 18 }}>
                <input type="checkbox" checked={set.has(unit.id)} onChange={() => toggle(unit.id)} />
                <span className="of-name">{unit.name}</span>
              </label>
            ))}
          </div>
          <p className="of-help">סימון של מסגרת מסמן גם את כל המסגרות שמתחתיה. בלי סימון מוצגות המשימות של כולם.</p>
        </div>
      )}
    </span>
  );
}
