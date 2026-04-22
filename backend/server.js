const express = require('express');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

const SYNC_MODE = String(process.env.SYNC_MODE || '').trim().toLowerCase();
const SYNC_MODE_NAIVE = SYNC_MODE === 'naive';
const BENCH_PASS_THROUGH = String(process.env.BENCH_PASS_THROUGH || '').trim().toLowerCase();
const BENCH_PASS_THROUGH_ENABLED = BENCH_PASS_THROUGH === '1' || BENCH_PASS_THROUGH === 'true' || BENCH_PASS_THROUGH === 'yes';

// 服务端“纪元”（epoch）：用于区分“同一个房间版本号体系”的生命周期。
// 给外行看的解释：
// - 我们的 serverVersion 是内存里递增的计数器，服务端一旦重启，它会从 0 重新开始；
// - 如果客户端只用“最大值”去记 serverVersion，遇到服务端重启就会出现“版本号回退后不再更新”的问题；
// - 因此服务端在启动时生成一个 serverEpoch，并在 sync-state / sync-delta / draw-event 里带上：
//   - epoch 相同：版本号单调递增，客户端可以安全地做“取最大值”；
//   - epoch 变化：说明服务端经历了重启/进程重建，客户端应当把 clientVersion 归零后重新对齐。
const SERVER_EPOCH = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

// --- 简单的内存存储 (用于演示 CRDT 状态持久化) ---
// 结构: { roomId: { objectId: { id, data, timestamps } } }
const roomStates = {};

// --- 房间版本与增量日志（用于“断线重连后只补缺失变更”）---
//
// 给外行看的解释：
// - 之前的同步模型是：join-room 时服务端下发一份全量快照（sync-state），之后只靠 draw-event 增量广播；
// - 但如果用户断线了一段时间（或后端重启/网络抖动），客户端会漏掉这段时间的 draw-event；
// - 如果每次重连都发“全量快照”，房间大了会很慢，也浪费带宽；
// - 解决办法：服务端维护一个单调递增的“房间版本号”（roomVersion），并把每次被服务端裁决接受的增量记录到日志里；
// - 客户端重连时把“我上次同步到的版本号”带上来，服务端就能只回传缺失的增量（sync-delta）。
//
// 重要约束（和 CRDT/LWW 的关系）：
// - 版本号不参与冲突解决；冲突解决仍由 LWW 时间戳裁决；
// - 版本号只用于“网络补包”——告诉服务端：从哪个点开始把增量补给我。
//
// 结构:
// - roomVersions[roomId] = number（从 0 开始递增）
// - roomDeltaLogs[roomId] = [{ v, id, data, timestamps }]（按 v 递增）
const roomVersions = {};
const roomDeltaLogs = {};
const deltaLogLimitRaw = String(process.env.ROOM_DELTA_LOG_LIMIT || '').trim();
const ROOM_DELTA_LOG_LIMIT = Number.isFinite(Number(deltaLogLimitRaw))
  ? Math.max(100, Math.min(50000, Number(deltaLogLimitRaw)))
  : 5000;

// --- 定期快照对齐（Periodic Snapshot Sync）---
//
// 给外行看的解释：
// - 我们的同步主要依赖“增量事件 draw-event”，它效率高，但对网络质量更敏感：
//   - 浏览器后台挂起/弱网/偶发丢包时，客户端可能漏掉部分增量；
//   - 只要漏掉的是“删除”类事件，本地就可能残留一个不该存在的对象；
// - 因此我们增加一个工程级兜底：服务端按固定周期向房间广播一次“权威快照”。
//
// 设计原则：
// - 快照不参与 CRDT 冲突裁决（裁决仍是 LWW 时间戳）；
// - 快照的目的只是让客户端“定期补齐漏掉的变化”，尤其是漏掉的删除 tombstone；
// - 为避免无谓带宽浪费：只有当房间版本号在上次快照后发生变化，才会广播快照。
//
// 配置方式（环境变量）：
// - ROOM_SNAPSHOT_INTERVAL_SECONDS：快照广播周期（秒）。
//   - 默认 30 秒；
//   - 设为 0/false/no/off 关闭。
const snapshotIntervalRaw = String(process.env.ROOM_SNAPSHOT_INTERVAL_SECONDS || '').trim().toLowerCase();
const snapshotIntervalSeconds = !snapshotIntervalRaw
  ? 30
  : (['0', 'false', 'no', 'off'].includes(snapshotIntervalRaw)
      ? 0
      : (Number.isFinite(Number(snapshotIntervalRaw)) ? Math.max(1, Number(snapshotIntervalRaw)) : 30));
const ROOM_SNAPSHOT_INTERVAL_MS = snapshotIntervalSeconds * 1000;

// roomLastSnapshotVersion[roomId] = number
// - 记录这个房间上次广播快照时的 serverVersion；
// - 用于判断“房间在这段时间里是否有变化”，避免重复发同一份快照。
const roomLastSnapshotVersion = {};

// 结构: { roomId: { resourceId: { ownerId, ownerName, expiresAt } } }
const roomLocks = {};

// --- 房间在线成员（用于“成员列表/昵称展示”）---
//
// 设计目标（给外行看的解释）：
// - 白板是“房间”概念：同一房间的人能互相看到对方的光标/操作；
// - 仅靠 cursor-move（鼠标移动）才能知道昵称会有两个问题：
//   1) 刚进房间不动鼠标时，看不到成员昵称；
//   2) 昵称修改后，如果用户不移动鼠标，别人也不会立刻更新；
// - 所以我们维护一个“房间 → 在线用户表”的轻量内存索引，用来：
//   - join-room 后给新加入者下发一次快照（room-users）；
//   - user-joined / user-left / user-name 事件带昵称，UI 更友好。
//
// 注意：
// - 这是“展示层”数据，不参与 CRDT；丢了也不影响画面一致性；
// - 这是内存态，服务端重启会丢失，但用户会重连并重新 join-room 自动恢复。
//
// 结构: { roomId: { socketId: userName } }
const roomUsers = {};

