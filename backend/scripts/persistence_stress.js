const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDebouncedJsonFilePersister, readJsonWithBackupSync } = require('../persistence');

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds())
  ].join('');
}

function ensureDirSync(dirPath) {
  if (fs.existsSync(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function writeReport(report) {
  const docDir = path.resolve(__dirname, '..', '..', '..', 'doc', 'test_reports');
  ensureDirSync(docDir);

  const stamp = nowStamp();
  const jsonPath = path.join(docDir, `quickboard_backend_persistence_${stamp}.json`);
  const mdPath = path.join(docDir, `quickboard_backend_persistence_${stamp}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  const lines = [];
  lines.push(`# QuickBoard 后端落盘压力测试报告 (${stamp})`);
  lines.push('');
  lines.push(`- 结果：${report.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`- 防抖(ms)：${report.config.debounceMs}`);
  lines.push(`- 写入文件：${report.paths.main}`);
  lines.push(`- 事件次数：${report.metrics.iterations}`);
  lines.push(`- 实际写盘次数（估算）：${report.metrics.flushCountEstimate}`);
  lines.push(`- 主文件可解析：${report.checks.mainJsonParsable ? '是' : '否'}`);
  lines.push(`- 临时文件残留：${report.checks.tmpLeftover ? '是' : '否'}`);
  lines.push(`- 备份回退可用：${report.checks.backupFallbackOk ? '是' : '否'}`);
  if (report.errors.length) {
    lines.push('');
    lines.push('## 错误');
    for (const e of report.errors) lines.push(`- ${e}`);
  }
  lines.push('');
  lines.push('## 说明');
  lines.push('- 这是“纯后端文件落盘机制”的自动化验证，不依赖前端与 Socket.IO。');
  lines.push('- 通过模拟大量状态变更，验证：防抖合并写盘、生效后 JSON 可读、tmp/bak 安全替换逻辑可回退。');
  lines.push('');
  lines.push(`- 详细数据：${path.basename(jsonPath)}`);
  lines.push('');

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8');

  return { jsonPath, mdPath };
}

async function main() {
  const startedAt = Date.now();
  const errors = [];

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quickboard-persist-'));
  const stateFile = path.join(tempDir, 'roomStates.json');

  const debounceMsRaw = String(process.env.ROOM_STATE_SAVE_DEBOUNCE_MS || '').trim();
  const debounceMs = Number.isFinite(Number(debounceMsRaw))
    ? Math.max(50, Math.min(5000, Number(debounceMsRaw)))
    : 120;

  const roomStates = {};
  let mutations = 0;
  let flushCountEstimate = 0;

  const persister = createDebouncedJsonFilePersister({
    filePath: stateFile,
    debounceMs,
    prettyJson: false,
    debug: false,
    getState: () => roomStates
  });

  const originalFlushSave = persister.flushSave;
  persister.flushSave = async (opts) => {
    flushCountEstimate += 1;
    return originalFlushSave(opts);
  };

  const iterationsRaw = String(process.env.PERSIST_STRESS_ITERATIONS || '').trim();
  const iterations = Number.isFinite(Number(iterationsRaw)) ? Math.max(1000, Number(iterationsRaw)) : 8000;

  const roomId = 'room-stress';
  roomStates[roomId] = {};

  for (let i = 0; i < iterations; i += 1) {
    const id = `obj-${i % 200}`;
    roomStates[roomId][id] = {
      id,
      data: { x: i, y: i * 2, type: 'path' },
      timestamps: { x: i, y: i }
    };
    mutations += 1;
    persister.requestSave('stress');
  }

  await sleep(debounceMs + 50);
  await persister.flushSave({ reason: 'final' });
  await sleep(50);

  let mainJsonParsable = false;
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    JSON.parse(raw);
    mainJsonParsable = true;
  } catch (e) {
    errors.push(`主文件解析失败：${String(e && e.message ? e.message : e)}`);
  }

  const tmpLeftover = fs.existsSync(`${stateFile}.tmp`);

  let backupFallbackOk = false;
  try {
    const bakPath = `${stateFile}.bak`;
    const valid = { ok: true, from: 'bak' };
    fs.writeFileSync(bakPath, JSON.stringify(valid), 'utf8');
    fs.writeFileSync(stateFile, '{broken-json', 'utf8');
    const { data, source } = readJsonWithBackupSync(stateFile);
    backupFallbackOk = Boolean(data && data.ok === true && source === 'bak');
    if (!backupFallbackOk) errors.push('备份回退读取失败：未从 .bak 成功恢复');
  } catch (e) {
    errors.push(`备份回退演练异常：${String(e && e.message ? e.message : e)}`);
  }

  const report = {
    ok: errors.length === 0 && mainJsonParsable && !tmpLeftover && backupFallbackOk,
    startedAt,
    finishedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    config: { debounceMs, iterations },
    paths: { main: stateFile, tmp: `${stateFile}.tmp`, bak: `${stateFile}.bak`, tempDir },
    metrics: { mutations, iterations, flushCountEstimate },
    checks: { mainJsonParsable, tmpLeftover, backupFallbackOk },
    errors
  };

  const out = writeReport(report);
  console.log(`[Report] ${report.ok ? 'PASS' : 'FAIL'} ${out.mdPath}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error('[Report] FAIL', e);
  process.exit(1);
});
