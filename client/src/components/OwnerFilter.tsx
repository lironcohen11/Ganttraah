import { useEffect, useRef, useState } from 'react';
import type { Model } from '../model';
import { Icon } from './Icon';

/**
 * Filter by owner: pick one or more units (e.g. "צוות צד שרת" and "צוות אפיון").
 * Choosing a section also shows the tasks of the teams under it.
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
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const valid = value.filter((id) => model.units.has(id));
  return (
    <span className="owner-filter" ref={ref}>
      <button className={`fchip ${valid.length ? 'on' : ''}`} onClick={() => setOpen(!open)}>
        <Icon name="filter" size={13} /> אחראים{valid.length ? ` (${valid.length})` : ''}
      </button>
      {valid.map((id) => (
        <span key={id} className="fchip on owner-chip">
          {model.units.get(id)!.name}
          <button className="fchip-edit" onClick={() => toggle(id)} aria-label="הסרה"><Icon name="x" size={11} /></button>
        </span>
      ))}
      {valid.length > 0 && <button className="link small" onClick={() => onChange([])}>ניקוי</button>}
      {open && (
        <div className="of-pop" onClick={(e) => e.stopPropagation()}>
          <input autoFocus placeholder="חיפוש מסגרת…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="of-list">
            {shown.map(({ unit, depth }) => (
              <label key={unit.id} className={`of-item k-${unit.kind}`} style={{ paddingInlineStart: 8 + depth * 18 }}>
                <input type="checkbox" checked={value.includes(unit.id)} onChange={() => toggle(unit.id)} />
                <span className="of-name">{unit.name}</span>
              </label>
            ))}
          </div>
          <p className="of-help">בחירה במדור מציגה גם את המשימות של הצוותים שלו. משימות שמכילות משימה שנבחרה מוצגות באפור, כדי לשמור על ההקשר.</p>
        </div>
      )}
    </span>
  );
}
