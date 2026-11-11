/** true in the single-file demo build (Gantraah-demo.html): no server, everything runs in the browser */
export const IS_DEMO = import.meta.env.VITE_DEMO === '1';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  if (import.meta.env.VITE_DEMO === '1') { // constant per build: dropped entirely from the regular build
    const { demoRequest } = await import('./demo/backend');
    return demoRequest<T>(method, url, body);
  }
  const res = await fetch('/api' + url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
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
