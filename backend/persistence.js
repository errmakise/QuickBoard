const fs = require('fs');
const path = require('path');

function parseBooleanEnvValue(raw, defaultValue) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function parseBooleanEnv(name, defaultValue) {
  return parseBooleanEnvValue(process.env[name], defaultValue);
}

function buildAuxFiles(filePath) {
  return {
    main: filePath,
    tmp: `${filePath}.tmp`,
    bak: `${filePath}.bak`
  };
}

function safeUnlinkSync(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

function safeRenameSync(from, to) {
  try {
    if (!fs.existsSync(from)) return false;
    safeUnlinkSync(to);
    fs.renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

async function safeRm(filePath) {
  try {
    await fs.promises.rm(filePath, { force: true });
  } catch {
    // ignore
  }
}

async function safeRename(from, to) {
  try {
    await safeRm(to);
    await fs.promises.rename(from, to);
    return true;
  } catch {
    return false;
  }
}

function readJsonWithBackupSync(filePath) {
  const files = buildAuxFiles(filePath);

  try {
    if (fs.existsSync(files.main)) {
      const raw = fs.readFileSync(files.main, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return { data: parsed, source: 'main' };
    }
  } catch {
    // ignore
  }

  try {
    if (fs.existsSync(files.bak)) {
      const raw = fs.readFileSync(files.bak, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return { data: parsed, source: 'bak' };
    }
  } catch {
    // ignore
  }

  return { data: null, source: 'none' };
}

function createDebouncedJsonFilePersister(options) {
  const filePath = options && options.filePath ? options.filePath : path.join(__dirname, 'roomStates.json');
  const debounceMs = typeof options?.debounceMs === 'number' && Number.isFinite(options.debounceMs)
    ? Math.max(50, Math.min(5000, options.debounceMs))
    : 600;
  const prettyJson = Boolean(options?.prettyJson);
  const debug = Boolean(options?.debug);
  const getState = typeof options?.getState === 'function' ? options.getState : (() => ({}));

  const files = buildAuxFiles(filePath);

  let saveTimer = null;
  let saveInFlight = false;
  let savePending = false;
  let saveDirty = false;
  let lastSaveRequestAt = 0;

  function logDebug(...args) {
    if (!debug) return;
    console.log('[Persist]', ...args);
  }

  function buildJson() {
    const state = getState();
    return JSON.stringify(state, null, prettyJson ? 2 : 0);
  }

  function persistSync(reason) {
    try {
      const startedAt = Date.now();
      const json = buildJson();

      fs.writeFileSync(files.tmp, json, 'utf8');

      try {
        if (fs.existsSync(files.main)) {
          safeRenameSync(files.main, files.bak);
        }
      } catch {
        // ignore
      }

      fs.renameSync(files.tmp, files.main);
      safeUnlinkSync(files.bak);

      logDebug('flush sync ok', { reason, bytes: Buffer.byteLength(json), ms: Date.now() - startedAt });
      return true;
    } catch (error) {
      logDebug('flush sync failed', { reason, error: String(error && error.message ? error.message : error) });
      return false;
    }
  }

  async function persistAsync(reason) {
    const startedAt = Date.now();
    const json = buildJson();
    const bytes = Buffer.byteLength(json);

    await fs.promises.writeFile(files.tmp, json, 'utf8');

    await safeRm(files.bak);

    try {
      await safeRename(files.main, files.bak);
    } catch {
      // ignore
    }

    try {
      await fs.promises.rename(files.tmp, files.main);
    } catch (error) {
      try {
        if (fs.existsSync(files.bak) && !fs.existsSync(files.main)) {
          await fs.promises.rename(files.bak, files.main);
        }
      } catch {
        // ignore
      }
      throw error;
    }

    await safeRm(files.bak);
    logDebug('flush async ok', { reason, bytes, ms: Date.now() - startedAt });
  }

  function requestSave(reason) {
    saveDirty = true;
    lastSaveRequestAt = Date.now();

    if (saveTimer) clearTimeout(saveTimer);

    saveTimer = setTimeout(() => {
      saveTimer = null;
      flushSave({ reason: reason || 'debounced' }).catch(() => {
        // ignore
      });
    }, debounceMs);
  }

  async function flushSave(options2) {
    const reason = options2 && options2.reason ? options2.reason : 'manual';

    if (!saveDirty) return;

    if (saveInFlight) {
      savePending = true;
      return;
    }

    saveInFlight = true;
    savePending = false;
    saveDirty = false;

    const requestAgeMs = Date.now() - lastSaveRequestAt;
    try {
      await persistAsync(reason);
    } catch (error) {
      console.error('[Server] Error saving states:', error);
      saveDirty = true;
    } finally {
      saveInFlight = false;
    }

    if (savePending || saveDirty || (Date.now() - lastSaveRequestAt) < requestAgeMs) {
      flushSave({ reason: 'pending' }).catch(() => {
        // ignore
      });
    }
  }

  function flushSyncIfDirty(reason) {
    if (!saveDirty) return false;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveDirty = false;
    return persistSync(reason || 'flush-sync');
  }

  function installBestEffortExitFlush() {
    process.on('exit', () => {
      flushSyncIfDirty('process-exit');
    });

    process.once('SIGINT', () => {
      flushSyncIfDirty('SIGINT');
      setTimeout(() => process.exit(0), 0);
    });

    process.once('SIGTERM', () => {
      flushSyncIfDirty('SIGTERM');
      setTimeout(() => process.exit(0), 0);
    });
  }

  return {
    files,
    requestSave,
    flushSave,
    flushSyncIfDirty,
    installBestEffortExitFlush
  };
}

module.exports = {
  parseBooleanEnv,
  readJsonWithBackupSync,
  createDebouncedJsonFilePersister
};

