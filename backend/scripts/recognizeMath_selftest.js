const {
  normalizeRecognizeMathRequest,
  mapUpstreamError,
  mapUpstreamSuccess
} = require('../recognizeMath');

const tests = [];
const add = (name, fn) => tests.push({ name, fn });

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

add('normalize rejects invalid imageDataUrl', () => {
  const a = normalizeRecognizeMathRequest({});
  const b = normalizeRecognizeMathRequest({ imageDataUrl: 'x' });
  if (!eq(a, { ok: false, status: 400, error: 'BAD_IMAGE' })) throw new Error('case1');
  if (!eq(b, { ok: false, status: 400, error: 'BAD_IMAGE' })) throw new Error('case2');
});

add('normalize clamps timeout and keeps debug', () => {
  const r = normalizeRecognizeMathRequest({ imageDataUrl: 'data:image/png;base64,AA', timeoutMs: 999999, debug: true });
  if (r.ok !== true) throw new Error('ok');
  if (r.timeoutMs !== 60000) throw new Error('timeout');
  if (r.debug !== true) throw new Error('debug');
});

add('mapUpstreamError TIMEOUT', () => {
  const r = mapUpstreamError({ ok: false, status: 0, data: { error: 'TIMEOUT' } });
  if (r.error !== 'TIMEOUT') throw new Error('timeout');
});

add('mapUpstreamError MODEL_NOT_INSTALLED', () => {
  const r = mapUpstreamError({ ok: false, status: 501, data: { detail: 'MODEL_NOT_INSTALLED' } });
  if (r.error !== 'MODEL_NOT_INSTALLED') throw new Error('model');
});

add('mapUpstreamSuccess maps EMPTY_LATEX and RECOGNIZE_FAILED', () => {
  const empty = mapUpstreamSuccess({ ok: true, status: 200, data: { latex: '', error: 'EMPTY_LATEX' } });
  if (empty.ok !== false || empty.error !== 'EMPTY_LATEX') throw new Error('empty');
  const failed = mapUpstreamSuccess({ ok: true, status: 200, data: { latex: '', error: 'RECOGNIZE_FAILED', detail: 'X' } });
  if (failed.ok !== false || failed.error !== 'RECOGNIZE_FAILED') throw new Error('failed');
});

add('mapUpstreamSuccess ok:true with latex', () => {
  const ok = mapUpstreamSuccess({ ok: true, status: 200, data: { latex: '$x$' } });
  if (ok.ok !== true || ok.latex !== '$x$') throw new Error('latex');
});

const startedAt = Date.now();
const results = [];
let failed = 0;

for (const t of tests) {
  const t0 = Date.now();
  try {
    t.fn();
    results.push({ name: t.name, status: 'passed', durationMs: Date.now() - t0 });
  } catch (e) {
    failed += 1;
    results.push({
      name: t.name,
      status: 'failed',
      durationMs: Date.now() - t0,
      error: e && e.message ? String(e.message) : String(e)
    });
  }
}

const report = {
  ok: failed === 0,
  suite: 'recognizeMath_selftest',
  durationMs: Date.now() - startedAt,
  total: tests.length,
  passed: tests.length - failed,
  failed,
  results
};

process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = failed === 0 ? 0 : 1;