// --- 房间空闲计时（用于 TTL 自动销毁）---
//
// roomEmptySince[roomId] = timestamp
// - 当一个房间“变为空房间”时，记录开始为空的时间；
// - 只要房间里再次有人加入，就会清掉该记录；
// - 定时任务会检查 now - emptySince >= TTL 的房间，并清理其服务端状态。
//
// 为什么要用“空闲计时”而不是“最后活跃时间”？
// - “最后活跃时间”更偏业务（用户是否在画、是否在动鼠标），需要大量事件来维护；
// - 本项目的目标是先解决“房间没人但状态一直存在”的资源问题；
// - 因此我们选择更简单可靠的判定：房间连接数 == 0。
const roomEmptySince = {};
// ROOM_TTL_MINUTES 支持两类输入：
// - 数字（分钟）：例如 15 / 60
// - “关闭开关”：0 / false / no / off（大小写不敏感）
// 如果没配置或配置非法，则使用默认值 60 分钟。
const roomTtlRaw = String(process.env.ROOM_TTL_MINUTES || '').trim().toLowerCase();
const roomTtlMinutes = !roomTtlRaw
  ? 60
  : (['0', 'false', 'no', 'off'].includes(roomTtlRaw)
      ? 0
      : (Number.isFinite(Number(roomTtlRaw)) ? Math.max(0, Number(roomTtlRaw)) : 60));
const ROOM_TTL_MS = roomTtlMinutes * 60 * 1000;
// ROOM_CLEANUP_INTERVAL_SECONDS 是“扫房间”的周期（秒），默认 60，最小 5。
// 这个值越小，清理越及时，但会更频繁地遍历 roomStates/roomEmptySince。
const roomCleanupRaw = String(process.env.ROOM_CLEANUP_INTERVAL_SECONDS || '').trim();
const roomCleanupSeconds = !roomCleanupRaw
  ? 60
  : (Number.isFinite(Number(roomCleanupRaw)) ? Math.max(5, Number(roomCleanupRaw)) : 60);
const ROOM_CLEANUP_INTERVAL_MS = roomCleanupSeconds * 1000;

// --- 状态持久化（roomStates.json）---
//
// 给外行看的解释：
// - 我们在内存里维护 roomStates（每个房间的 CRDT/LWW 状态）；
// - 只有放在内存里有两个问题：
//   1) 服务端重启后数据会丢：新加入者就拿不到历史内容；
//   2) 进程异常退出时也会丢最后一段变更；
// - 因此我们把 roomStates 持久化到一个 JSON 文件（roomStates.json）。
//
// 但“怎么写这个文件”很关键：
// - 如果每次 draw-event 都同步写文件（writeFileSync），会阻塞 Node 事件循环；
//   画得越快、房间越大，就越容易出现延迟抖动/卡顿。
// - 如果在写文件过程中进程被杀，可能留下半截 JSON，导致下次启动解析失败。
//
// 本次改造目标：
// - 防抖批量落盘：把 N 次变更合并成 1 次写盘；
// - 安全替换：先写临时文件，再替换主文件，降低写坏风险；
// - 并发保护：同一时间只允许一个写入任务。
const STATE_FILE = path.join(__dirname, 'roomStates.json');
const STATE_FILE_TMP = `${STATE_FILE}.tmp`;
const STATE_FILE_BAK = `${STATE_FILE}.bak`;

function parseBooleanEnv(name, defaultValue) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return defaultValue;
}

const ROOM_STATE_PERSIST_DEBUG = parseBooleanEnv('ROOM_STATE_PERSIST_DEBUG', false);
const DRAW_EVENT_DEBUG = parseBooleanEnv('DRAW_EVENT_DEBUG', false);

const stateSaveDebounceRaw = String(process.env.ROOM_STATE_SAVE_DEBOUNCE_MS || '').trim();
const ROOM_STATE_SAVE_DEBOUNCE_MS = Number.isFinite(Number(stateSaveDebounceRaw))
  ? Math.max(50, Math.min(5000, Number(stateSaveDebounceRaw)))
  : 600;

const ROOM_STATE_PRETTY_JSON = parseBooleanEnv('ROOM_STATE_PRETTY_JSON', false);

function persistDebugLog(...args) {
  if (!ROOM_STATE_PERSIST_DEBUG) return;
  console.log('[Persist]', ...args);
}

let saveTimer = null;
let saveInFlight = false;
let savePending = false;
let saveDirty = false;
let lastSaveRequestAt = 0;

function buildRoomStatesJson() {
  return JSON.stringify(roomStates, null, ROOM_STATE_PRETTY_JSON ? 2 : 0);
}

function persistRoomStatesToDiskSync(reason) {
  try {
    const startedAt = Date.now();
    const json = buildRoomStatesJson();

    fs.writeFileSync(STATE_FILE_TMP, json, 'utf8');

    try {
      if (fs.existsSync(STATE_FILE)) {
        try {
          if (fs.existsSync(STATE_FILE_BAK)) fs.unlinkSync(STATE_FILE_BAK);
        } catch {
          // ignore
        }
        fs.renameSync(STATE_FILE, STATE_FILE_BAK);
      }
    } catch {
      // ignore
    }

    fs.renameSync(STATE_FILE_TMP, STATE_FILE);

    try {
      if (fs.existsSync(STATE_FILE_BAK)) fs.unlinkSync(STATE_FILE_BAK);
    } catch {
      // ignore
    }

    persistDebugLog('flush sync ok', { reason, bytes: Buffer.byteLength(json), ms: Date.now() - startedAt });
    return true;
  } catch (error) {
    persistDebugLog('flush sync failed', { reason, error: String(error && error.message ? error.message : error) });
    return false;
  }
}

async function persistRoomStatesToDiskAsync(reason) {
  const startedAt = Date.now();
  const json = buildRoomStatesJson();
  const bytes = Buffer.byteLength(json);

  await fs.promises.writeFile(STATE_FILE_TMP, json, 'utf8');

  try {
    await fs.promises.rm(STATE_FILE_BAK, { force: true });
  } catch {
    // ignore
  }

  try {
    await fs.promises.rename(STATE_FILE, STATE_FILE_BAK);
  } catch {
    // ignore (file may not exist on first run)
  }

  try {
    await fs.promises.rename(STATE_FILE_TMP, STATE_FILE);
  } catch (error) {
    try {
      if (fs.existsSync(STATE_FILE_BAK) && !fs.existsSync(STATE_FILE)) {
        await fs.promises.rename(STATE_FILE_BAK, STATE_FILE);
      }
    } catch {
      // ignore
    }
    throw error;
  }

  try {
    await fs.promises.rm(STATE_FILE_BAK, { force: true });
  } catch {
    // ignore
  }

  persistDebugLog('flush async ok', { reason, bytes, ms: Date.now() - startedAt });
}

/**
 * 请求一次“未来的落盘”（防抖）。
 *
 * 直觉理解：
 * - 用户画画时会触发大量 draw-event；
 * - 我们不希望每个事件都写硬盘，而是“最后一次变更过去一小段时间”才写一次；
 * - 这样既能持久化，又能大幅降低 IO 与卡顿。
 */
