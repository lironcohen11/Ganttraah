/** true in the single-file demo build (Ganttraah-demo.html): no server, everything runs in the browser */
export const IS_DEMO = import.meta.env.VITE_DEMO === '1';

/** a change that postpones a task needs a reason: the server says so (409 + need_reason), the dialog asks */
/** the dates the change would give (the task and every task that would move), to show behind the question */
export interface DelayPreview { id: number; start: string; finish: string; duration: number; work_days: number }
export interface DelayInfo { task_id: number; name: string; kind: string; from: string; to: string; preview?: DelayPreview[] }
export interface DelayReason { reason: string; reason_other: string; description: string }
export type DelayAsk = (info: DelayInfo) => Promise<DelayReason | null>;
let askDelay: DelayAsk | null = null;

/** this browser tab: sent with every change, so each tab can tell its own changes from other people's */
export const CLIENT_ID = (() => { try { return crypto.randomUUID(); } catch { return Math.random().toString(36).slice(2) + Date.now().toString(36); } })();
export const setDelayAsker = (f: DelayAsk | null) => { askDelay = f; };

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (import.meta.env.VITE_DEMO === '1') { // constant per build: dropped entirely from the regular build
    const { demoRequest } = await import('./demo/backend');
    try {
      return await demoRequest<T>(method, url, body);
    } catch (e) {
      const info = (e as { info?: { need_reason?: boolean } }).info;
      if (info?.need_reason && askDelay && body && typeof body === 'object') {
        const why = await askDelay(info as DelayInfo);
        if (why) return request<T>(method, url, { ...(body as object), delay: why });
        throw Object.assign(new Error(''), { status: 409, cancelled: true });
      }
      throw e;
    }
  }
  const res = await fetch('/api' + url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json', 'x-client': CLIENT_ID } : { 'x-client': CLIENT_ID },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 409 && json?.need_reason && askDelay && body && typeof body === 'object') {
      const why = await askDelay(json as DelayInfo);
      if (why) return request<T>(method, url, { ...(body as object), delay: why });
      const err = new Error('') as Error & { status?: number; cancelled?: boolean };
      err.status = 409; err.cancelled = true; // the user cancelled: nothing changed, nothing to show
      throw err;
    }
    const err = new Error(json?.error || `שגיאה (${res.status})`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};
