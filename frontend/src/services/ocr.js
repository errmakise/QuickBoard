const clampNumber = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

export const getApiBaseUrl = () => {
  const env = import.meta && import.meta.env ? import.meta.env : {};
  const envUrl = String(env.VITE_API_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (envUrl) return envUrl;
  const protocol = String(window.location?.protocol || 'http:');
  const host = String(window.location?.hostname || 'localhost');
  return `${protocol}//${host}:3000`;
};

export const recognizeMathFromImageDataUrl = async ({
  imageDataUrl,
  timeoutMs = 25000,
  debug = false,
  signal
}) => {
  const apiUrl = getApiBaseUrl();
  const controller = new AbortController();
  const timeout = clampNumber(timeoutMs, 500, 60000, 25000);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);

  const abortByCaller = () => controller.abort();
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) {
      clearTimeout(timer);
      return { ok: false, error: 'ABORTED' };
    }
    signal.addEventListener('abort', abortByCaller, { once: true });
  }

  try {
    const resp = await fetch(`${apiUrl}/api/recognize-math`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ imageDataUrl, debug, timeoutMs: timeout })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const error = data && typeof data.error === 'string' ? data.error : 'HTTP_ERROR';
      const status =
        data && typeof data.status === 'number' ? data.status : typeof resp.status === 'number' ? resp.status : 0;
      const detail = data && typeof data.detail === 'string' ? data.detail : '';
      const traceId = data && typeof data.traceId === 'string' ? data.traceId : '';
      return { ok: false, error, status, detail, traceId };
    }
    return data || { ok: false, error: 'EMPTY_RESPONSE' };
  } catch (err) {
    const name = err && typeof err.name === 'string' ? err.name : '';
    const message = err && typeof err.message === 'string' ? err.message : '';
    if (timedOut) return { ok: false, error: 'TIMEOUT' };
    if (controller.signal.aborted) return { ok: false, error: 'ABORTED' };
    return { ok: false, error: 'NETWORK_ERROR', detail: `${name || 'Error'}${message ? `:${message}` : ''}` };
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', abortByCaller);
    }
  }
};