function requestSaveStates(reason) {
  saveDirty = true;
  lastSaveRequestAt = Date.now();

  if (saveTimer) clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    saveTimer = null;
    flushSaveStates({ reason: reason || 'debounced' }).catch(() => {
      // ignore (errors are logged in flushSaveStates)
    });
  }, ROOM_STATE_SAVE_DEBOUNCE_MS);
}

/**
 * 立即执行一次落盘（如果有脏数据）。
 *
 * 注意：
 * - 这是异步写入，不会像 writeFileSync 一样卡住事件循环；
 * - 但 JSON.stringify 本身是同步的 CPU 操作，所以我们用“减少次数”的方式控制成本。
 */
async function flushSaveStates(options) {
  const reason = options && options.reason ? options.reason : 'manual';

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
    await persistRoomStatesToDiskAsync(reason);
  } catch (error) {
    console.error('[Server] Error saving states:', error);
    saveDirty = true;
  } finally {
    saveInFlight = false;
  }

  if (savePending || saveDirty || (Date.now() - lastSaveRequestAt) < requestAgeMs) {
    flushSaveStates({ reason: 'pending' }).catch(() => {
      // ignore
    });
  }
}

/**
 * 判断一个对象数据是否是“Ghost Brush”临时预览线（不应进入持久化/初次同步/CRDT 状态）。
 *
 * 背景：
 * - 前端为了实现“实时绘制预览”，会用 fabric.Polyline 按点流绘制一条灰色临时线；
 * - 这条线只用于视觉反馈，最终应由 fabric.Path（path:created）落地并同步；
 * - 若 Ghost 线被误写入 roomStates.json，会出现“刷新后幽灵线回流 / 撤销后线条又慢慢长出来”。
 *
 * 约束：
 * - 这里用“样式特征 + 类型”做粗过滤（避免依赖前端私有字段）；
 * - 即使误判，最坏情况只是不保存/不同步某些 polyline；但本项目正式落笔是 Path，不受影响。
 */
function isGhostPolylineData(data) {
  if (!data || data._deleted) return false;
  const type = typeof data.type === 'string' ? data.type.toLowerCase() : '';
  if (type !== 'polyline') return false;
  return (
    data.stroke === 'rgba(50, 50, 50, 0.8)' &&
    data.strokeWidth === 4 &&
    data.fill === 'transparent' &&
    Array.isArray(data.points)
  );
}

function getRoomVersion(roomId) {
  if (!roomId) return 0;
  const v = roomVersions[roomId];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

function bumpRoomVersion(roomId) {
  const next = getRoomVersion(roomId) + 1;
  roomVersions[roomId] = next;
  return next;
}

function appendRoomDelta(roomId, delta) {
  if (!roomId) return;
  if (!roomDeltaLogs[roomId]) roomDeltaLogs[roomId] = [];
  roomDeltaLogs[roomId].push(delta);
  if (roomDeltaLogs[roomId].length > ROOM_DELTA_LOG_LIMIT) {
    roomDeltaLogs[roomId] = roomDeltaLogs[roomId].slice(-ROOM_DELTA_LOG_LIMIT);
  }
}

function getDeltaMinVersion(roomId) {
  const log = roomDeltaLogs[roomId];
  if (!Array.isArray(log) || log.length === 0) return null;
  const first = log[0];
  return first && typeof first.v === 'number' ? first.v : null;
}

/**
 * 构造某个房间的“权威快照 payload”。
 *
 * 注意：这里把“存活对象”和“删除墓碑（tombstone）”拆开：
 * - objects：只包含当前存活对象（方便前端直接渲染）
 * - tombstones：只包含 { _deleted: true } 的最小信息（用于让漏掉删除事件的客户端也能收敛）
 *
 * 为什么 tombstone 必须在快照里出现？
 * - 如果只发存活对象，那客户端即使拿到了最新快照，也无法知道“哪些对象已经被删除”；
 * - 一旦客户端漏掉了某次删除 draw-event，它就会一直保留该对象（因为快照里也不会出现它）；
 * - 发 tombstone 能让客户端把该对象标记为已删除，从而真正实现“最终一致”。
 */
function buildRoomSnapshotPayload(roomId) {
  const room = roomStates[roomId];
  const objects = [];
  const tombstones = [];

  if (room) {
    for (const item of Object.values(room)) {
      if (!item || !item.data) continue;
      if (isGhostPolylineData(item.data)) continue;

      if (item.data._deleted) {
        const tsRaw = item.timestamps && item.timestamps._deleted;
        const ts =
          typeof tsRaw === 'number' && Number.isFinite(tsRaw) && tsRaw >= 0 ? tsRaw : 0;
        tombstones.push({
          id: item.id,
          data: { _deleted: true },
          timestamps: { _deleted: ts }
        });
        continue;
      }

      objects.push(item);
    }
  }

  return {
    roomId,
    serverEpoch: SERVER_EPOCH,
    serverVersion: getRoomVersion(roomId),
    objects,
    tombstones
  };
}

function sendFullSync(socket, roomId) {
  socket.emit('sync-state', buildRoomSnapshotPayload(roomId));
}

function sendDeltaSync(socket, roomId, fromVersion) {
  const toVersion = getRoomVersion(roomId);
  const log = roomDeltaLogs[roomId];
  if (!Array.isArray(log) || log.length === 0) {
    sendFullSync(socket, roomId);
    return;
  }
  const minV = getDeltaMinVersion(roomId);
  if (typeof minV !== 'number') {
    sendFullSync(socket, roomId);
    return;
  }
  if (fromVersion < minV - 1) {
    // 客户端太旧了：服务端已经把那部分增量日志丢弃，只能发全量快照兜底。
    sendFullSync(socket, roomId);
    return;
  }
  const deltas = log.filter((d) => d && typeof d.v === 'number' && d.v > fromVersion);
  socket.emit('sync-delta', {
    roomId,
    serverEpoch: SERVER_EPOCH,
    fromVersion,
    toVersion,
    deltas
  });
}

// [关键修复] 从文件加载状态
function loadStates() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      let data = fs.readFileSync(STATE_FILE, 'utf8');
      let loadedStates = null;
      try {
        loadedStates = JSON.parse(data);
      } catch (error) {
        console.error('[Server] Error parsing roomStates.json, try fallback .bak:', error);
        try {
          if (fs.existsSync(STATE_FILE_BAK)) {
            data = fs.readFileSync(STATE_FILE_BAK, 'utf8');
            loadedStates = JSON.parse(data);
            console.log('[Server] Loaded room states from .bak');
          }
        } catch (bakError) {
          console.error('[Server] Error loading fallback .bak:', bakError);
          loadedStates = null;
        }
      }

      if (!loadedStates || typeof loadedStates !== 'object') {
        console.error('[Server] Loaded room states is invalid, skip restore.');
        return;
      }

      Object.assign(roomStates, loadedStates);
      console.log('[Server] Loaded room states from file');

      // 启动时顺带清理历史遗留的 Ghost 预览线（避免新加入者初次同步加载到幽灵对象）
      // 这里直接物理删除是为了“重启后立刻彻底干净”，而不是依赖 tombstone。
      let mutated = false;
      for (const [roomId, room] of Object.entries(roomStates)) {
        for (const [objectId, item] of Object.entries(room || {})) {
          if (item && item.data && isGhostPolylineData(item.data)) {
            delete roomStates[roomId][objectId];
            mutated = true;
          }
        }
        if (roomStates[roomId] && Object.keys(roomStates[roomId]).length === 0) {
          delete roomStates[roomId];
          mutated = true;
        }
      }
      if (mutated) {
        persistRoomStatesToDiskSync('startup-cleanup');
      }

      const now = Date.now();
      for (const roomId of Object.keys(roomStates)) {
        roomEmptySince[roomId] = now;
        // 服务端重启后，增量日志从空开始：客户端如带 clientVersion，会走全量兜底同步。
        roomVersions[roomId] = 0;
        roomDeltaLogs[roomId] = [];
      }
      for (const roomId of Object.keys(roomEmptySince)) {
        if (!roomStates[roomId]) delete roomEmptySince[roomId];
      }
    }
  } catch (error) {
    console.error('[Server] Error loading states:', error);
  }
}

