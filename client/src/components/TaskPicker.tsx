import { useMemo, useRef, useState, useEffect } from 'react';
import type { Model } from '../model';

/** Searchable task selector across all projects. */
export function TaskPicker({ model, exclude, onPick, placeholder }: {
  model: Model; exclude: Set<number>; onPick: (id: number) => void; placeholder: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const list = useMemo(() => {
    const s = q.trim();
    const out: { id: number; name: string; path: string; wbs: string; color: string; project: string }[] = [];
    for (const p of model.projectList) {
      const walk = (ids: number[]) => ids.forEach((id) => {
        const t = model.task(id)!;
        if (!exclude.has(id)) {
          const path = model.path(id);
          if (!s || t.name.includes(s) || path.includes(s) || t.wbs.startsWith(s)) out.push({ id, name: t.name, path, wbs: t.wbs, color: p.color, project: p.name });
        }
        walk(t.children);
      });
      walk(p.roots);
    }
    return out.slice(0, 60);
  }, [q, model, exclude]);
  return (
    <div className="picker" ref={ref}>
      <input value={q} placeholder={placeholder} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {open && (
        <div className="picker-list">
          {list.length === 0 && <div className="picker-empty">לא נמצאו משימות</div>}
          {list.map((x) => (
            <button key={x.id} className="picker-item" onClick={() => { onPick(x.id); setQ(''); setOpen(false); }}>
              <span className="proj-chip" style={{ background: x.color }} />
              <span className="pi-wbs">{x.wbs}</span>
              <span className="pi-name">{x.name}</span>
              <span className="pi-path">{x.path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
