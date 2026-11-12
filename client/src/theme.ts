// Light / dark / like the device. The choice is kept in this browser; "device" follows the
// operating system's setting, also when it changes while the page is open.
export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'gantraah.theme';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export const getThemePref = (): ThemePref => {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch { return 'system'; }
};
const resolve = (p: ThemePref) => (p === 'system' ? (mq?.matches ? 'dark' : 'light') : p);

function apply(p: ThemePref, fade: boolean) {
  const theme = resolve(p);
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  const set = () => { root.dataset.theme = theme; };
  // a quick cross-fade between the two looks (where the browser supports it)
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (fade && doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(set);
  else set();
}

export function setThemePref(p: ThemePref) {
  try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
  apply(p, true);
}

/** call once, before the first render: no flash of the wrong theme */
export function initTheme() {
  apply(getThemePref(), false);
  mq?.addEventListener('change', () => { if (getThemePref() === 'system') apply('system', true); });
}