// [关键修复] 启动时加载状态
loadStates();

process.on('exit', () => {
  if (saveDirty) {
    persistRoomStatesToDiskSync('process-exit');
  }
});

process.once('SIGINT', () => {
  if (saveTimer) clearTimeout(saveTimer);
  persistRoomStatesToDiskSync('SIGINT');
  setTimeout(() => process.exit(0), 0);
});

process.once('SIGTERM', () => {
  if (saveTimer) clearTimeout(saveTimer);
  persistRoomStatesToDiskSync('SIGTERM');
  setTimeout(() => process.exit(0), 0);
});

function cleanupExpiredLocks(roomId) {
  if (!roomId || !roomLocks[roomId]) return false;

  const now = Date.now();
  let changed = false;

  for (const [resourceId, lock] of Object.entries(roomLocks[roomId])) {
    if (!lock || typeof lock.expiresAt !== 'number' || lock.expiresAt <= now) {
      delete roomLocks[roomId][resourceId];
      changed = true;
    }
  }

  if (Object.keys(roomLocks[roomId]).length === 0) {
    delete roomLocks[roomId];
  }

  return changed;
}

function getRoomLockSnapshot(roomId) {
  const locks = roomLocks[roomId] || {};
  return Object.entries(locks).map(([resourceId, lock]) => ({
    resourceId,
    ownerId: lock.ownerId,
    ownerName: lock.ownerName || '',
    expiresAt: lock.expiresAt
  }));
}

function broadcastRoomLocks(io, roomId) {
  io.to(roomId).emit('lock-state', {
    roomId,
    locks: getRoomLockSnapshot(roomId),
    serverNow: Date.now()
  });
}

function getRoomUsersSnapshot(roomId) {
  const users = roomUsers[roomId] || {};
  return Object.entries(users).map(([userId, userName]) => ({
    userId,
    userName: userName || ''
  }));
}

function broadcastRoomUsers(io, roomId) {
  // 给外行看的解释：
  // - “room-users”是一个“当前在线成员快照”，它并不是 CRDT 数据（不会影响白板内容）；
  // - 它只用于 UI：让用户立刻看到“房间里现在有哪些人、昵称是什么”；
  // - 我们选择“广播快照”而不是“只发增量”，原因是：
  //   1) 逻辑最简单，外行也容易理解；
  //   2) 房间人数通常不多（毕设 5–10 人），快照体积可接受；
  //   3) 可以避免因为偶发丢包/事件顺序不同导致的成员列表不一致。
  io.to(roomId).emit('room-users', { roomId, users: getRoomUsersSnapshot(roomId) });
}

function getRoomConnCount(io, roomId) {
  const room = io && io.sockets && io.sockets.adapter && io.sockets.adapter.rooms
    ? io.sockets.adapter.rooms.get(roomId)
    : null;
  return room && typeof room.size === 'number' ? room.size : 0;
}

function markRoomNonEmpty(roomId) {
  if (!roomId) return;
  if (roomEmptySince[roomId]) delete roomEmptySince[roomId];
}

function markRoomEmptyIfNeeded(io, roomId) {
  if (!roomId) return;
  if (getRoomConnCount(io, roomId) > 0) {
    markRoomNonEmpty(roomId);
    return;
  }
  if (!roomEmptySince[roomId]) roomEmptySince[roomId] = Date.now();
}

function destroyRoom(roomId) {
  if (!roomId) return false;
  let changed = false;
  if (roomStates[roomId]) {
    delete roomStates[roomId];
    changed = true;
  }
  if (roomVersions[roomId] != null) {
    delete roomVersions[roomId];
  }
  if (roomDeltaLogs[roomId]) {
    delete roomDeltaLogs[roomId];
  }
  if (roomLocks[roomId]) {
    delete roomLocks[roomId];
    changed = true;
  }
  if (roomUsers[roomId]) {
    delete roomUsers[roomId];
    changed = true;
  }
  if (roomEmptySince[roomId]) {
    delete roomEmptySince[roomId];
  }
  if (roomLastSnapshotVersion[roomId] != null) {
    delete roomLastSnapshotVersion[roomId];
  }
  if (changed) {
    requestSaveStates('destroy-room');
    flushSaveStates({ reason: 'destroy-room' }).catch(() => {
      // ignore
    });
  }
  return changed;
}

// 1. 配置 CORS (跨域资源共享)
// 允许前端 (localhost:5173) 访问后端 API
app.use(cors({
  origin: "*", // 暂时允许所有来源，方便调试
  methods: ["GET", "POST"]
}));
app.use(express.json({ limit: '12mb' }));

