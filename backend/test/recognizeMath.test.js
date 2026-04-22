const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeRecognizeMathRequest,
  mapUpstreamError,
  mapUpstreamSuccess
} = require('../recognizeMath');

test('normalizeRecognizeMathRequest rejects invalid imageDataUrl', () => {
  assert.deepEqual(normalizeRecognizeMathRequest({}), { ok: false, status: 400, error: 'BAD_IMAGE' });
  assert.deepEqual(normalizeRecognizeMathRequest({ imageDataUrl: 'x' }), { ok: false, status: 400, error: 'BAD_IMAGE' });
});

test('normalizeRecognizeMathRequest clamps timeoutMs and keeps debug', () => {
  const r = normalizeRecognizeMathRequest({ imageDataUrl: 'data:image/png;base64,AA', timeoutMs: 999999, debug: true });
  assert.equal(r.ok, true);
  assert.equal(r.debug, true);
  assert.equal(r.timeoutMs, 60000);
});

test('mapUpstreamError maps TIMEOUT', () => {
  const mapped = mapUpstreamError({ ok: false, status: 0, data: { error: 'TIMEOUT' } });
  assert.equal(mapped.error, 'TIMEOUT');
});

test('mapUpstreamError maps MODEL_NOT_INSTALLED', () => {
  const mapped = mapUpstreamError({ ok: false, status: 501, data: { detail: 'MODEL_NOT_INSTALLED' } });
  assert.equal(mapped.error, 'MODEL_NOT_INSTALLED');
});

test('mapUpstreamSuccess maps EMPTY_LATEX and RECOGNIZE_FAILED', () => {
  const empty = mapUpstreamSuccess({ ok: true, status: 200, data: { latex: '', error: 'EMPTY_LATEX' } });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'EMPTY_LATEX');

  const failed = mapUpstreamSuccess({ ok: true, status: 200, data: { latex: '', error: 'RECOGNIZE_FAILED', detail: 'X' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'RECOGNIZE_FAILED');
});

test('mapUpstreamSuccess returns ok:true with latex', () => {
  const ok = mapUpstreamSuccess({ ok: true, status: 200, data: { latex: '$x$' } });
  assert.equal(ok.ok, true);
  assert.equal(ok.latex, '$x$');
});

