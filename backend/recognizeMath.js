const clampNumber = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

const createTraceId = () => `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

const normalizeRecognizeMathRequest = (body) => {
  const imageDataUrl = body && typeof body.imageDataUrl === 'string' ? body.imageDataUrl : '';
  if (!imageDataUrl || !imageDataUrl.startsWith('data:image/')) {
    return { ok: false, status: 400, error: 'BAD_IMAGE' };
  }
  const debug = body && body.debug === true;
  const timeoutMs = clampNumber(body && body.timeoutMs, 2000, 60000, 25000);
  return { ok: true, imageDataUrl, debug, timeoutMs };
};

const mapUpstreamError = (upstream) => {
  const upstreamError = upstream.data && typeof upstream.data.error === 'string' ? upstream.data.error : '';
  const detail =
    (upstream.data && typeof upstream.data.detail === 'string' ? upstream.data.detail : '') ||
    (upstream.data && typeof upstream.data.error === 'string' ? upstream.data.error : '') ||
    '';

  if (upstreamError === 'TIMEOUT' || detail === 'TIMEOUT') {
    return { ok: false, error: 'TIMEOUT', status: upstream.status || 0, detail: 'OCR_TIMEOUT' };
  }

  if ((upstream.status || 0) === 400 && detail === 'BAD_IMAGE') {
    return { ok: false, error: 'BAD_IMAGE', status: upstream.status || 0, detail };
  }

  if ((upstream.status || 0) === 501 && detail === 'MODEL_NOT_INSTALLED') {
    return { ok: false, error: 'MODEL_NOT_INSTALLED', status: upstream.status || 0, detail };
  }

  return { ok: false, error: 'UPSTREAM_ERROR', status: upstream.status || 0, detail };
};

const mapUpstreamSuccess = (upstream) => {
  const debug =
    upstream.data &&
    upstream.data.debug &&
    typeof upstream.data.debug.processedImageDataUrl === 'string'
      ? { processedImageDataUrl: upstream.data.debug.processedImageDataUrl }
      : null;

  if (upstream.data && typeof upstream.data.error === 'string' && upstream.data.error) {
    const detail = upstream.data && typeof upstream.data.detail === 'string' ? upstream.data.detail : '';
    if (upstream.data.error === 'EMPTY_LATEX') {
      return debug
        ? { ok: false, error: 'EMPTY_LATEX', status: upstream.status || 0, detail, debug }
        : { ok: false, error: 'EMPTY_LATEX', status: upstream.status || 0, detail };
    }
    if (upstream.data.error === 'RECOGNIZE_FAILED') {
      return debug
        ? { ok: false, error: 'RECOGNIZE_FAILED', status: upstream.status || 0, detail: detail || upstream.data.error, debug }
        : { ok: false, error: 'RECOGNIZE_FAILED', status: upstream.status || 0, detail: detail || upstream.data.error };
    }
    return debug
      ? { ok: false, error: 'UPSTREAM_ERROR', status: upstream.status || 0, detail: detail || upstream.data.error, debug }
      : { ok: false, error: 'UPSTREAM_ERROR', status: upstream.status || 0, detail: detail || upstream.data.error };
  }

  const latex =
    (upstream.data && (typeof upstream.data.latex === 'string' ? upstream.data.latex : '')) ||
    (upstream.data && (typeof upstream.data.result === 'string' ? upstream.data.result : '')) ||
    '';
  if (!latex) {
    return debug
      ? { ok: false, error: 'EMPTY_LATEX', status: upstream.status || 0, debug }
      : { ok: false, error: 'EMPTY_LATEX', status: upstream.status || 0 };
  }
  return debug ? { ok: true, latex, debug } : { ok: true, latex };
};

const createRecognizeMathHandler = ({ postJson, getUpstreamUrl }) => {
  return async (req, res) => {
    const traceId = createTraceId();
    const normalized = normalizeRecognizeMathRequest(req && req.body);
    if (!normalized.ok) {
      res.status(normalized.status).json({ ok: false, error: normalized.error, traceId });
      return;
    }

    const upstreamUrl = getUpstreamUrl();
    try {
      const upstream = await postJson(upstreamUrl, { imageDataUrl: normalized.imageDataUrl, debug: normalized.debug }, normalized.timeoutMs);
      const mapped = upstream.ok ? mapUpstreamSuccess(upstream) : mapUpstreamError(upstream);
      res.status(mapped.ok ? 200 : 200).json({ ...mapped, traceId });
    } catch (err) {
      const name = err && typeof err.name === 'string' ? err.name : '';
      const message = err && typeof err.message === 'string' ? err.message : '';
      res.status(200).json({
        ok: false,
        error: 'INTERNAL_ERROR',
        detail: `${name || 'Error'}${message ? `:${message}` : ''}`,
        traceId
      });
    }
  };
};

module.exports = {
  clampNumber,
  createTraceId,
  normalizeRecognizeMathRequest,
  mapUpstreamError,
  mapUpstreamSuccess,
  createRecognizeMathHandler
};