function postJson(urlStr, payload, timeoutMs) {
  if (typeof fetch === 'function') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(urlStr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(payload)
    })
      .then(async (resp) => {
        clearTimeout(timeout);
        const text = await resp.text();
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        return { ok: resp.ok, status: resp.status, data, raw: text };
      })
      .catch((err) => {
        clearTimeout(timeout);
        const name = err && typeof err.name === 'string' ? err.name : '';
        const message = err && typeof err.message === 'string' ? err.message : '';
        const isTimeout = name === 'AbortError' || message.toUpperCase().includes('TIMEOUT');
        const detail = isTimeout ? 'TIMEOUT' : (name || message || 'FETCH_FAILED');
        return { ok: false, status: 0, data: { error: isTimeout ? 'TIMEOUT' : 'FETCH_FAILED', detail }, raw: '' };
      });
  }

  return new Promise((resolve) => {
    try {
      const u = new URL(urlStr);
      const client = u.protocol === 'https:' ? https : http;
      const body = JSON.stringify(payload);
      const req = client.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port,
          path: `${u.pathname || ''}${u.search || ''}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          },
          timeout: timeoutMs
        },
        (resp) => {
          let raw = '';
          resp.setEncoding('utf8');
          resp.on('data', (chunk) => {
            raw += chunk;
          });
          resp.on('end', () => {
            let data = null;
            try {
              data = raw ? JSON.parse(raw) : null;
            } catch {
              data = null;
            }
            resolve({
              ok: resp.statusCode >= 200 && resp.statusCode < 300,
              status: resp.statusCode || 0,
              data,
              raw
            });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('TIMEOUT'));
      });
      req.on('error', () => {
        resolve({ ok: false, status: 0, data: null, raw: '' });
      });
      req.write(body);
      req.end();
    } catch {
      resolve({ ok: false, status: 0, data: null, raw: '' });
    }
  });
}

const { createRecognizeMathHandler } = require('./recognizeMath');
app.post(
  '/api/recognize-math',
  createRecognizeMathHandler({
    postJson,
    getUpstreamUrl: () =>
      process.env.LOCAL_MATH_OCR_URL || process.env.MATH_OCR_URL || 'http://127.0.0.1:5007/recognize'
  })
);

const server = http.createServer(app);

// 2. 初始化 Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*", // 允许前端 WebSocket 连接
    methods: ["GET", "POST"]
  }
});

// --- 定期快照对齐（Periodic Snapshot Sync）---
//
// 触发条件：
// - 周期到达（ROOM_SNAPSHOT_INTERVAL_SECONDS）
// - 且该房间当前有人在线
// - 且房间版本号相比上一次快照已发生变化（避免重复广播）
//
// 广播内容：
// - sync-state（包含 objects + tombstones），客户端按 CRDT/LWW 规则合并即可。
if (ROOM_SNAPSHOT_INTERVAL_MS > 0) {
  const timer = setInterval(() => {
    for (const roomId of Object.keys(roomStates)) {
      if (getRoomConnCount(io, roomId) <= 0) continue;
      const currentV = getRoomVersion(roomId);
      const lastV = roomLastSnapshotVersion[roomId];
      if (typeof lastV === 'number' && lastV === currentV) continue;

      roomLastSnapshotVersion[roomId] = currentV;
      io.to(roomId).emit('sync-state', {
        ...buildRoomSnapshotPayload(roomId),
        reason: 'periodic'
      });
    }
  }, ROOM_SNAPSHOT_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

// --- 房间自动销毁（空房间 TTL）---
//
// 给外行看的解释：
// - 白板会把房间状态（roomStates）落盘到 roomStates.json，方便刷新/重启后恢复；
// - 但如果房间“没人了”还一直保留，会导致：
//   - 文件越来越大；
//   - 老房间永远占内存；
// - 所以我们做一个“空房间保留一段时间后自动删除”的策略。
//
// 关键概念：
// - 空房间：房间里当前没有任何 socket 连接；
// - emptySince：第一次变空的时间戳；
// - TTL：允许空房间保留的最长时间。
//
// 配置方式（环境变量）：
// - ROOM_TTL_MINUTES：空房间保留的分钟数；默认 60；设为 0/false/no/off 关闭
// - ROOM_CLEANUP_INTERVAL_SECONDS：扫描间隔秒数；默认 60；最小 5
//
// 注意：
// - TTL 清理是“工程层”的房间生命周期管理，不属于 CRDT 算法；
// - 房间被清理后，之后再进入同名 roomId 就等价于“新房间”。
if (ROOM_TTL_MS > 0) {
  const timer = setInterval(() => {
    const now = Date.now();

    // 第一阶段：找出哪些房间已经没人了，开始/更新 emptySince
    for (const roomId of Object.keys(roomStates)) {
      if (getRoomConnCount(io, roomId) > 0) {
        markRoomNonEmpty(roomId);
      } else if (!roomEmptySince[roomId]) {
        roomEmptySince[roomId] = now;
      }
    }

    // 第二阶段：把“空了超过 TTL”的房间销毁（内存 + roomStates.json）
    for (const [roomId, since] of Object.entries(roomEmptySince)) {
      if (getRoomConnCount(io, roomId) > 0) {
        markRoomNonEmpty(roomId);
        continue;
      }
      if (typeof since === 'number' && now - since >= ROOM_TTL_MS) {
        destroyRoom(roomId);
      }
    }
  }, ROOM_CLEANUP_INTERVAL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

// 3. 监听 Socket 连接事件
io.on('connection', (socket) => {
  console.log(`[Socket] User connected: ${socket.id}`);
  const joinedRooms = new Set();

  // --- 房间管理逻辑 ---
  
  // 监听：新用户加入
  socket.on('join-room', (payload) => {
    const roomId = typeof payload === 'string' ? payload : (payload && payload.roomId);
    const userNameRaw = payload && typeof payload === 'object' ? payload.userName : '';
    const userName = typeof userNameRaw === 'string' ? userNameRaw.trim().slice(0, 24) : '';
    const clientVersionRaw = payload && typeof payload === 'object' ? payload.clientVersion : null;
    const clientVersion =
      typeof clientVersionRaw === 'number' && Number.isFinite(clientVersionRaw) && clientVersionRaw >= 0
        ? Math.floor(clientVersionRaw)
        : null;
    if (!roomId) return;
    if (userName) socket.data.userName = userName;

    socket.join(roomId);
    joinedRooms.add(roomId);
    markRoomNonEmpty(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);

    // 更新服务端的“在线成员表”，并给加入者下发一次快照。
    // 这样用户即使不移动鼠标，也能立刻在 UI 里看到房间内有哪些人、各自昵称是什么。
    if (!roomUsers[roomId]) {
      roomUsers[roomId] = {};
    }
    roomUsers[roomId][socket.id] = socket.data.userName || '';
    broadcastRoomUsers(io, roomId);

    // 同步策略（给外行看的解释）：
    // - 新加入者/首次进入：发全量快照（sync-state），因为客户端没有任何历史；
    // - 断线重连者：如果客户端带了 clientVersion，且服务端还有对应的增量日志，则只补缺失增量（sync-delta）；
    // - 兜底：当客户端版本太旧或服务端没日志，就退回全量快照，保证“一定能同步上”。
    if (!SYNC_MODE_NAIVE) {
      if (typeof clientVersion === 'number' && clientVersion > 0) {
        sendDeltaSync(socket, roomId, clientVersion);
      } else {
        sendFullSync(socket, roomId);
      }
    }

    // 广播给其他人
    socket.to(roomId).emit('user-joined', { userId: socket.id, userName: socket.data.userName || '' });

    cleanupExpiredLocks(roomId);
    socket.emit('lock-state', {
      roomId,
      locks: getRoomLockSnapshot(roomId),
      serverNow: Date.now()
    });
  });

  /**
   * 手动请求“全量快照对齐”（兜底入口）。
   *
   * 适用场景（给外行看的解释）：
   * - 协作白板是“高频实时同步”系统，理论上只要网络正常，客户端会持续收增量并保持一致；
   * - 但在极端情况下（例如：网络波动、浏览器后台挂起、客户端误操作），用户可能产生“我感觉不同步了”的主观体验；
   * - 这时提供一个“强制重新对齐到服务端权威状态”的按钮，会比让用户刷新页面更友好。
   *
   * 设计原则：
   * - 这是“工程兜底”，不改变 CRDT 的冲突解决规则；
   * - 只对“已经加入该房间”的 socket 生效，避免被用作探测其它房间数据。
   */
  socket.on('request-sync', (payload, ack) => {
    const roomId = payload && payload.roomId;
    if (!roomId || typeof roomId !== 'string') {
      if (typeof ack === 'function') ack({ ok: false, error: 'INVALID_ROOM' });
      return;
    }
    if (!joinedRooms.has(roomId)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'NOT_IN_ROOM' });
      return;
    }

    // 兜底策略：无论客户端版本号是多少，都直接发全量快照，保证“按一次就能对齐”。
    sendFullSync(socket, roomId);

    if (typeof ack === 'function') {
      ack({ ok: true, serverEpoch: SERVER_EPOCH, serverVersion: getRoomVersion(roomId) });
    }
  });

  /**
   * 房间重置（运维级别）：清空服务端保存的 room state 并通知在线用户同步清空。
   *
   * 与“清空画布（逐对象 tombstone）”的区别：
   * - 清空画布：属于 CRDT 语义的一部分，会留下 tombstone，便于冲突解决与一致性维护；
   * - 房间重置：属于工程能力，一键回到“新房间”，避免刷新/新加入者加载历史数据。
   */
  socket.on('clear-room', (payload) => {
    const roomId = payload && payload.roomId;
    if (!roomId) return;

    let changed = false;
    if (roomStates[roomId]) {
      delete roomStates[roomId];
      changed = true;
    }
    if (roomLocks[roomId]) {
      delete roomLocks[roomId];
    }
    if (roomUsers[roomId]) {
      delete roomUsers[roomId];
    }
    if (roomVersions[roomId] != null) {
      roomVersions[roomId] = 0;
    }
    if (roomDeltaLogs[roomId]) {
      roomDeltaLogs[roomId] = [];
    }
    markRoomNonEmpty(roomId);
    if (roomEmptySince[roomId]) delete roomEmptySince[roomId];
    if (changed) {
      requestSaveStates('clear-room');
      flushSaveStates({ reason: 'clear-room' }).catch(() => {
        // ignore
      });
    }

    // 广播给房间内所有在线客户端：让它们执行本地 reset（清空画布/CRDT/History/临时 UI 状态）
    io.to(roomId).emit('room-cleared', {
      roomId,
      clearedAt: Date.now(),
      by: socket.id,
      serverEpoch: SERVER_EPOCH,
      serverVersion: 0
    });
  });

  // --- 绘图同步逻辑 ---
  
  // 监听：绘图事件 (接收前端发来的 CRDT 数据)
  // data: { roomId, id, data, timestamps }
  socket.on('draw-event', (payload) => {
    const { roomId, id, data, timestamps } = payload;
    const bench = BENCH_PASS_THROUGH_ENABLED && payload && typeof payload.__bench === 'object' ? payload.__bench : null;
    
    if (roomId) markRoomNonEmpty(roomId);
    if (!roomStates[roomId]) {
      roomStates[roomId] = {};
    }

    // 任何 Ghost Polyline（临时预览）一律不进入 CRDT 状态与持久化
    if (isGhostPolylineData(data)) {
      return;
    }

    if (SYNC_MODE_NAIVE) {
      const serverVersion = bumpRoomVersion(roomId);
      roomStates[roomId][id] = { id, data, timestamps };
      io.to(roomId).emit(
        'draw-event',
        bench
          ? { id, data, timestamps, serverEpoch: SERVER_EPOCH, serverVersion, __bench: bench }
          : { id, data, timestamps, serverEpoch: SERVER_EPOCH, serverVersion }
      );
      return;
    }

    // --- 服务器端简单的 LWW 合并逻辑 ---
    // 只有当本地没有该对象，或者远程时间戳更新时才覆盖
    const existing = roomStates[roomId][id];
    
    if (!existing) {
      roomStates[roomId][id] = { id, data, timestamps };
      if (data && data._deleted) {
        if (DRAW_EVENT_DEBUG) {
          console.log(`[Server] Object ${id} marked as DELETED. Timestamp:`, timestamps._deleted);
        }
      }
      
      // [关键修复] 保存状态到文件
      requestSaveStates('draw-event:new');

      const serverVersion = bumpRoomVersion(roomId);
      appendRoomDelta(roomId, { v: serverVersion, id, data, timestamps });
      io.to(roomId).emit(
        'draw-event',
        bench
          ? { id, data, timestamps, serverEpoch: SERVER_EPOCH, serverVersion, __bench: bench }
          : { id, data, timestamps, serverEpoch: SERVER_EPOCH, serverVersion }
      );
      return;
    }

    const newData = { ...existing.data };
    const newTimestamps = { ...existing.timestamps };
    const acceptedData = {};
    const acceptedTimestamps = {};

    Object.keys(data).forEach(key => {
      const remoteTs = timestamps[key] || 0;
      const localTs = existing.timestamps[key] || 0;
      
      // [关键修复] 对于删除操作，使用特殊的逻辑
      if (key === '_deleted') {
        // 如果远程明确标记为删除，且时间戳较新，则接受删除
        if (data._deleted === true && remoteTs > localTs) {
          newData[key] = data[key];
          newTimestamps[key] = remoteTs;
          acceptedData[key] = data[key];
          acceptedTimestamps[key] = remoteTs;
        }
        // 如果远程没有删除标记，但本地有，且远程时间戳更新，则移除删除标记
        else if (data._deleted === false && remoteTs > localTs) {
          delete newData[key];
          delete newTimestamps[key];
          acceptedData[key] = false;
          acceptedTimestamps[key] = remoteTs;
        }
      } 
      // 对于其他属性，使用标准的时间戳比较
      else if (remoteTs > localTs) {
        newData[key] = data[key];
        newTimestamps[key] = remoteTs;
        acceptedData[key] = data[key];
        acceptedTimestamps[key] = remoteTs;
      }
    });

    roomStates[roomId][id] = {
      id,
      data: newData,
      timestamps: newTimestamps
    };

    if (Object.keys(acceptedData).length === 0) {
      return;
    }

    if (acceptedData._deleted) {
      if (DRAW_EVENT_DEBUG) {
        console.log(`[Server] Object ${id} marked as DELETED. Timestamp:`, acceptedTimestamps._deleted);
      }
    }
    
    // [关键修复] 保存状态到文件
    requestSaveStates('draw-event:update');

    const serverVersion = bumpRoomVersion(roomId);
    appendRoomDelta(roomId, { v: serverVersion, id, data: acceptedData, timestamps: acceptedTimestamps });
    io.to(roomId).emit('draw-event', {
      id,
      data: acceptedData,
      timestamps: acceptedTimestamps,
      serverEpoch: SERVER_EPOCH,
      serverVersion,
      ...(bench ? { __bench: bench } : {})
    });
  });

  // 监听：实时绘图过程 (Ghost Brush)
  // data: { roomId, x, y, isEnd }
  socket.on('drawing-process', (data) => {
    // console.log(`[Socket] Drawing process from ${socket.id}:`, data.isEnd ? 'END' : `${data.x},${data.y}`);
    // 直接转发，不做存储
    socket.to(data.roomId).emit('drawing-process', {
      userId: socket.id,
      ...data
    });
  });

  // 监听：光标移动
  socket.on('cursor-move', (data) => {
    const { roomId, x, y, userName, seq } = data || {};
    if (!roomId) return;
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
    const ns = Number(seq);
    const nseq = Number.isFinite(ns) ? Math.floor(ns) : null;
    const incomingName = typeof userName === 'string' ? userName.trim().slice(0, 24) : '';
    if (incomingName) socket.data.userName = incomingName;
    const finalName = incomingName || socket.data.userName || '';

    // 同步到“房间在线成员表”（用于成员列表显示昵称）。
    // cursor-move 是一个“天然高频事件”，所以这里的更新不额外增加网络成本。
    if (roomUsers[roomId]) {
      roomUsers[roomId][socket.id] = finalName;
    }

    // 广播给房间内的其他人 (包含发送者的 ID)
    socket.to(roomId).emit('cursor-move', {
      userId: socket.id,
      x: nx,
      y: ny,
      userName: finalName,
      ...(nseq != null ? { seq: nseq } : {})
    });
  });

  /**
   * 昵称更新（不需要重新 join-room）。
   *
   * 为什么需要单独事件？
   * - 如果用“再次 join-room”来更新昵称，会带来副作用：
   *   - 服务端会重新下发 sync-state（全量快照），浪费网络；
   *   - 会再次触发 user-joined 广播，干扰 UI。
   * - 所以我们提供一个轻量的 set-user-name：
   *   - 只更新服务端的 socket.data.userName 与 roomUsers；
   *   - 向房间广播 user-name，让别人立刻刷新成员列表/光标标签。
   */
  socket.on('set-user-name', (payload, ack) => {
    const raw = payload && payload.userName;
    const next = typeof raw === 'string' ? raw.trim().slice(0, 24) : '';
    if (!next) {
      if (typeof ack === 'function') ack({ ok: false, error: 'EMPTY_NAME' });
      return;
    }

    socket.data.userName = next;

    for (const roomId of joinedRooms) {
      if (roomUsers[roomId]) {
        roomUsers[roomId][socket.id] = next;
      }
      io.to(roomId).emit('user-name', { userId: socket.id, userName: next });
      broadcastRoomUsers(io, roomId);
    }

    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('lock-acquire', (payload, ack) => {
    const roomId = payload && payload.roomId;
    const resourceId = payload && payload.resourceId;
    const ownerName = payload && payload.ownerName;
    const ttlMsRaw = payload && payload.ttlMs;
    const ttlMs = Number.isFinite(ttlMsRaw) ? Math.max(1000, Math.min(60000, ttlMsRaw)) : 15000;

    if (!roomId || !resourceId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'INVALID_PAYLOAD' });
      return;
    }

    if (typeof ownerName === 'string' && ownerName.trim()) {
      const next = ownerName.trim().slice(0, 24);
      socket.data.userName = next;
      if (roomUsers[roomId]) {
        roomUsers[roomId][socket.id] = next;
      }
    }

    const expiredChanged = cleanupExpiredLocks(roomId);
    if (expiredChanged) {
      broadcastRoomLocks(io, roomId);
    }

    if (!roomLocks[roomId]) {
      roomLocks[roomId] = {};
    }

    const existing = roomLocks[roomId][resourceId];
    const now = Date.now();

    if (!existing || existing.ownerId === socket.id) {
      roomLocks[roomId][resourceId] = {
        ownerId: socket.id,
        ownerName: ownerName || '',
        expiresAt: now + ttlMs
      };
      broadcastRoomLocks(io, roomId);
      if (typeof ack === 'function') ack({ ok: true, ownerId: socket.id, expiresAt: roomLocks[roomId][resourceId].expiresAt, serverNow: now });
      return;
    }

    if (typeof ack === 'function') {
      ack({
        ok: false,
        error: 'LOCKED',
        lockedBy: {
          ownerId: existing.ownerId,
          ownerName: existing.ownerName || '',
          expiresAt: existing.expiresAt
        },
        serverNow: now
      });
    }
  });

  socket.on('lock-renew', (payload, ack) => {
    const roomId = payload && payload.roomId;
    const resourceId = payload && payload.resourceId;
    const ttlMsRaw = payload && payload.ttlMs;
    const ttlMs = Number.isFinite(ttlMsRaw) ? Math.max(1000, Math.min(60000, ttlMsRaw)) : 15000;

    if (!roomId || !resourceId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'INVALID_PAYLOAD' });
      return;
    }

    const expiredChanged = cleanupExpiredLocks(roomId);
    if (expiredChanged) {
      broadcastRoomLocks(io, roomId);
    }

    const existing = roomLocks[roomId] && roomLocks[roomId][resourceId];
    const now = Date.now();

    if (!existing) {
      if (typeof ack === 'function') ack({ ok: false, error: 'NOT_LOCKED', serverNow: now });
      return;
    }

    if (existing.ownerId !== socket.id) {
      if (typeof ack === 'function') ack({ ok: false, error: 'NOT_OWNER', serverNow: now });
      return;
    }

    existing.expiresAt = now + ttlMs;
    broadcastRoomLocks(io, roomId);
    if (typeof ack === 'function') ack({ ok: true, expiresAt: existing.expiresAt, serverNow: now });
  });

  socket.on('lock-release', (payload, ack) => {
    const roomId = payload && payload.roomId;
    const resourceId = payload && payload.resourceId;

    if (!roomId || !resourceId) {
      if (typeof ack === 'function') ack({ ok: false, error: 'INVALID_PAYLOAD' });
      return;
    }

    const existing = roomLocks[roomId] && roomLocks[roomId][resourceId];
    const now = Date.now();

    if (!existing) {
      if (typeof ack === 'function') ack({ ok: true, serverNow: now });
      return;
    }

    if (existing.ownerId !== socket.id) {
      if (typeof ack === 'function') ack({ ok: false, error: 'NOT_OWNER', serverNow: now });
      return;
    }

    delete roomLocks[roomId][resourceId];
    if (Object.keys(roomLocks[roomId]).length === 0) {
      delete roomLocks[roomId];
    }
    broadcastRoomLocks(io, roomId);
    if (typeof ack === 'function') ack({ ok: true, serverNow: now });
  });

  // 监听：断开连接
  socket.on('disconnect', () => {
    console.log(`[Socket] User disconnected: ${socket.id}`);
    for (const roomId of joinedRooms) {
      socket.to(roomId).emit('user-left', { userId: socket.id, userName: socket.data.userName || '' });
      if (roomUsers[roomId]) {
        delete roomUsers[roomId][socket.id];
        if (Object.keys(roomUsers[roomId]).length === 0) {
          delete roomUsers[roomId];
        } else {
          broadcastRoomUsers(io, roomId);
        }
      }
      if (roomLocks[roomId]) {
        let changed = false;
        for (const [resourceId, lock] of Object.entries(roomLocks[roomId])) {
          if (lock && lock.ownerId === socket.id) {
            delete roomLocks[roomId][resourceId];
            changed = true;
          }
        }
        if (changed) {
          if (Object.keys(roomLocks[roomId]).length === 0) {
            delete roomLocks[roomId];
          }
          broadcastRoomLocks(io, roomId);
        }
      }
      markRoomEmptyIfNeeded(io, roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;

let ocrProcess = null;
function startLocalOcrServiceIfNeeded() {
  const force = String(process.env.OCR_AUTO_START || '').trim();
  const forceLower = force.toLowerCase();
  if (forceLower === '0' || forceLower === 'false' || forceLower === 'no') return;
  const configuredUrl = process.env.LOCAL_MATH_OCR_URL || process.env.MATH_OCR_URL;
  const defaultUrl = 'http://127.0.0.1:5007/recognize';
  const shouldTry =
    force === '1' ||
    forceLower === 'true' ||
    (!configuredUrl || configuredUrl === defaultUrl);

  if (!shouldTry) return;
  if (ocrProcess) return;

  const ocrHost = process.env.OCR_HOST || '127.0.0.1';
  const ocrPort = process.env.OCR_PORT || '5007';
  const healthUrl = `http://${ocrHost}:${ocrPort}/health`;
  const ocrCwd = path.join(__dirname, '..', 'ocr_service');
  const venvPython312 = path.join(ocrCwd, 'venv312', 'Scripts', 'python.exe');
  const venvPythonAlt = path.join(ocrCwd, '.venv312', 'Scripts', 'python.exe');
  const venvPython = path.join(ocrCwd, '.venv', 'Scripts', 'python.exe');
  const ocrPython =
    process.env.OCR_PYTHON ||
    (fs.existsSync(venvPython312)
      ? venvPython312
      : (fs.existsSync(venvPythonAlt) ? venvPythonAlt : (fs.existsSync(venvPython) ? venvPython : 'python')));

  const start = () => {
    ocrProcess = spawn(
      ocrPython,
      ['-m', 'uvicorn', 'app:app', '--host', ocrHost, '--port', String(ocrPort)],
      {
        cwd: ocrCwd,
        stdio: 'inherit',
        windowsHide: true
      }
    );

    ocrProcess.on('exit', () => {
      ocrProcess = null;
    });

    const stop = () => {
      if (!ocrProcess) return;
      try {
        ocrProcess.kill();
      } catch {
        // ignore
      }
      ocrProcess = null;
    };
    process.on('exit', stop);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  };

  if (typeof fetch === 'function') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 800);
    fetch(healthUrl, { method: 'GET', signal: controller.signal })
      .then((resp) => {
        clearTimeout(timeout);
        if (resp && resp.ok) return;
        start();
      })
      .catch(() => {
        clearTimeout(timeout);
        start();
      });
    return;
  }

  try {
    const u = new URL(healthUrl);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname || '/',
        method: 'GET',
        timeout: 800
      },
      (resp) => {
        const ok = resp.statusCode >= 200 && resp.statusCode < 300;
        resp.resume();
        if (!ok) start();
      }
    );
    req.on('timeout', () => req.destroy(new Error('TIMEOUT')));
    req.on('error', () => start());
    req.end();
  } catch {
    start();
  }
}

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n❌ Backend 启动失败：端口 ${PORT} 已被占用。`);
    console.error('   解决办法：结束占用进程，或设置环境变量 PORT 更换端口。');
    return;
  }
  console.error('\n❌ Backend 启动失败：', err);
});

server.listen(PORT, () => {
  startLocalOcrServiceIfNeeded();
  console.log(`\n🚀 Backend server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO is ready for connections`);
});
