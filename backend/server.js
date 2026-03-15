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

// --- 简单的内存存储 (用于演示 CRDT 状态持久化) ---
// 结构: { roomId: { objectId: { id, data, timestamps } } }
const roomStates = {};

// 结构: { roomId: { resourceId: { ownerId, ownerName, expiresAt } } }
const roomLocks = {};

// [关键修复] 状态持久化文件路径
const STATE_FILE = path.join(__dirname, 'roomStates.json');

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

// [关键修复] 从文件加载状态
function loadStates() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const loadedStates = JSON.parse(data);
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
        saveStates();
      }
    }
  } catch (error) {
    console.error('[Server] Error loading states:', error);
  }
}

// [关键修复] 启动时加载状态
loadStates();

// [关键修复] 保存状态到文件
function saveStates() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(roomStates, null, 2));
    console.log('[Server] Saved room states to file');
  } catch (error) {
    console.error('[Server] Error saving states:', error);
  }
}

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

// 1. 配置 CORS (跨域资源共享)
// 允许前端 (localhost:5174) 访问后端 API
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
    }).then(async (resp) => {
      clearTimeout(timeout);
      const text = await resp.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      return { ok: resp.ok, status: resp.status, data, raw: text };
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

app.post('/api/recognize-math', async (req, res) => {
  const imageDataUrl = req?.body?.imageDataUrl;
  if (typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:image/')) {
    res.status(400).json({ ok: false, error: 'BAD_IMAGE' });
    return;
  }

  const localUrl =
    process.env.LOCAL_MATH_OCR_URL ||
    process.env.MATH_OCR_URL ||
    'http://127.0.0.1:5007/recognize';

  try {
    const upstream = await postJson(localUrl, { imageDataUrl }, 20000);
    if (!upstream.ok) {
      const detail =
        (upstream.data && typeof upstream.data.detail === 'string' ? upstream.data.detail : '') ||
        (upstream.data && typeof upstream.data.error === 'string' ? upstream.data.error : '') ||
        '';
      res.status(200).json({
        ok: false,
        error: 'UPSTREAM_ERROR',
        status: upstream.status || 0,
        detail
      });
      return;
    }

    if (upstream.data && typeof upstream.data.error === 'string' && upstream.data.error) {
      const detail = upstream.data && typeof upstream.data.detail === 'string' ? upstream.data.detail : '';
      res.status(200).json({
        ok: false,
        error: 'UPSTREAM_ERROR',
        status: upstream.status || 0,
        detail: detail || upstream.data.error
      });
      return;
    }

    const latex =
      (upstream.data && (typeof upstream.data.latex === 'string' ? upstream.data.latex : '')) ||
      (upstream.data && (typeof upstream.data.result === 'string' ? upstream.data.result : '')) ||
      '';
    if (!latex) {
      res.status(200).json({
        ok: false,
        error: 'EMPTY_LATEX',
        status: upstream.status || 0
      });
      return;
    }
    const debug =
      upstream.data &&
      upstream.data.debug &&
      typeof upstream.data.debug.processedImageDataUrl === 'string'
        ? { processedImageDataUrl: upstream.data.debug.processedImageDataUrl }
        : null;
    res.json(debug ? { ok: true, latex, debug } : { ok: true, latex });
  } catch {
    res.status(200).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

const server = http.createServer(app);

// 2. 初始化 Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*", // 允许前端 WebSocket 连接
    methods: ["GET", "POST"]
  }
});

// 3. 监听 Socket 连接事件
io.on('connection', (socket) => {
  console.log(`[Socket] User connected: ${socket.id}`);
  const joinedRooms = new Set();

  // --- 房间管理逻辑 ---
  
  // 监听：新用户加入
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    joinedRooms.add(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);

    // 发送当前房间的完整状态 (Full Sync)
    if (roomStates[roomId]) {
      // [关键优化] 过滤掉已删除的对象 (Tombstones)
      // 虽然 CRDT 理论上需要同步墓碑，但在 "Initial Sync" 阶段，
      // 为了减小包大小并防止客户端渲染出"僵尸"对象，我们可以只发送存活的对象
      // (前提是客户端不需要知道"历史删除记录"来解决它本地的冲突，对于新加入者这是成立的)
      const activeObjects = Object.values(roomStates[roomId]).filter(item => {
        // 如果 data 中包含 _deleted: true，则过滤掉
        return !(item.data && (item.data._deleted || isGhostPolylineData(item.data)));
      });
      
      socket.emit('sync-state', activeObjects);
    } else {
      socket.emit('sync-state', []);
    }

    // 广播给其他人
    socket.to(roomId).emit('user-joined', { userId: socket.id });

    cleanupExpiredLocks(roomId);
    socket.emit('lock-state', {
      roomId,
      locks: getRoomLockSnapshot(roomId),
      serverNow: Date.now()
    });
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

    if (roomStates[roomId]) {
      delete roomStates[roomId];
      saveStates();
    }

    // 广播给房间内所有在线客户端：让它们执行本地 reset（清空画布/CRDT/History/临时 UI 状态）
    io.to(roomId).emit('room-cleared', {
      roomId,
      clearedAt: Date.now(),
      by: socket.id
    });
  });

  // --- 绘图同步逻辑 ---
  
  // 监听：绘图事件 (接收前端发来的 CRDT 数据)
  // data: { roomId, id, data, timestamps }
  socket.on('draw-event', (payload) => {
    const { roomId, id, data, timestamps } = payload;
    
    if (!roomStates[roomId]) {
      roomStates[roomId] = {};
    }

    // 任何 Ghost Polyline（临时预览）一律不进入 CRDT 状态与持久化
    if (isGhostPolylineData(data)) {
      return;
    }

    // --- 服务器端简单的 LWW 合并逻辑 ---
    // 只有当本地没有该对象，或者远程时间戳更新时才覆盖
    const existing = roomStates[roomId][id];
    
    if (!existing) {
      roomStates[roomId][id] = { id, data, timestamps };
      if (data && data._deleted) {
        console.log(`[Server] Object ${id} marked as DELETED. Timestamp:`, timestamps._deleted);
      }
      
      // [关键修复] 保存状态到文件
      saveStates();
      
      io.to(roomId).emit('draw-event', { id, data, timestamps });
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
      console.log(`[Server] Object ${id} marked as DELETED. Timestamp:`, acceptedTimestamps._deleted);
    }
    
    // [关键修复] 保存状态到文件
    saveStates();
    
    io.to(roomId).emit('draw-event', {
      id,
      data: acceptedData,
      timestamps: acceptedTimestamps
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
    const { roomId, x, y, userName } = data;
    // 广播给房间内的其他人 (包含发送者的 ID)
    socket.to(roomId).emit('cursor-move', {
      userId: socket.id,
      x,
      y,
      userName
    });
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
    // 通知所有房间，该用户已离开 (简化处理：通知所有连接的客户端，实际上应该记录用户在哪个房间)
    socket.broadcast.emit('user-left', { userId: socket.id });

    for (const roomId of joinedRooms) {
      if (!roomLocks[roomId]) continue;
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
  });
});

const PORT = process.env.PORT || 3000;

let ocrProcess = null;
function startLocalOcrServiceIfNeeded() {
  const force = String(process.env.OCR_AUTO_START || '').trim();
  const forceLower = force.toLowerCase();
  if (forceLower === '0' || forceLower === 'false' || forceLower === 'no') return;
  const configuredUrl = process.env.LOCAL_MATH_OCR_URL || process.env.MATH_OCR_URL;
  const defaultUrl = 'http://127.0.0.1:5005/recognize';
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
