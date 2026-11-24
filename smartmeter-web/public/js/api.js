// Talking to the backend: JSON requests and the live event stream.
export class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && !path.endsWith('/login')) window.dispatchEvent(new Event('auth:lost'));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  }
  return data;
}

// one EventSource for the whole app; pages subscribe to event types
const handlers = new Map();
let es = null;
export function connectStream() {
  if (es) return;
  es = new EventSource('/api/stream');
  for (const type of ['data', 'status', 'event', 'alert', 'raw']) {
    es.addEventListener(type, e => {
      const d = JSON.parse(e.data);
      (handlers.get(type) || []).forEach(fn => fn(d));
    });
  }
  es.onopen = () => (handlers.get('open') || []).forEach(fn => fn());
  es.onerror = () => (handlers.get('down') || []).forEach(fn => fn());
}
export function closeStream() { es?.close(); es = null; }
/** Subscribe; returns an unsubscribe function (pages call it when they unmount). */
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type).delete(fn);
}
