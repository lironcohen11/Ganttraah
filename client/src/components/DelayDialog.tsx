import { useEffect, useRef, useState } from 'react';
import { setDelayAsker, type DelayAsk, type DelayInfo, type DelayReason, type DelayPreview } from '../api';
import { DELAY_REASONS } from '../model';
import { fmtDate } from '../dates';
import { Icon } from './Icon';

/** a field that slides open and closed (height and fade) instead of jumping in and out */
function Reveal({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const r = window.setTimeout(() => setOn(true), 20); // after the closed state was drawn, so it slides open
      return () => clearTimeout(r);
    }
    setOn(false);
    const t = window.setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  return <div className={`reveal ${on ? 'on' : ''}`}><div className="reveal-in">{children}</div></div>;
}

/**
 * Postponing a task that has an original plan needs a reason. The server refuses such a change
 * without one, says which task and dates, and how the plan would look; the plan is shown that way
 * behind this dialog while it asks (a reason from the fixed list is required, "other" needs its
 * text, a description is optional). "דחה" sends the change again with the reason; "ביטול" = no change.
 */
export function DelayDialog({ onPreview }: { onPreview: (p: DelayPreview[] | null) => void }) {
  const [ask, setAsk] = useState<{ info: DelayInfo; done: (r: DelayReason | null) => void } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const [desc, setDesc] = useState('');
  const previewRef = useRef(onPreview);
  previewRef.current = onPreview;
  useEffect(() => {
    const asker: DelayAsk = (info) => new Promise((resolve) => {
      setReason(''); setOther(''); setDesc(''); setLeaving(false);
      previewRef.current(info.preview || null);
      setAsk({ info, done: resolve });
    });
    setDelayAsker(asker);
    return () => setDelayAsker(null);
  }, []);
  if (!ask) return null;
  const { info } = ask;
  const close = (r: DelayReason | null) => {
    if (leaving) return;
    if (!r) previewRef.current(null); // cancelled: the plan goes back at once (saved: it stays until the new data arrives)
    ask.done(r);
    setLeaving(true);
    window.setTimeout(() => { setAsk(null); setLeaving(false); if (r) previewRef.current(null); }, 160);
  };
  const ok = !!reason && (reason !== 'other' || !!other.trim());
  const ms = info.kind === 'milestone';
  return (
    <div className={`modal-bg delay-bg ${leaving ? 'leaving' : ''}`} onClick={() => close(null)}>
      <form className="modal delay-modal" onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (ok) close({ reason, reason_other: reason === 'other' ? other.trim() : '', description: desc.trim() }); }}>
        <h2><Icon name="calendar" size={18} /> למה {ms ? 'אבן הדרך נדחית' : 'המשימה נדחית'}?</h2>
        <p className="delay-what"><b>"{info.name}"</b>: {ms ? 'התאריך' : 'הסיום'} זז מ-<bdi>{fmtDate(info.from)}</bdi> ל-<bdi>{fmtDate(info.to)}</bdi>.</p>
        <div className="delay-reasons" role="radiogroup" aria-label="סיבת הדחייה">
          {Object.entries(DELAY_REASONS).map(([k, label]) => (
            <button type="button" key={k} role="radio" aria-checked={reason === k} className={reason === k ? 'on' : ''} onClick={() => setReason(k)}>{label}</button>
          ))}
        </div>
        <Reveal open={reason === 'other'}>
          <label className="delay-field"><span>מה הסיבה? <span className="bad">*</span></span>
            <input autoFocus value={other} maxLength={200} onChange={(e) => setOther(e.target.value)} placeholder="סיבה בכמה מילים" />
          </label>
        </Reveal>
        <Reveal open={!!reason}>
          <label className="delay-field"><span>תיאור <span className="muted small">(לא חובה)</span></span>
            <textarea rows={3} value={desc} maxLength={2000} onChange={(e) => setDesc(e.target.value)} placeholder="אפשר לפרט מה קרה ומה צפוי" autoFocus={reason !== 'other'} />
          </label>
        </Reveal>
        <div className="modal-actions">
          <button type="submit" className="btn primary" disabled={!ok}>דחה</button>
          <button type="button" className="btn" onClick={() => close(null)}>ביטול</button>
        </div>
      </form>
    </div>
  );
}
