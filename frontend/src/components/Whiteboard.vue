<script setup>
defineOptions({ name: 'WhiteboardBoard' })
import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as fabric from 'fabric';
import katex from 'katex';
import QRCode from 'qrcode';
import socketService from '../services/socket'; // 引入 Socket 服务
import crdtManager from '../utils/crdt/CRDTManager'; // 引入 CRDT 管理器
import historyManager, { AddCommand, RemoveCommand, ModifyCommand } from '../utils/History'; // 引入历史记录管理器
import { createGhostBrushSender, downsamplePointsKeepTail, normalizeGhostBrushPayload } from '../utils/ghostBrush';
import { applyDeadzone, expSmoothing, shouldAcceptMonotonicSeq } from '../utils/remoteCursor';
import { recognizeMathFromImageDataUrl } from '../services/ocr';
import { sceneRectToViewportRect } from '../utils/ocrCrop';

// --- 状态变量 ---
const isDev = import.meta.env?.DEV === true;
const canvasEl = ref(null); // 对应 <canvas ref="canvasEl">
let canvas = null; // 存放 Fabric Canvas 实例 (注意：不要用 ref 包裹它！)
const objectMap = new Map(); // id -> fabricObject (用于快速查找)
let urlSearchParams = null;
try {
  urlSearchParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
} catch {
  urlSearchParams = new URLSearchParams();
}
const getUrlParam = (key) => {
  try {
    return urlSearchParams.get(key);
  } catch {
    return null;
  }
};
const renderPerfMode = isDev && getUrlParam('renderPerf') === '1';
const renderOptBaseline = getUrlParam('renderOpt') === 'baseline';
const renderSkipOffscreenDefault = renderOptBaseline ? false : true;
const renderObjectCachingDefault = renderOptBaseline ? false : true;
const renderSkipOffscreenEnabled = getUrlParam('skipOffscreen') == null
  ? renderSkipOffscreenDefault
  : getUrlParam('skipOffscreen') !== '0';
const renderObjectCachingEnabled = getUrlParam('objectCaching') == null
  ? renderObjectCachingDefault
  : getUrlParam('objectCaching') !== '0';
let renderPerfOverride = null;
const getActiveRenderPerfConfig = () => {
  const override = renderPerfOverride && typeof renderPerfOverride === 'object' ? renderPerfOverride : null;
  return {
    skipOffscreen: override && typeof override.skipOffscreen === 'boolean' ? override.skipOffscreen : renderSkipOffscreenEnabled,
    objectCaching: override && typeof override.objectCaching === 'boolean' ? override.objectCaching : renderObjectCachingEnabled
  };
};
const applyRenderPerfConfigToCanvas = () => {
  if (!canvas) return;
  const cfg = getActiveRenderPerfConfig();
  canvas.skipOffscreen = cfg.skipOffscreen;
};
const applyRenderPerfDefaultsToObject = (obj) => {
  if (!obj) return;
  if (obj.__isGhost === true) return;
  if (obj.__draftShape === true) return;
  const cfg = getActiveRenderPerfConfig();
  if (typeof cfg.objectCaching === 'boolean') {
    obj.objectCaching = cfg.objectCaching;
    obj.dirty = true;
  }
};
let lastActiveObjectForCaching = null;
const syncActiveObjectCaching = () => {
  if (!canvas) return;
  const cfg = getActiveRenderPerfConfig();
  if (lastActiveObjectForCaching && lastActiveObjectForCaching !== canvas.getActiveObject?.()) {
    applyRenderPerfDefaultsToObject(lastActiveObjectForCaching);
    lastActiveObjectForCaching = null;
  }
  const active = typeof canvas.getActiveObject === 'function' ? canvas.getActiveObject() : null;
  if (active) {
    lastActiveObjectForCaching = active;
    active.objectCaching = false;
    active.dirty = true;
  }
};
// Socket 连接状态（用于 UI 展示；不参与协同逻辑）
// - connecting: 正在建立连接/重连中
// - connected: 连接已建立
// - disconnected: 连接断开（可能会自动重连）
const connectionState = ref('connecting');
const isOnline = computed(() => connectionState.value === 'connected');

const viewportWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1200);

const TOOLBAR_STORAGE_KEY = 'qb:toolbarExpanded';
let toolbarExpandedInit = false;
try {
  const raw = String(localStorage.getItem(TOOLBAR_STORAGE_KEY) || '').trim();
  if (raw) toolbarExpandedInit = raw === '1' || raw.toLowerCase() === 'true';
} catch {
  toolbarExpandedInit = false;
}
const toolbarExpanded = ref(toolbarExpandedInit);
const toolbarCompact = computed(() => viewportWidth.value < 980);
const toolbarShowAdvanced = computed(() => toolbarExpanded.value);

const toggleToolbarExpanded = () => {
  toolbarExpanded.value = !toolbarExpanded.value;
  try {
    localStorage.setItem(TOOLBAR_STORAGE_KEY, toolbarExpanded.value ? '1' : '0');
  } catch {
    void 0;
  }
};

const toolbarBtnBase =
  'h-9 px-2 rounded-md text-sm inline-flex items-center gap-1.5 hover:bg-gray-100 active:scale-[0.98] transition select-none';
const toolbarBtnActive = 'bg-blue-50 text-blue-700 ring-1 ring-blue-200';
const toolbarBtnDanger = 'text-red-600 hover:bg-red-50';
const toolbarBtnMuted = 'text-gray-700';
const toolbarBtnDisabled = 'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100';
const toolBtnClass = (tool) => {
  const isActive = currentTool.value === tool;
  return `${toolbarBtnBase} ${toolbarBtnMuted} ${isActive ? toolbarBtnActive : ''}`;
};
const simpleBtnClass = () => `${toolbarBtnBase} ${toolbarBtnMuted}`;
const dangerBtnClass = () => `${toolbarBtnBase} ${toolbarBtnDanger}`;
const dangerBtnDisabledClass = () => `${toolbarBtnBase} ${toolbarBtnDanger} ${toolbarBtnDisabled}`;
const simpleBtnDisabledClass = () => `${toolbarBtnBase} ${toolbarBtnMuted} ${toolbarBtnDisabled}`;

const svgToBase64 = (svg) => {
  try {
    const enc = new TextEncoder();
    const bytes = enc.encode(String(svg || ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  } catch {
    try {
      return btoa(unescape(encodeURIComponent(String(svg || ''))));
    } catch {
      return '';
    }
  }
};

const svgToCursor = (svg, hotX, hotY, fallback) => {
  const b64 = svgToBase64(svg);
  const safeFallback = String(fallback || 'crosshair');
  if (b64) return `url("data:image/svg+xml;base64,${b64}") ${hotX} ${hotY}, ${safeFallback}`;
  return `url("data:image/svg+xml,${encodeURIComponent(String(svg || ''))}") ${hotX} ${hotY}, ${safeFallback}`;
};

const QB_CURSOR_PRECISE = (() => {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><circle cx='12' cy='12' r='7.6' fill='none' stroke='%23ffffff' stroke-opacity='0.96' stroke-width='3.2'/><circle cx='12' cy='12' r='7.6' fill='none' stroke='%230f172a' stroke-opacity='0.92' stroke-width='1.8'/><circle cx='12' cy='12' r='2.2' fill='%23ffffff' fill-opacity='0.98'/><circle cx='12' cy='12' r='1.2' fill='%230f172a' fill-opacity='0.96'/></svg>";
  return svgToCursor(svg, 12, 12, 'crosshair');
})();

const QB_CURSOR_ERASER = (() => {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M6 15l7-7 5 5-7 7H6l-2-2z' fill='none' stroke='%23ffffff' stroke-opacity='0.96' stroke-width='3.2' stroke-linejoin='round'/><path d='M6 15l7-7 5 5-7 7H6l-2-2z' fill='none' stroke='%230f172a' stroke-opacity='0.92' stroke-width='1.8' stroke-linejoin='round'/><path d='M12 20h10' stroke='%23ffffff' stroke-opacity='0.96' stroke-width='3.0' stroke-linecap='round'/><path d='M12 20h10' stroke='%230f172a' stroke-opacity='0.92' stroke-width='1.6' stroke-linecap='round'/></svg>";
  return svgToCursor(svg, 12, 12, 'crosshair');
})();

const setCanvasCursor = (cursor) => {
  if (!canvas) return;
  const c = String(cursor || 'default');
  canvas.defaultCursor = c;
  canvas.hoverCursor = c;
  canvas.moveCursor = c;
  if (canvas.upperCanvasEl && canvas.upperCanvasEl.style) {
    canvas.upperCanvasEl.style.cursor = c;
  }
};

let eraserHoverCursorBackup = null;
const applyEraserHoverCursorOverride = (enabled) => {
  if (!canvas) return;
  if (enabled === true) {
    if (!eraserHoverCursorBackup) eraserHoverCursorBackup = new WeakMap();
    const objs = canvas.getObjects ? canvas.getObjects() : [];
    (objs || []).forEach((obj) => {
      if (!obj || obj.__isGhost === true) return;
      if (eraserHoverCursorBackup && !eraserHoverCursorBackup.has(obj)) {
        eraserHoverCursorBackup.set(obj, obj.hoverCursor);
      }
      obj.hoverCursor = QB_CURSOR_ERASER;
      obj.moveCursor = QB_CURSOR_ERASER;
    });
    return;
  }

  if (!eraserHoverCursorBackup) return;
  const objs = canvas.getObjects ? canvas.getObjects() : [];
  (objs || []).forEach((obj) => {
    if (!obj) return;
    const prev = eraserHoverCursorBackup.get(obj);
    if (prev !== undefined) obj.hoverCursor = prev;
    if (prev !== undefined) obj.moveCursor = prev;
  });
};

// --- 弱网模拟（开发验证入口）---
//
// 给外行看的解释：
// - “弱网”不是指你电脑坏了，而是指：网络延迟高、偶发丢包、消息顺序乱；
// - 协作白板要想稳定，必须能在这种情况下依然“最终收敛一致”；
// - 我们把弱网模拟放在 socketService 里（对发送/接收做延迟与丢弃），这里仅负责：
//   - 初始化配置（从 URL/localStorage 读取）
//   - 在 UI 角落显示“当前是否开启弱网模拟 + 关键参数 + 统计”
const netSimConfig = ref(socketService.getNetworkSimulation());
const netSimStats = ref(socketService.getNetworkSimulationStats());
const netSimEnabled = computed(() => !!netSimConfig.value && netSimConfig.value.enabled === true);
const netSimLabel = computed(() => {
  const cfg = netSimConfig.value || {};
  const s = cfg.send || {};
  const r = cfg.receive || {};
  const pct = (x) => `${Math.round((Number(x) || 0) * 100)}%`;
  const ms = (x) => `${Math.round(Number(x) || 0)}ms`;
  return `S drop ${pct(s.dropRate)} delay ${ms(s.delayMs)}±${ms(s.jitterMs)} | R drop ${pct(r.dropRate)} delay ${ms(r.delayMs)}±${ms(r.jitterMs)}`;
});
const netSimTooltip = computed(() => {
  const st = netSimStats.value || {};
  return `send=${st.sendTotal} drop=${st.sendDropped} delayed=${st.sendDelayed} (lastDelay=${st.lastSendDelayMs}ms)\nrecv=${st.recvTotal} drop=${st.recvDropped} delayed=${st.recvDelayed} (lastDelay=${st.lastRecvDelayMs}ms)`;
});
let netSimPollTimer = null;

const toolRingMounted = ref(false);
const toolRingVisible = ref(false);
const toolRingX = ref(-10000);
const toolRingY = ref(-10000);
const toolRingOpenSeq = ref(0);
const toolRingHoverKey = ref('');
let toolRingAutoCloseTimer = null;
let toolRingLongPressTimer = null;
let toolRingLongPressStart = null;
let toolRingActivePointerId = null;
let toolRingHostEl = null;
let toolRingDetach = null;

const eraserCursorClientX = ref(-10000);
const eraserCursorClientY = ref(-10000);

let shapeDraft = null;

// --- 轻量 Toast（非阻塞提示）---
//
// 给外行看的解释：
// - 浏览器原生的 alert/confirm 会“阻塞页面”（用户必须点确定/取消才能继续操作），体验很差；
// - 协作白板是高频交互场景，我们更需要“非打断式提醒”（例如：复制成功/离线提示/识别失败原因）；
// - 所以这里实现一个最小的 Toast：显示在右上角，几秒后自动消失。
//
// 设计原则：
// - Toast 只用于“提示信息”，不承载关键业务输入（关键输入用弹窗/表单）；
// - 默认自动消失；错误类可以更久一些；
// - 不依赖第三方库，便于毕设答辩时讲清楚。
const toasts = ref([]); // [{ id, type, message }]
let toastSeq = 0;
const pushToast = (type, message, ttlMs) => {
  const id = `t${Date.now()}_${toastSeq++}`;
  const msg = String(message || '').trim();
  if (!msg) return;
  const safeType = type === 'error' || type === 'warning' || type === 'success' ? type : 'info';
  const defaultTtl = safeType === 'error' ? 4500 : safeType === 'warning' ? 3500 : 2200;
  const ttl = Number.isFinite(ttlMs) ? Math.max(800, Math.min(15000, ttlMs)) : defaultTtl;
  toasts.value = [...(toasts.value || []), { id, type: safeType, message: msg }];
  setTimeout(() => {
    toasts.value = (toasts.value || []).filter(t => t && t.id !== id);
  }, ttl);
};

// --- 轻量确认弹窗（替代 confirm）---
//
// 给外行看的解释：
// - confirm 同样会阻塞 UI，而且在移动端体验更差；
// - 这里用一个简单的模态框来确认“危险操作”（清空画布、重置房间）。
const confirmOpen = ref(false);
const confirmTitle = ref('');
const confirmMessage = ref('');
const confirmOkText = ref('确定');
const confirmCancelText = ref('取消');
let confirmResolver = null;
const confirmAsync = (title, message, okText, cancelText) => {
  confirmTitle.value = String(title || '').trim() || '请确认';
  confirmMessage.value = String(message || '').trim();
  confirmOkText.value = String(okText || '').trim() || '确定';
  confirmCancelText.value = String(cancelText || '').trim() || '取消';
  confirmOpen.value = true;
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
};
const closeConfirm = (result) => {
  confirmOpen.value = false;
  const r = confirmResolver;
  confirmResolver = null;
  if (typeof r === 'function') r(result === true);
};

// --- 手动复制弹窗（用于剪贴板 API 失败时的兜底）---
const manualCopyOpen = ref(false);
const manualCopyText = ref('');
const openManualCopy = (text) => {
  manualCopyText.value = String(text || '');
  manualCopyOpen.value = true;
};
const closeManualCopy = () => {
  manualCopyOpen.value = false;
};

const shareQrOpen = ref(false);
const shareQrLink = ref('');
const shareQrDataUrl = ref('');
const openShareQr = async () => {
  const url = new URL(window.location.href);
  url.searchParams.set('room', ROOM_ID);
  const link = url.toString();
  shareQrLink.value = link;
  try {
    shareQrDataUrl.value = await QRCode.toDataURL(link, { width: 240, margin: 1 });
  } catch {
    shareQrDataUrl.value = '';
  }
  shareQrOpen.value = true;
};
const closeShareQr = () => {
  shareQrOpen.value = false;
};

const helpOpen = ref(false);
const openHelp = () => {
  helpOpen.value = true;
};
const closeHelp = () => {
  helpOpen.value = false;
};

// --- 同步版本号（用于断线重连后“只补缺失增量”）---
//
// 给外行看的解释：
// - 服务端会维护一个“房间版本号”（serverVersion），每当它接受一次 draw-event 增量，就把版本号 +1；
// - 客户端把“我目前同步到的版本号”记为 lastServerVersion；
// - 断线重连后，join-room 会带上 clientVersion = lastServerVersion；
// - 服务端如果还保留对应的增量日志，就回发 sync-delta（只包含缺失的那部分增量），速度会比发全量快照更快。
//
// 注意：
// - 版本号只用于“补包定位”，不参与 CRDT/LWW 冲突裁决。
let lastServerVersion = 0;
let currentServerEpoch = '';
const lastSyncError = ref('');
const lastSyncAt = ref(0);
const canRequestSync = computed(() => connectionState.value === 'connected');
const syncErrorLabel = computed(() => {
  const code = String(lastSyncError.value || '').trim();
  if (!code) return '';
  if (code === 'DISCONNECTED') return '离线中（请等待重连后再对齐）';
  if (code === 'TIMEOUT') return '请求超时（后端繁忙或网络不稳定）';
  if (code === 'NOT_IN_ROOM') return '尚未加入房间（请刷新或重新进入房间）';
  if (code === 'INVALID_ROOM') return '房间号无效';
  if (code === 'NO_SOCKET') return '连接未初始化';
  return `未知错误：${code}`;
});

const applyServerEpoch = (serverEpoch) => {
  const next = typeof serverEpoch === 'string' ? serverEpoch.trim() : '';
  if (!next) return;
  if (currentServerEpoch && currentServerEpoch !== next) {
    lastServerVersion = 0;
    socketService.setClientVersion(0);
  }
  currentServerEpoch = next;
};

const requestFullSync = async () => {
  lastSyncError.value = '';
  if (!canRequestSync.value) {
    lastSyncError.value = 'DISCONNECTED';
    return;
  }
  const resp = await socketService.emitWithAck('request-sync', { roomId: ROOM_ID }, 3000);
  if (!resp || resp.ok !== true) {
    const code = resp && typeof resp.error === 'string' ? resp.error : 'SYNC_FAILED';
    lastSyncError.value = code;
    return;
  }
  if (resp && typeof resp.serverEpoch === 'string' && resp.serverEpoch) {
    applyServerEpoch(resp.serverEpoch);
  }
  if (resp && typeof resp.serverVersion === 'number' && Number.isFinite(resp.serverVersion)) {
    lastServerVersion = Math.max(lastServerVersion, Math.floor(resp.serverVersion));
    socketService.setClientVersion(lastServerVersion);
  }
  lastSyncAt.value = Date.now();
};

// --- 在线成员（成员列表 / 昵称展示）---
//
// 背景（给外行看的解释）：
// - Socket.IO 每个连接都会分配一个 socketId（例如 "qv3..."），它能唯一标识“这次连接”；
// - 但 socketId 对人不友好，所以我们让用户设置一个昵称（userName）；
// - 进入房间时服务端会下发一次 room-users 快照，让 UI 立刻知道“现在房间里有哪些人”，
//   而不需要等对方移动鼠标触发 cursor-move。
//
// 注意：
// - mySocketId 可能会在重连后变化（新的连接 = 新 socketId），这是正常现象。
const mySocketId = ref('');
const onlineUsers = ref({}); // { [userId]: { userId, userName } }
const onlineUsersCount = computed(() => Object.keys(onlineUsers.value || {}).length);
const onlineUsersLabel = computed(() => {
  const entries = Object.values(onlineUsers.value || {});
  const myId = mySocketId.value;
  const names = entries.map((u) => {
    const rawName = u && typeof u.userName === 'string' ? u.userName.trim() : '';
    const display = rawName || (u && u.userId ? String(u.userId).slice(0, 4) : '未知');
    return u && u.userId && myId && u.userId === myId ? `${display}(我)` : display;
  });
  return names.join('、');
});

// --- 光标相关 ---
const remoteCursorMap = new Map(); // userId -> cursor
let remoteCursorRafId = 0;
const REMOTE_CURSOR_TTL_MS = 20000;
const REMOTE_CURSOR_SMOOTH_TAU_MS = 90;
const REMOTE_CURSOR_DEADZONE_PX = 0.8;
const REMOTE_CURSOR_LABEL_PAD_X = 10;
const REMOTE_CURSOR_LABEL_PAD_Y = 3;
const REMOTE_CURSOR_LABEL_OFFSET_X = 0;
const REMOTE_CURSOR_LABEL_OFFSET_Y = 12;
const REMOTE_CURSOR_LABEL_RADIUS = 6;
const REMOTE_CURSOR_LABEL_TEXT = 'rgba(15,23,42,0.90)';
const REMOTE_CURSOR_LABEL_BG_ALPHA = 0.32;
const REMOTE_CURSOR_LABEL_BG_L = 82;
const REMOTE_CURSOR_LABEL_BORDER_ALPHA = 0.28;
const REMOTE_CURSOR_LABEL_BORDER_L = 58;

const getRemoteCursorLabelBgFill = (hue) => `hsla(${hue}, 78%, ${REMOTE_CURSOR_LABEL_BG_L}%, ${REMOTE_CURSOR_LABEL_BG_ALPHA})`;
const getRemoteCursorLabelBgStroke = (hue) => `hsla(${hue}, 78%, ${REMOTE_CURSOR_LABEL_BORDER_L}%, ${REMOTE_CURSOR_LABEL_BORDER_ALPHA})`;

const updateRemoteCursorLabel = (cursor, userId, userName) => {
  if (!cursor) return;
  const label = cursor.labelObj;
  const bg = cursor.labelBgObj;
  if (!label || !bg) return;
  const next = (typeof userName === 'string' && userName.trim() ? userName.trim().slice(0, 24) : userId.slice(0, 4)) || '';
  if (label.text !== next) {
    label.set({ text: next });
  }
  if (typeof label.initDimensions === 'function') {
    try {
      label.initDimensions();
    } catch {
      void 0;
    }
  }
  const w = typeof label.width === 'number' && Number.isFinite(label.width) ? label.width : 0;
  const h = typeof label.height === 'number' && Number.isFinite(label.height) ? label.height : 0;
  const bw = Math.max(12, w + REMOTE_CURSOR_LABEL_PAD_X * 2);
  const bh = Math.max(12, h + REMOTE_CURSOR_LABEL_PAD_Y * 2);
  bg.set({ width: bw, height: bh, left: REMOTE_CURSOR_LABEL_OFFSET_X, top: REMOTE_CURSOR_LABEL_OFFSET_Y });
  label.set({
    left: REMOTE_CURSOR_LABEL_OFFSET_X,
    top: REMOTE_CURSOR_LABEL_OFFSET_Y + (bh - h) / 2
  });
  bg.dirty = true;
  label.dirty = true;
  if (cursor.obj) cursor.obj.dirty = true;
};

const renderRemoteCursorsOnce = (force = false) => {
  if (!canvas) return;
  const now = performance.now();
  let anyActive = false;
  let anyDirty = false;
  const zoom = typeof canvas.getZoom === 'function' ? canvas.getZoom() : 1;
  const dzWorld = REMOTE_CURSOR_DEADZONE_PX / (zoom || 1);
  const invScale = 1 / (zoom || 1);

  for (const [userId, cursor] of remoteCursorMap.entries()) {
    const lastSeenAt = typeof cursor.lastSeenAt === 'number' ? cursor.lastSeenAt : 0;
    if (!lastSeenAt || now - lastSeenAt > REMOTE_CURSOR_TTL_MS) {
      if (cursor && cursor.obj && canvas) {
        canvas.remove(cursor.obj);
      }
      remoteCursorMap.delete(userId);
      continue;
    }

    const tx = toFiniteNumber(cursor.tx);
    const ty = toFiniteNumber(cursor.ty);
    if (tx === null || ty === null) continue;

    const prevCx = typeof cursor.cx === 'number' && Number.isFinite(cursor.cx) ? cursor.cx : null;
    const prevCy = typeof cursor.cy === 'number' && Number.isFinite(cursor.cy) ? cursor.cy : null;
    let cx = prevCx === null ? tx : prevCx;
    let cy = prevCy === null ? ty : prevCy;

    const dtMs = typeof cursor.lastRenderAt === 'number' && Number.isFinite(cursor.lastRenderAt) ? now - cursor.lastRenderAt : 16;
    cursor.lastRenderAt = now;

    if (force === true || cursor.snapNext === true) {
      cx = tx;
      cy = ty;
      cursor.snapNext = false;
    } else {
      cx = applyDeadzone(cx, tx, dzWorld);
      cy = applyDeadzone(cy, ty, dzWorld);
      cx = expSmoothing(cx, tx, dtMs, REMOTE_CURSOR_SMOOTH_TAU_MS);
      cy = expSmoothing(cy, ty, dtMs, REMOTE_CURSOR_SMOOTH_TAU_MS);
    }

    cursor.cx = cx;
    cursor.cy = cy;

    const obj = cursor.obj;
    if (!obj) continue;
    if (typeof invScale === 'number' && Number.isFinite(invScale)) {
      const lastScale = typeof cursor.lastScale === 'number' && Number.isFinite(cursor.lastScale) ? cursor.lastScale : null;
      if (lastScale === null || Math.abs(lastScale - invScale) > 1e-6) {
        obj.set({ scaleX: invScale, scaleY: invScale });
        cursor.lastScale = invScale;
        anyDirty = true;
      }
    }
    obj.set({ left: cx, top: cy });
    if (typeof obj.setCoords === 'function') obj.setCoords();
    obj.dirty = true;
    anyDirty = true;
    anyActive = true;
  }

  if (anyDirty) {
    canvas.requestRenderAll();
  }
  if (!anyActive && remoteCursorRafId) {
    cancelAnimationFrame(remoteCursorRafId);
    remoteCursorRafId = 0;
  }
};

const ensureRemoteCursorLoop = () => {
  if (remoteCursorRafId) return;
  remoteCursorRafId = requestAnimationFrame(function tick() {
    remoteCursorRafId = 0;
    renderRemoteCursorsOnce(false);
    if (remoteCursorMap.size > 0) {
      remoteCursorRafId = requestAnimationFrame(tick);
    }
  });
};

const hashStringToHue = (s) => {
  const str = String(s || '');
  let h = 0;
  for (let i = 0; i < str.length; i += 1) {
    h = (h * 31 + str.charCodeAt(i)) % 360;
  }
  return h;
};

const getStableUserColor = (userId) => {
  const hue = hashStringToHue(userId);
  return {
    hue,
    solid: `hsl(${hue} 86% 52%)`,
    soft: `hsla(${hue}, 86%, 52%, 0.22)`,
    glow: `hsla(${hue}, 86%, 52%, 0.45)`
  };
};
//
// 昵称策略（给外行看的解释）：
// - 昵称只用于“展示身份”（光标标签/锁提示/成员列表），不影响 CRDT 数据正确性；
// - 这里把昵称存在 localStorage，保证刷新页面后仍然是同一个名字；
// - 同时把昵称同步给服务端，让其它用户能在 user-joined / user-left / user-name 等事件里看到名字。
const NAME_STORAGE_KEY = 'qb:nickname';
let initialName = '';
try {
  initialName = String(localStorage.getItem(NAME_STORAGE_KEY) || '').trim();
} catch {
  initialName = '';
}
const myName = ref(initialName || `User ${Math.floor(Math.random() * 1000)}`);
try {
  if (!initialName) localStorage.setItem(NAME_STORAGE_KEY, myName.value);
} catch {
  void 0;
}
socketService.setUserName(myName.value);

const upsertOnlineUser = (userId, userName) => {
  if (!userId) return;
  const next = { ...(onlineUsers.value || {}) };
  const name = typeof userName === 'string' ? userName.trim() : '';
  next[userId] = { userId, userName: name };
  onlineUsers.value = next;
};

const removeOnlineUser = (userId) => {
  if (!userId) return;
  if (!onlineUsers.value || !onlineUsers.value[userId]) return;
  const next = { ...(onlineUsers.value || {}) };
  delete next[userId];
  onlineUsers.value = next;
};

const saveMyName = async () => {
  const next = String(myName.value || '').trim().slice(0, 24);
  if (!next) return;
  myName.value = next;
  socketService.setUserName(next);
  try {
    localStorage.setItem(NAME_STORAGE_KEY, next);
  } catch {
    void 0;
  }

  // 通知服务端“我改名了”，避免必须等我移动鼠标（cursor-move）别人才看到新名字。
  // 这里使用带 ack 的事件：如果离线，会返回 DISCONNECTED，我们直接忽略即可。
  await socketService.emitWithAck('set-user-name', { userName: next }, 2000);
};

const clearToolRingTimers = () => {
  if (toolRingAutoCloseTimer) {
    clearTimeout(toolRingAutoCloseTimer);
    toolRingAutoCloseTimer = null;
  }
  if (toolRingLongPressTimer) {
    clearTimeout(toolRingLongPressTimer);
    toolRingLongPressTimer = null;
  }
  toolRingLongPressStart = null;
};

const scheduleToolRingAutoClose = () => {
  if (toolRingAutoCloseTimer) clearTimeout(toolRingAutoCloseTimer);
  toolRingAutoCloseTimer = setTimeout(() => {
    toolRingVisible.value = false;
    setTimeout(() => {
      toolRingMounted.value = false;
    }, 180);
  }, 1000);
};

const openToolRingAtClientPoint = (clientX, clientY) => {
  if (!toolRingHostEl || !toolRingHostEl.getBoundingClientRect) return;
  if (isFormulaEditorOpen.value === true) return;
  if (isFormulaRecognizeMode.value === true) return;
  const rect = toolRingHostEl.getBoundingClientRect();
  const x = Math.max(12, Math.min(rect.width - 12, clientX - rect.left));
  const y = Math.max(12, Math.min(rect.height - 12, clientY - rect.top));
  toolRingX.value = x;
  toolRingY.value = y;
  toolRingOpenSeq.value += 1;
  toolRingHoverKey.value = '';
  toolRingMounted.value = true;
  toolRingVisible.value = false;
  requestAnimationFrame(() => {
    toolRingVisible.value = true;
    scheduleToolRingAutoClose();
  });
};

const closeToolRing = () => {
  toolRingVisible.value = false;
  toolRingHoverKey.value = '';
  toolRingActivePointerId = null;
  setTimeout(() => {
    toolRingMounted.value = false;
  }, 180);
};

const updateToolRingHoverByClientPoint = (clientX, clientY) => {
  if (!toolRingVisible.value) return;
  if (!toolRingHostEl || !toolRingHostEl.getBoundingClientRect) return;
  const items = toolRingItems.value || [];
  if (!items.length) return;

  const rect = toolRingHostEl.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const dx = x - toolRingX.value;
  const dy = y - toolRingY.value;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < toolRingInnerRadius - 8 || dist > toolRingOuterRadius + 12) {
    toolRingHoverKey.value = '';
    return;
  }

  const angle = Math.atan2(dy, dx);
  const total = items.length;
  const step = (Math.PI * 2) / total;
  const normalized = (angle + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
  const idx = Math.floor((normalized + step / 2) / step) % total;
  const next = items[idx] && items[idx].key ? String(items[idx].key) : '';
  toolRingHoverKey.value = next;
};

const performUndo = () => {
  if (undoRedoInProgress) return;
  undoRedoInProgress = true;
  isUndoRedo = true;

  if (canvas?.isDrawingMode) {
    suppressNextLocalPathCreated = true;
    if (suppressNextLocalPathCreatedTimeout) {
      clearTimeout(suppressNextLocalPathCreatedTimeout);
    }
    suppressNextLocalPathCreatedTimeout = setTimeout(() => {
      suppressNextLocalPathCreated = false;
      suppressNextLocalPathCreatedTimeout = null;
    }, 800);
  }
  stopLocalDrawingOnce();
  historyManager.undo();

  if (undoRedoTimeout) clearTimeout(undoRedoTimeout);
  undoRedoTimeout = setTimeout(() => {
    isUndoRedo = false;
    undoRedoInProgress = false;
  }, 100);
};

const performRedo = () => {
  if (undoRedoInProgress) return;
  undoRedoInProgress = true;
  isUndoRedo = true;

  historyManager.redo();

  if (undoRedoTimeout) clearTimeout(undoRedoTimeout);
  undoRedoTimeout = setTimeout(() => {
    isUndoRedo = false;
    undoRedoInProgress = false;
  }, 100);
};

const finalizeNewObject = (obj) => {
  if (!canvas || !obj) return;
  if (!obj.id) {
    obj.id = generateId();
  }
  objectMap.set(obj.id, obj);
  historyManager.push(new AddCommand(getAppContext(), obj));
  const crdtState = crdtManager.localUpdate(obj.id, obj.toJSON());
  socketService.emit('draw-event', {
    roomId: ROOM_ID,
    ...crdtState
  });
};

const beginShapeDraft = (shapeType, startPoint) => {
  if (!canvas || !startPoint) return;
  if (shapeDraft) return;

  const x = startPoint.x;
  const y = startPoint.y;
  const baseStroke = 'rgba(15, 23, 42, 0.92)';
  const baseStrokeWidth = 3;

  let obj = null;
  if (shapeType === 'rect') {
    obj = new fabric.Rect({
      left: x,
      top: y,
      width: 1,
      height: 1,
      rx: 6,
      ry: 6,
      fill: 'rgba(255,255,255,0)',
      stroke: baseStroke,
      strokeWidth: baseStrokeWidth,
      selectable: false,
      evented: false,
      hasControls: false,
      hoverCursor: QB_CURSOR_PRECISE
    });
  } else if (shapeType === 'circle') {
    obj = new fabric.Circle({
      left: x,
      top: y,
      radius: 1,
      originX: 'left',
      originY: 'top',
      fill: 'rgba(255,255,255,0)',
      stroke: baseStroke,
      strokeWidth: baseStrokeWidth,
      selectable: false,
      evented: false,
      hasControls: false,
      hoverCursor: QB_CURSOR_PRECISE
    });
  }

  if (!obj) return;
  obj.__draftShape = true;
  canvas.add(obj);
  canvas.requestRenderAll();

  shapeDraft = {
    type: shapeType,
    startX: x,
    startY: y,
    obj
  };
};

const updateShapeDraft = (point) => {
  if (!canvas || !shapeDraft || !point) return;
  const x0 = shapeDraft.startX;
  const y0 = shapeDraft.startY;
  const x1 = point.x;
  const y1 = point.y;
  const dx = x1 - x0;
  const dy = y1 - y0;

  if (shapeDraft.type === 'rect') {
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const w = Math.max(1, Math.abs(dx));
    const h = Math.max(1, Math.abs(dy));
    shapeDraft.obj.set({ left, top, width: w, height: h });
    shapeDraft.obj.setCoords();
    canvas.requestRenderAll();
    return;
  }

  if (shapeDraft.type === 'circle') {
    const size = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)));
    const left = dx >= 0 ? x0 : x0 - size;
    const top = dy >= 0 ? y0 : y0 - size;
    const r = size / 2;
    shapeDraft.obj.set({ left, top, radius: r, originX: 'left', originY: 'top' });
    shapeDraft.obj.setCoords();
    canvas.requestRenderAll();
  }
};

const commitShapeDraft = () => {
  if (!canvas || !shapeDraft) return;
  const obj = shapeDraft.obj;
  shapeDraft = null;

  if (!obj) return;
  const tooSmall =
    (obj.type === 'rect' && ((obj.width || 0) < 6 || (obj.height || 0) < 6)) ||
    (obj.type === 'circle' && ((obj.radius || 0) < 4));

  if (tooSmall) {
    canvas.remove(obj);
    canvas.requestRenderAll();
    return;
  }

  obj.__draftShape = false;
  obj.selectable = true;
  obj.evented = true;
  obj.hasControls = true;
  obj.hoverCursor = 'move';
  obj.setCoords();

  finalizeNewObject(obj);
  canvas.setActiveObject(obj);
  canvas.requestRenderAll();
};

const cancelShapeDraft = () => {
  if (!canvas || !shapeDraft) return;
  const obj = shapeDraft.obj;
  shapeDraft = null;
  if (obj) {
    canvas.remove(obj);
    canvas.requestRenderAll();
  }
};

const toolRingItems = computed(() => {
  const stroke = "fill='none' stroke='currentColor' stroke-width='1.9' stroke-linecap='round' stroke-linejoin='round'";
  return [
    {
      key: 'pencil',
      label: '画笔',
      iconSvg: `<path d='M4 20h4l10-10-4-4L4 16v4z' ${stroke}/><path d='M13 7l4 4' ${stroke}/>` ,
      action: () => setTool('pencil')
    },
    {
      key: 'eraser',
      label: '橡皮',
      iconSvg: `<path d='M6 14l6-6 6 6-4 4H10L6 14z' ${stroke}/><path d='M10 18h4' ${stroke}/><path d='M12 20h8' ${stroke}/>` ,
      action: () => setTool('eraser')
    },
    {
      key: 'rect',
      label: '矩形',
      iconSvg: `<rect x='6' y='6' width='12' height='12' rx='2' ${stroke}/>` ,
      action: () => setTool('rect')
    },
    {
      key: 'circle',
      label: '圆形',
      iconSvg: `<circle cx='12' cy='12' r='6' ${stroke}/>` ,
      action: () => setTool('circle')
    },
    {
      key: 'formula',
      label: '公式',
      iconSvg: `<path d='M18 4H6l7 8-7 8h12' ${stroke}/>` ,
      action: () => insertFormula()
    },
    {
      key: 'recognize',
      label: '识别',
      iconSvg: `<circle cx='11' cy='11' r='4' ${stroke}/><path d='M20 20l-4-4' ${stroke}/>` ,
      action: () => startFormulaRecognize()
    },
    {
      key: 'undo',
      label: '撤销',
      iconSvg: `<path d='M9 14l-4-4 4-4' ${stroke}/><path d='M5 10h9a5 5 0 1 1 0 10h-3' ${stroke}/>` ,
      action: () => performUndo()
    },
    {
      key: 'redo',
      label: '重做',
      iconSvg: `<path d='M15 14l4-4-4-4' ${stroke}/><path d='M19 10H10a5 5 0 1 0 0 10h3' ${stroke}/>` ,
      action: () => performRedo()
    }
  ];
});

const getToolRingIconStyle = (idx, total, isActive) => {
  const p = getToolRingSectorLabelPoint(idx, total);
  const delay = toolRingVisible.value ? `${idx * 28}ms` : '0ms';
  const enterScale = toolRingVisible.value ? 1 : 0.18;
  const baseScale = 0.78;
  const scale = baseScale * enterScale;
  return {
    opacity: toolRingVisible.value ? 1 : 0,
    color: isActive ? 'rgba(15,23,42,0.96)' : 'rgba(15,23,42,0.86)',
    transform: `translate(${p.x}px, ${p.y}px) scale(${scale}) translate(-12px, -12px)`,
    transitionProperty: 'transform, opacity',
    transitionDuration: '180ms',
    transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    transitionDelay: delay
  };
};

const toolRingHoverLabel = computed(() => {
  const k = String(toolRingHoverKey.value || '');
  if (!k) return '';
  const items = toolRingItems.value || [];
  const found = items.find((x) => x && x.key === k);
  return found && typeof found.label === 'string' ? found.label : '';
});

const getToolRingItemStyle = (idx, total) => {
  const radius = 84;
  const step = (Math.PI * 2) / Math.max(1, total);
  const a = -Math.PI / 2 + idx * step;
  const dx = Math.cos(a) * radius;
  const dy = Math.sin(a) * radius;
  const delay = toolRingVisible.value ? `${idx * 42}ms` : '0ms';
  const x = toolRingX.value;
  const y = toolRingY.value;
  const translate = toolRingVisible.value
    ? `translate(${x}px, ${y}px) translate(${dx}px, ${dy}px)`
    : `translate(${x}px, ${y}px) translate(0px, 0px)`;
  const scale = toolRingVisible.value ? 1 : 0.35;
  const opacity = toolRingVisible.value ? 1 : 0;
  return {
    transform: `${translate} translate(-50%, -50%) scale(${scale})`,
    opacity,
    transitionDelay: delay
  };
};

const toolRingSize = 220;
const toolRingCenter = toolRingSize / 2;
const toolRingInnerRadius = 46;
const toolRingOuterRadius = 104;

const polarToPoint = (angle, radius) => {
  return {
    x: toolRingCenter + Math.cos(angle) * radius,
    y: toolRingCenter + Math.sin(angle) * radius
  };
};

const getToolRingSectorPath = (idx, total) => {
  const step = (Math.PI * 2) / Math.max(1, total);
  const start = -Math.PI / 2 + idx * step;
  const end = start + step;

  const o0 = polarToPoint(start, toolRingOuterRadius);
  const o1 = polarToPoint(end, toolRingOuterRadius);
  const i1 = polarToPoint(end, toolRingInnerRadius);
  const i0 = polarToPoint(start, toolRingInnerRadius);

  const largeArc = step > Math.PI ? 1 : 0;

  return [
    `M ${o0.x} ${o0.y}`,
    `A ${toolRingOuterRadius} ${toolRingOuterRadius} 0 ${largeArc} 1 ${o1.x} ${o1.y}`,
    `L ${i1.x} ${i1.y}`,
    `A ${toolRingInnerRadius} ${toolRingInnerRadius} 0 ${largeArc} 0 ${i0.x} ${i0.y}`,
    'Z'
  ].join(' ');
};

const getToolRingSectorLabelPoint = (idx, total) => {
  const step = (Math.PI * 2) / Math.max(1, total);
  const mid = -Math.PI / 2 + idx * step + step / 2;
  return polarToPoint(mid, (toolRingInnerRadius + toolRingOuterRadius) / 2);
};

const getToolRingSectorStyle = (idx) => {
  const delay = toolRingVisible.value ? `${idx * 28}ms` : '0ms';
  const scale = toolRingVisible.value ? 1 : 0.18;
  const opacity = toolRingVisible.value ? 1 : 0;
  return {
    opacity,
    transform: `scale(${scale})`,
    transformOrigin: `${toolRingCenter}px ${toolRingCenter}px`,
    transitionProperty: 'transform, opacity',
    transitionDuration: '180ms',
    transitionTimingFunction: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    transitionDelay: delay
  };
};

const clickToolRingItem = (item) => {
  if (!item || typeof item.action !== 'function') return;
  item.action();
  closeToolRing();
};

const clickToolRingItemByKey = (key) => {
  const items = toolRingItems.value || [];
  const k = String(key || '');
  const found = items.find((x) => x && x.key === k);
  if (found) clickToolRingItem(found);
};

const lockState = ref({});
const isFormulaEditorOpen = ref(false);
const isFormulaInsertPreviewOpen = ref(false);
let formulaInsertPending = null;
const formulaEditorValue = ref('');
const normalizeLatexForKatex = (src) => {
  const s0 = String(src || '').trim();
  if (!s0) return '';
  if (s0.startsWith('\\(') && s0.endsWith('\\)')) return s0.slice(2, -2).trim();
  if (s0.startsWith('\\[') && s0.endsWith('\\]')) return s0.slice(2, -2).trim();
  if (s0.startsWith('$$') && s0.endsWith('$$') && s0.length >= 4) return s0.slice(2, -2).trim();
  if (s0.startsWith('$') && s0.endsWith('$') && s0.length >= 2) return s0.slice(1, -1).trim();
  return s0;
};
const formulaPreviewHtml = computed(() => {
  const src = normalizeLatexForKatex(formulaEditorValue.value || '');
  if (!src) return '';
  try {
    return katex.renderToString(src, {
      throwOnError: false,
      displayMode: true,
      strict: 'ignore'
    });
  } catch {
    return '';
  }
});
const formulaEditorTitle = computed(() => (isFormulaInsertPreviewOpen.value ? '确认公式（LaTeX）' : '编辑公式（LaTeX）'));
const formulaEditorOkText = computed(() => (isFormulaInsertPreviewOpen.value ? '添加到画布' : '保存'));
let formulaEditingObjectId = null;
let formulaEditingBeforeJson = null;
let formulaEditingLockResourceId = null;
let formulaEditingLockRenewTimer = null;
const selectedFormulaObjectId = ref(null);
const selectedFormulaLockLabel = computed(() => {
  const objectId = selectedFormulaObjectId.value;
  if (!objectId) return '';
  const resourceId = `formula:${objectId}`;
  const l = lockState.value?.[resourceId];
  if (!l) return '公式：未上锁';
  const name = l.ownerName || l.ownerId || '未知用户';
  return `公式：已上锁（${name}）`;
});
const isFormulaRecognizeMode = ref(false);
const isFormulaRecognizing = ref(false);
let formulaRecognizePrevTool = null;
let formulaRecognizeStartPoint = null;
let formulaRecognizeRect = null;
let formulaRecognizeAbortController = null;
let formulaOverlayRootEl = null;
let formulaMeasureEl = null;
const formulaOverlayMap = new Map();

const ensureFormulaOverlayLayer = () => {
  if (!canvas) return null;
  if (formulaOverlayRootEl) return formulaOverlayRootEl;
  const host = canvas.wrapperEl || (canvas.upperCanvasEl ? canvas.upperCanvasEl.parentElement : null);
  if (!host) return null;
  const root = document.createElement('div');
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  root.style.width = '100%';
  root.style.height = '100%';
  root.style.pointerEvents = 'none';
  root.style.zIndex = '0';
  if (canvas.upperCanvasEl && typeof host.insertBefore === 'function') {
    host.insertBefore(root, canvas.upperCanvasEl);
  } else {
    host.appendChild(root);
  }
  formulaOverlayRootEl = root;

  const measure = document.createElement('div');
  measure.style.position = 'absolute';
  measure.style.left = '-10000px';
  measure.style.top = '-10000px';
  measure.style.visibility = 'hidden';
  measure.style.pointerEvents = 'none';
  root.appendChild(measure);
  formulaMeasureEl = measure;
  return formulaOverlayRootEl;
};

const measureFormulaSize = (latex, fontSize) => {
  const root = ensureFormulaOverlayLayer();
  if (!root || !formulaMeasureEl) return null;
  const src = normalizeLatexForKatex(latex);
  if (!src) return null;
  try {
    const html = katex.renderToString(src, { throwOnError: false, displayMode: false, strict: 'ignore' });
    formulaMeasureEl.style.fontSize = `${Math.max(8, Number(fontSize) || 22)}px`;
    formulaMeasureEl.innerHTML = html;
    const r = formulaMeasureEl.getBoundingClientRect();
    formulaMeasureEl.innerHTML = '';
    const w = Math.max(1, Math.ceil(r.width));
    const h = Math.max(1, Math.ceil(r.height));
    return { w, h };
  } catch {
    formulaMeasureEl.innerHTML = '';
    return null;
  }
};

const applyFormulaCanvasStyle = (obj) => {
  if (!obj) return;
  obj.editable = false;
  if ('fill' in obj) obj.fill = 'rgba(0,0,0,0)';
  if ('backgroundColor' in obj) obj.backgroundColor = 'rgba(0,0,0,0)';
  obj.padding = 0;
  obj.originX = 'left';
  obj.originY = 'top';
};

const setFormulaOverlayVisible = (visible) => {
  if (!formulaOverlayRootEl) return;
  formulaOverlayRootEl.style.opacity = visible ? '1' : '0';
  formulaOverlayRootEl.style.visibility = visible ? 'visible' : 'hidden';
  if (visible && canvas && typeof canvas.requestRenderAll === 'function') {
    canvas.requestRenderAll();
  }
};

const updateFormulaOverlayForObject = (obj) => {
  if (!canvas) return;
  if (!obj || !obj.id) return;
  if (!isFormulaObject(obj)) return;
  const root = ensureFormulaOverlayLayer();
  if (!root) return;
  applyFormulaCanvasStyle(obj);

  const id = obj.id;
  const raw = typeof obj.latex === 'string' ? obj.latex : typeof obj.text === 'string' ? obj.text : '';
  const src = normalizeLatexForKatex(raw);
  const fontSize = Number(obj.formulaFontSize ?? obj.fontSize) || 22;
  const pad = Number(obj.formulaPad ?? obj.__formulaPad) || 0;

  let entry = formulaOverlayMap.get(id);
  if (!entry) {
    const el = document.createElement('div');
    el.style.position = 'absolute';
    el.style.left = '0';
    el.style.top = '0';
    el.style.transformOrigin = '0 0';
    el.style.pointerEvents = 'none';
    el.style.whiteSpace = 'nowrap';
    root.appendChild(el);
    entry = { el, latex: '', fontSize: 0 };
    formulaOverlayMap.set(id, entry);
  }

  if (!src) {
    entry.el.style.display = 'none';
    return;
  }

  entry.el.style.display = 'inline-block';
  entry.el.style.fontSize = `${Math.max(8, fontSize)}px`;
  if (entry.latex !== src || entry.fontSize !== fontSize) {
    try {
      entry.el.innerHTML = katex.renderToString(src, { throwOnError: false, displayMode: false, strict: 'ignore' });
    } catch {
      entry.el.innerHTML = '';
    }
    entry.latex = src;
    entry.fontSize = fontSize;
    const size = measureFormulaSize(src, fontSize);
    if (size) {
      try {
        if (typeof obj.set === 'function') obj.set({ width: size.w + pad * 2, height: size.h + pad * 2 });
        obj.setCoords();
      } catch {
        void 0;
      }
    }
  }

  const vpt = Array.isArray(canvas.viewportTransform) ? canvas.viewportTransform : [1, 0, 0, 1, 0, 0];
  const p = fabric.util.transformPoint(new fabric.Point(Number(obj.left) || 0, Number(obj.top) || 0), vpt);
  const z = typeof canvas.getZoom === 'function' ? canvas.getZoom() : 1;
  const sx = (Number(obj.scaleX) || 1) * (Number(z) || 1);
  const sy = (Number(obj.scaleY) || 1) * (Number(z) || 1);
  const angle = Number(obj.angle) || 0;
  entry.el.style.left = `${p.x}px`;
  entry.el.style.top = `${p.y}px`;
  entry.el.style.transform = `rotate(${angle}deg) scale(${sx}, ${sy}) translate(${pad}px, ${pad}px)`;
};

const syncFormulaOverlays = () => {
  if (!canvas) return;
  const root = ensureFormulaOverlayLayer();
  if (!root) return;
  const objs = typeof canvas.getObjects === 'function' ? canvas.getObjects() : [];
  const alive = new Set();
  for (const obj of objs) {
    if (!obj || !obj.id) continue;
    if (!isFormulaObject(obj)) continue;
    alive.add(obj.id);
    updateFormulaOverlayForObject(obj);
  }
  for (const [id, entry] of formulaOverlayMap.entries()) {
    if (alive.has(id)) continue;
    try {
      if (entry && entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    } catch {
      void 0;
    }
    formulaOverlayMap.delete(id);
  }
};
const formulaRecognizeHint = computed(() => {
  if (isFormulaRecognizing.value) return '识别中…';
  if (isFormulaRecognizeMode.value) return '识别：拖拽框选区域（Esc 取消）';
  return '';
});

// 当前选中的工具：'pencil' (画笔) | 'select' (选择/移动) | 'rect' (矩形) | 'circle' (圆形)
const currentTool = ref('pencil');
// socket 实例由 socketService 管理

/**
 * 从 URL Query 中读取房间号。
 * 设计目的：
 * - 允许多人通过分享链接进入同一房间；
 * - 允许在本机用两个 tab 测试不同房间的隔离性；
 * - 兼容多种参数名，减少后续改动成本。
 */
const getRoomIdFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room') || params.get('roomId') || params.get('r');
  return room && room.trim() ? room.trim() : 'demo-room';
};

// 房间 ID 固定为组件生命周期内常量：本项目的“房间切换”使用刷新页面完成（更简单且稳定）
const ROOM_ID = getRoomIdFromUrl();
// 工具栏输入框：用于生成分享链接/切换房间（切换时会刷新页面）
const roomIdInput = ref(ROOM_ID);
// 标记是否是远程更新，防止回环死锁
let isRemoteUpdate = false;
// 标记是否是撤销/重做操作，防止重复压栈
let isUndoRedo = false;
// 撤销/重做保护期标志与定时器（需模块级共享，供键盘与远程更新共用）
let undoRedoInProgress = false;
let undoRedoTimeout = null;
let isMouseDown = false;
let isErasing = false;
let erasedObjectIdsInStroke = null;
let eraserMoveRafId = 0;
let lastEraserMoveEvent = null;
let suppressNextLocalPathCreated = false;
let suppressNextLocalPathCreatedTimeout = null;

const toFiniteNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const getWorldPointFromClient = (clientX, clientY) => {
  if (!canvas || !canvas.upperCanvasEl) return null;
  const sx = toFiniteNumber(clientX);
  const sy = toFiniteNumber(clientY);
  if (sx === null || sy === null) return null;
  const rect = canvas.upperCanvasEl.getBoundingClientRect();
  const px = sx - rect.left;
  const py = sy - rect.top;
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  const inv = fabric.util.invertTransform(vpt);
  const world = fabric.util.transformPoint(new fabric.Point(px, py), inv);
  const x = toFiniteNumber(world && world.x);
  const y = toFiniteNumber(world && world.y);
  if (x === null || y === null) return null;
  return { x, y };
};

const getScenePointFromEvent = (evt) => {
  if (!canvas) return null;
  if (evt && evt.scenePoint) {
    const x = toFiniteNumber(evt.scenePoint.x);
    const y = toFiniteNumber(evt.scenePoint.y);
    if (x !== null && y !== null) return { x, y };
  }
  if (evt && evt.e && typeof canvas.getScenePoint === 'function') {
    try {
      const p = canvas.getScenePoint(evt.e);
      const x = toFiniteNumber(p && p.x);
      const y = toFiniteNumber(p && p.y);
      if (x !== null && y !== null) return { x, y };
    } catch {}
  }
  if (evt && evt.e && typeof canvas.getPointer === 'function') {
    try {
      const p = canvas.getPointer(evt.e, true);
      const x = toFiniteNumber(p && p.x);
      const y = toFiniteNumber(p && p.y);
      if (x !== null && y !== null) return { x, y };
    } catch {}
  }
  if (evt && evt.e && canvas && canvas.upperCanvasEl) {
    try {
      const rect = canvas.upperCanvasEl.getBoundingClientRect();
      const sx = toFiniteNumber(evt.e.clientX);
      const sy = toFiniteNumber(evt.e.clientY);
      if (sx !== null && sy !== null) {
        const px = sx - rect.left;
        const py = sy - rect.top;
        const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
        const inv = fabric.util.invertTransform(vpt);
        const world = fabric.util.transformPoint(new fabric.Point(px, py), inv);
        const x = toFiniteNumber(world && world.x);
        const y = toFiniteNumber(world && world.y);
        if (x !== null && y !== null) return { x, y };
      }
    } catch {}
  }
  return null;
};

const eraseFabricObject = (obj) => {
  if (!canvas) return;
  if (!obj) return;
  if (obj.__isGhost === true) return;
  if (obj.__draftShape === true) return;
  if (!obj.id) {
    obj.id = generateId();
  }

  if (erasedObjectIdsInStroke && erasedObjectIdsInStroke.has(obj.id)) return;
  if (erasedObjectIdsInStroke) erasedObjectIdsInStroke.add(obj.id);

  canvas.discardActiveObject();
  canvas.remove(obj);
  objectMap.delete(obj.id);
  if (typeof obj.toJSON === 'function') {
    historyManager.push(new RemoveCommand(getAppContext(), obj));
  }
  const crdtState = crdtManager.delete(obj.id);
  if (crdtState) {
    socketService.emit('draw-event', { roomId: ROOM_ID, ...crdtState });
  }
  canvas.requestRenderAll();
};

const eraseTargetsInObject = (target) => {
  if (!target) return;
  if (target.type === 'activeSelection' && typeof target.getObjects === 'function') {
    const arr = target.getObjects();
    if (Array.isArray(arr)) {
      for (const obj of arr) {
        eraseFabricObject(obj);
      }
      return;
    }
  }
  eraseFabricObject(target);
};

const eraseAtPointerEvent = (opt) => {
  if (!canvas) return;
  const pointer = getScenePointFromEvent(opt);
  if (!pointer) return;

  const objects = canvas.getObjects ? canvas.getObjects() : [];
  let hitTarget = null;

  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (!obj || obj.__isGhost === true || obj.__draftShape === true) continue;
    if (typeof obj.containsPoint === 'function' && obj.containsPoint(pointer)) {
      hitTarget = obj;
      break;
    }
    if (typeof obj.isPointInObject === 'function' && obj.isPointInObject(pointer.x, pointer.y)) {
      hitTarget = obj;
      break;
    }
    const br = typeof obj.getBoundingRect === 'function' ? obj.getBoundingRect(true, true) : null;
    if (br && pointer.x >= br.left && pointer.x <= br.left + br.width && pointer.y >= br.top && pointer.y <= br.top + br.height) {
      if (obj.type !== 'activeSelection') {
        hitTarget = obj;
        break;
      }
    }
  }

  if (hitTarget) {
    eraseTargetsInObject(hitTarget);
  }
};

const scheduleEraseAtMove = (opt) => {
  lastEraserMoveEvent = opt;
  if (eraserMoveRafId) return;
  eraserMoveRafId = requestAnimationFrame(() => {
    eraserMoveRafId = 0;
    const ev = lastEraserMoveEvent;
    lastEraserMoveEvent = null;
    if (!isErasing) return;
    if (!ev) return;
    eraseAtPointerEvent(ev);
  });
};

// --- 视图交互：平移/缩放 (Pan & Zoom) ---
// 目标：每个客户端都可以自由漫游自己的视图（不影响协同数据，只改变本地 viewportTransform）
let panKeyPressed = false; // 是否按住空格（按住空格拖拽平移）
let isPanning = false; // 是否正在拖拽平移中
let lastPanClientX = 0;
let lastPanClientY = 0;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
let viewportStatsRafId = null;
let lastViewportStats = {
  totalObjects: 0,
  visibleObjects: 0,
  culledObjects: 0,
  computeMs: 0
};

const getWorldViewportRect = () => {
  if (!canvas) return { left: 0, top: 0, right: 0, bottom: 0, zoom: 1 };
  const zoom = canvas.getZoom ? canvas.getZoom() : 1;
  const w = typeof canvas.getWidth === 'function' ? canvas.getWidth() : window.innerWidth;
  const h = typeof canvas.getHeight === 'function' ? canvas.getHeight() : window.innerHeight;
  const vpt = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  const inv = fabric.util.invertTransform(vpt);
  const p0 = fabric.util.transformPoint(new fabric.Point(0, 0), inv);
  const p1 = fabric.util.transformPoint(new fabric.Point(w, h), inv);
  const left = Math.min(p0.x, p1.x);
  const right = Math.max(p0.x, p1.x);
  const top = Math.min(p0.y, p1.y);
  const bottom = Math.max(p0.y, p1.y);
  return { left, top, right, bottom, zoom };
};

const rectIntersects = (a, b) =>
  a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;

const computeViewportCullingStats = () => {
  if (!canvas) {
    lastViewportStats = { totalObjects: 0, visibleObjects: 0, culledObjects: 0, computeMs: 0 };
    return lastViewportStats;
  }
  const t0 = performance.now();
  const vp = getWorldViewportRect();
  const marginWorld = 200 / (vp.zoom || 1);
  const expandedVp = {
    left: vp.left - marginWorld,
    top: vp.top - marginWorld,
    right: vp.right + marginWorld,
    bottom: vp.bottom + marginWorld
  };

  const objs = typeof canvas.getObjects === 'function' ? canvas.getObjects() : [];
  let total = 0;
  let visible = 0;
  for (const obj of objs) {
    if (!obj) continue;
    if (obj.__isGhost === true) continue;
    if (obj.__draftShape === true) continue;
    total += 1;
    const br = typeof obj.getBoundingRect === 'function' ? obj.getBoundingRect(true, true) : null;
    if (!br) {
      visible += 1;
      continue;
    }
    const r = { left: br.left, top: br.top, right: br.left + br.width, bottom: br.top + br.height };
    if (rectIntersects(r, expandedVp)) {
      visible += 1;
    }
  }
  const t1 = performance.now();
  lastViewportStats = {
    totalObjects: total,
    visibleObjects: visible,
    culledObjects: Math.max(0, total - visible),
    computeMs: t1 - t0
  };
  return lastViewportStats;
};

const scheduleViewportStatsUpdate = () => {
  if (!renderPerfMode) return;
  if (viewportStatsRafId) return;
  viewportStatsRafId = requestAnimationFrame(() => {
    viewportStatsRafId = null;
    computeViewportCullingStats();
  });
};

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createSeededRng = (seed) => {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const clearCanvasForPerf = () => {
  if (!canvas) return;
  try {
    canvas.discardActiveObject();
  } catch {
    void 0;
  }
  const objs = typeof canvas.getObjects === 'function' ? canvas.getObjects().slice() : [];
  for (const obj of objs) {
    try {
      canvas.remove(obj);
    } catch {
      void 0;
    }
  }
  canvas.requestRenderAll();
  objectMap.clear();
  historyManager.reset();
  crdtManager.reset();
};

const generatePerfSceneObjects = async ({ count, worldSize, seed }) => {
  if (!canvas) return { added: 0 };
  const rng = createSeededRng(seed);
  const prev = canvas.renderOnAddRemove;
  canvas.renderOnAddRemove = false;
  let added = 0;

  for (let i = 0; i < count; i += 1) {
    const x = Math.floor(rng() * worldSize);
    const y = Math.floor(rng() * worldSize);
    const w = 20 + Math.floor(rng() * 60);
    const h = 20 + Math.floor(rng() * 60);
    const fill = `hsl(${Math.floor(rng() * 360)}, 65%, 60%)`;
    const obj = new fabric.Rect({
      left: x,
      top: y,
      width: w,
      height: h,
      fill,
      stroke: 'rgba(0,0,0,0.08)',
      strokeWidth: 1,
      selectable: false,
      evented: false
    });
    obj.__fromRemote = true;
    applyRenderPerfDefaultsToObject(obj);
    canvas.add(obj);
    delete obj.__fromRemote;
    added += 1;
  }

  canvas.renderOnAddRemove = prev;
  canvas.requestRenderAll();
  await sleepMs(50);
  return { added };
};

const runCanvasPerfLoop = async ({ durationMs, step }) => {
  if (!canvas) return { samples: [] };
  let rafId = null;
  let running = true;

  let lastSecondAt = performance.now();
  let frameCount = 0;
  let renderStartAt = 0;
  let renderSum = 0;
  let renderCount = 0;
  let renderMax = 0;
  let lastElapsed = 0;

  const samples = [];

  const beforeRender = () => {
    renderStartAt = performance.now();
  };
  const afterRender = () => {
    const d = performance.now() - renderStartAt;
    renderSum += d;
    renderCount += 1;
    renderMax = Math.max(renderMax, d);
  };

  canvas.on('before:render', beforeRender);
  canvas.on('after:render', afterRender);

  const startAt = performance.now();

  const tick = (t) => {
    if (!running) return;
    const elapsed = t - startAt;
    lastElapsed = elapsed;
    if (elapsed >= durationMs) {
      running = false;
      return;
    }

    frameCount += 1;
    if (typeof step === 'function') step(t, elapsed);
    canvas.requestRenderAll();

    const dt = t - lastSecondAt;
    if (dt >= 1000) {
      const fps = (frameCount * 1000) / dt;
      const vpStats = computeViewportCullingStats();
      const avgRenderMs = renderCount ? renderSum / renderCount : 0;
      samples.push({
        tMs: Math.round(elapsed),
        fps,
        avgRenderMs,
        maxRenderMs: renderMax,
        totalObjects: vpStats.totalObjects,
        visibleObjects: vpStats.visibleObjects,
        culledObjects: vpStats.culledObjects,
        cullComputeMs: vpStats.computeMs
      });
      frameCount = 0;
      renderSum = 0;
      renderCount = 0;
      renderMax = 0;
      lastSecondAt = t;
    }

    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);

  const endAt = startAt + durationMs + 200;
  while (running && performance.now() < endAt) {
    await sleepMs(50);
  }

  if (rafId) cancelAnimationFrame(rafId);
  const finalDt = performance.now() - lastSecondAt;
  if (finalDt > 0 && (frameCount > 0 || renderCount > 0)) {
    const fps = (frameCount * 1000) / finalDt;
    const vpStats = computeViewportCullingStats();
    const avgRenderMs = renderCount ? renderSum / renderCount : 0;
    samples.push({
      tMs: Math.round(Math.min(durationMs, lastElapsed)),
      fps,
      avgRenderMs,
      maxRenderMs: renderMax,
      totalObjects: vpStats.totalObjects,
      visibleObjects: vpStats.visibleObjects,
      culledObjects: vpStats.culledObjects,
      cullComputeMs: vpStats.computeMs
    });
  }
  canvas.off('before:render', beforeRender);
  canvas.off('after:render', afterRender);

  return { samples };
};

const runRenderPerfBenchmark = async () => {
  if (!canvas) return null;
  const countRaw = getUrlParam('perfObjects');
  const worldRaw = getUrlParam('perfWorld');
  const seedRaw = getUrlParam('perfSeed');
  const objectCount = countRaw && Number.isFinite(Number(countRaw)) ? Math.max(100, Math.floor(Number(countRaw))) : 5000;
  const worldSize = worldRaw && Number.isFinite(Number(worldRaw)) ? Math.max(2000, Math.floor(Number(worldRaw))) : 6000;
  const seed = seedRaw && Number.isFinite(Number(seedRaw)) ? Math.floor(Number(seedRaw)) : 42;

  clearCanvasForPerf();
  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.setZoom(1);
  canvas.requestRenderAll();
  await sleepMs(50);

  const scene = await generatePerfSceneObjects({ count: objectCount, worldSize, seed });

  const runOne = async (mode) => {
    renderPerfOverride = mode === 'baseline'
      ? { skipOffscreen: false, objectCaching: false }
      : { skipOffscreen: true, objectCaching: true };
    applyRenderPerfConfigToCanvas();
    const objs = typeof canvas.getObjects === 'function' ? canvas.getObjects() : [];
    for (const obj of objs) {
      applyRenderPerfDefaultsToObject(obj);
    }
    canvas.requestRenderAll();
    await sleepMs(80);

    const idle = await runCanvasPerfLoop({ durationMs: 2500 });
    const pan = await runCanvasPerfLoop({
      durationMs: 2500,
      step: () => {
        const vpt = canvas.viewportTransform;
        if (!vpt) return;
        vpt[4] -= 2.2;
        vpt[5] -= 1.4;
        canvas.setViewportTransform(vpt);
      }
    });
    const zoom = await runCanvasPerfLoop({
      durationMs: 2500,
      step: (t) => {
        const z = 0.7 + 0.6 * (0.5 + 0.5 * Math.sin(t / 260));
        const center = canvas.getCenter();
        canvas.zoomToPoint(new fabric.Point(center.left, center.top), z);
      }
    });

    return { mode, phases: { idle, pan, zoom } };
  };

  const baseline = await runOne('baseline');
  const optimized = await runOne('optimized');

  renderPerfOverride = null;
  applyRenderPerfConfigToCanvas();

  const report = {
    kind: 'quickboard-render-perf',
    createdAt: new Date().toISOString(),
    params: { objectCount, worldSize, seed },
    scene,
    results: { baseline, optimized }
  };

  try {
    window.__qbRenderPerfReport = report;
  } catch {
    void 0;
  }
  console.log(`QB_RENDER_PERF_REPORT:${JSON.stringify(report)}`);
  return report;
};

// 生成唯一ID
const generateId = () => crypto.randomUUID();

let fabricSerializationPatched = false;
const patchFabricSerialization = () => {
  if (fabricSerializationPatched) return;
  const BaseObject = fabric.FabricObject || fabric.Object;
  if (!BaseObject || !BaseObject.prototype) return;
  const originalToObject = BaseObject.prototype.toObject;
  if (typeof originalToObject !== 'function') return;

  BaseObject.prototype.toObject = function (propertiesToInclude) {
    const base = originalToObject.call(this, propertiesToInclude);
    if (this.id) base.id = this.id;
    if (this.excludeFromExport === true) base.excludeFromExport = true;
    if (this.__isGhost === true) base.__isGhost = true;
    if (this.isFormula === true) base.isFormula = true;
    if (typeof this.latex === 'string') base.latex = this.latex;
    if (typeof this.formulaFontSize === 'number') base.formulaFontSize = this.formulaFontSize;
    if (typeof this.formulaPad === 'number') base.formulaPad = this.formulaPad;
    return base;
  };
  fabricSerializationPatched = true;
};

// --- 辅助：创建 App 上下文对象，供 Command 使用 ---
const getAppContext = () => ({
  canvas,
  objectMap,
  roomId: ROOM_ID,
  socketService,
  crdtManager // 增加这一行，传递 crdtManager
});

// --- 生命周期：挂载 ---
onMounted(() => {
  patchFabricSerialization();
  netSimConfig.value = socketService.initNetworkSimulation();
  netSimStats.value = socketService.getNetworkSimulationStats();
  if (netSimConfig.value && netSimConfig.value.enabled === true) {
    netSimPollTimer = setInterval(() => {
      netSimStats.value = socketService.getNetworkSimulationStats();
    }, 600);
  }

  // 1. 初始化 Fabric Canvas
  const fabricCanvas = new fabric.Canvas(canvasEl.value, {
    isDrawingMode: true, // 默认开启自由绘图模式
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: 'rgba(255,255,255,0)',
  });
  canvas = fabricCanvas;
  applyRenderPerfConfigToCanvas();
  if (isDev) {
    window.__canvas = canvas;
  }
  ensureFormulaOverlayLayer();
  canvas.on('after:render', syncFormulaOverlays);

  // 2. 配置画笔样式
  const brush = new fabric.PencilBrush(canvas);
  brush.width = 5;
  brush.color = '#000000';
  canvas.freeDrawingBrush = brush;

  toolRingHostEl = canvasEl.value && canvasEl.value.parentElement ? canvasEl.value.parentElement : null;
  if (toolRingHostEl) {
    const host = toolRingHostEl;

    const onContextMenu = (e) => {
      if (!e) return;
      e.preventDefault();
    };

    const onPointerDown = (e) => {
      if (!e) return;

      if (e.pointerType === 'mouse' && e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        clearToolRingTimers();
        toolRingActivePointerId = e.pointerId;
        if (typeof host.setPointerCapture === 'function') {
          try {
            host.setPointerCapture(e.pointerId);
          } catch {
            void 0;
          }
        }
        openToolRingAtClientPoint(e.clientX, e.clientY);
        updateToolRingHoverByClientPoint(e.clientX, e.clientY);
        return;
      }

      if (e.pointerType === 'touch' && e.isPrimary === true) {
        clearToolRingTimers();
        toolRingLongPressStart = {
          pointerId: e.pointerId,
          x: e.clientX,
          y: e.clientY
        };
        toolRingLongPressTimer = setTimeout(() => {
          if (!toolRingLongPressStart) return;
          toolRingActivePointerId = toolRingLongPressStart.pointerId;
          if (typeof host.setPointerCapture === 'function') {
            try {
              host.setPointerCapture(toolRingActivePointerId);
            } catch {
              void 0;
            }
          }
          openToolRingAtClientPoint(toolRingLongPressStart.x, toolRingLongPressStart.y);
          updateToolRingHoverByClientPoint(toolRingLongPressStart.x, toolRingLongPressStart.y);
        }, 420);
      }
    };

    const onPointerMove = (e) => {
      if (!e) return;
      if (toolRingLongPressStart && e.pointerId === toolRingLongPressStart.pointerId) {
        const dx = e.clientX - toolRingLongPressStart.x;
        const dy = e.clientY - toolRingLongPressStart.y;
        if (Math.sqrt(dx * dx + dy * dy) > 12) {
          if (toolRingLongPressTimer) {
            clearTimeout(toolRingLongPressTimer);
            toolRingLongPressTimer = null;
          }
          toolRingLongPressStart = null;
        }
      }

      if (toolRingActivePointerId != null && e.pointerId === toolRingActivePointerId) {
        updateToolRingHoverByClientPoint(e.clientX, e.clientY);
        scheduleToolRingAutoClose();
      }
    };

    const onPointerUp = (e) => {
      if (!e) return;
      if (toolRingLongPressTimer) {
        clearTimeout(toolRingLongPressTimer);
        toolRingLongPressTimer = null;
      }
      toolRingLongPressStart = null;

      if (toolRingActivePointerId != null && e.pointerId === toolRingActivePointerId) {
        const key = toolRingHoverKey.value;
        if (key) {
          clickToolRingItemByKey(key);
        } else {
          closeToolRing();
        }
      }
      toolRingActivePointerId = null;
    };

    const onPointerCancel = () => {
      clearToolRingTimers();
      toolRingActivePointerId = null;
      closeToolRing();
    };

    const onDocContextMenu = (e) => {
      if (!e) return;
      if (toolRingActivePointerId != null || toolRingVisible.value === true) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    host.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('contextmenu', onDocContextMenu, true);
    host.addEventListener('pointerdown', onPointerDown, true);
    host.addEventListener('pointermove', onPointerMove, true);
    host.addEventListener('pointerup', onPointerUp, true);
    host.addEventListener('pointercancel', onPointerCancel, true);

    toolRingDetach = () => {
      host.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('contextmenu', onDocContextMenu, true);
      host.removeEventListener('pointerdown', onPointerDown, true);
      host.removeEventListener('pointermove', onPointerMove, true);
      host.removeEventListener('pointerup', onPointerUp, true);
      host.removeEventListener('pointercancel', onPointerCancel, true);
    };
  }

  // 3. 监听窗口大小改变
  window.addEventListener('resize', handleResize);

  // 6. 监听键盘事件 (删除、撤销、重做)
  window.addEventListener('keydown', handleKeydown);
  window.addEventListener('keyup', handleKeyup);

  // 撤销/重做保护机制变量已在模块级定义，确保各处理函数共享

  // 监听选择/变换开始，记录初始状态
  canvas.on('before:transform', (e) => {
    const obj = e.transform && e.transform.target;
    if (obj) {
      transformStartObjectId = obj.id || null;
      obj.clone().then((cloned) => {
        transformStartData = cloned.toJSON();
      });
    }
  });

  canvas.on('selection:created', refreshSelectedFormula);
  canvas.on('selection:updated', refreshSelectedFormula);
  canvas.on('selection:cleared', refreshSelectedFormula);
  canvas.on('selection:created', syncActiveObjectCaching);
  canvas.on('selection:updated', syncActiveObjectCaching);
  canvas.on('selection:cleared', syncActiveObjectCaching);

  // 鼠标滚轮缩放（只影响本地视图，不影响协同数据）
  canvas.on('mouse:wheel', handleCanvasMouseWheel);
  // 双击复位视图（只影响本地视图）
  canvas.on('mouse:dblclick', handleCanvasDoubleClick);

  // 5. 监听鼠标移动 (发送光标位置)
  canvas.on('mouse:move', (e) => {
    if (isFormulaRecognizeMode.value === true) {
      return;
    }
    // 正在平移时：只处理平移，不发送光标/实时绘制消息（避免无意义的网络噪声）
    if (isPanning) {
      handleCanvasPanMove(e);
      return;
    }
    // 按住空格进入“视图漫游”语义：不发送协同光标/绘制过程消息
    if (panKeyPressed) {
      return;
    }

    if (currentTool.value === 'eraser') {
      if (e && e.e && typeof e.e.clientX === 'number') {
        eraserCursorClientX.value = e.e.clientX;
        eraserCursorClientY.value = e.e.clientY;
      }
      if (canvas && canvas.upperCanvasEl && canvas.upperCanvasEl.style) {
        if (canvas.upperCanvasEl.style.cursor !== QB_CURSOR_ERASER) {
          canvas.upperCanvasEl.style.cursor = QB_CURSOR_ERASER;
        }
      }
      if (isErasing) {
        scheduleEraseAtMove(e);
      }
    }

    const pointer =
      getScenePointFromEvent(e) || (e && e.e ? getWorldPointFromClient(e.e.clientX, e.e.clientY) : null);
    if (!pointer) return;

    pendingCursorPoint = pointer;
    scheduleCursorSend();

    // 2. 发送实时绘图路径 (如果正在绘图)
    // 调试：打印状态
    // console.log('Move:', canvas.isDrawingMode, isMouseDown, e.e.buttons);

    if (canvas.isDrawingMode && (isMouseDown || e.e.buttons === 1)) {
      // console.log('✏️ Emit drawing:', pointer.x, pointer.y);
      ghostBrushSender.enqueuePoint(pointer.x, pointer.y);
    }
  });

  // 手动追踪鼠标按键状态
  canvas.on('mouse:down', (e) => {
    if (e && e.e && typeof e.e.button === 'number' && e.e.button === 2) {
      isMouseDown = false;
      return;
    }

    if (currentTool.value === 'eraser') {
      isErasing = true;
      erasedObjectIdsInStroke = new Set();
      eraseAtPointerEvent(e);
      isMouseDown = false;
      return;
    }

    if (currentTool.value === 'rect' || currentTool.value === 'circle') {
      const p = getScenePointFromEvent(e);
      if (p) {
        beginShapeDraft(currentTool.value, p);
      }
      isMouseDown = false;
      return;
    }

    isMouseDown = true;
    // 如果本次 mouse down 用于平移视图，则不认为“正在绘图按下”
    if (handleCanvasPanStart(e)) {
      isMouseDown = false;
    }
  });
  canvas.on('mouse:up', (e) => {
    if (currentTool.value === 'eraser') {
      isErasing = false;
      if (erasedObjectIdsInStroke) erasedObjectIdsInStroke.clear();
      erasedObjectIdsInStroke = null;
      if (eraserMoveRafId) {
        cancelAnimationFrame(eraserMoveRafId);
        eraserMoveRafId = 0;
      }
      lastEraserMoveEvent = null;
      return;
    }
    if (currentTool.value === 'rect' || currentTool.value === 'circle') {
      commitShapeDraft();
      return;
    }
    isMouseDown = false;
    handleCanvasPanEnd(e);
  });

  canvas.on('mouse:move', (e) => {
    if (currentTool.value === 'rect' || currentTool.value === 'circle') {
      const p = getScenePointFromEvent(e);
      if (p) updateShapeDraft(p);
    }
  });

  canvas.on('mouse:down', handleFormulaRecognizeMouseDown);
  canvas.on('mouse:move', handleFormulaRecognizeMouseMove);
  canvas.on('mouse:up', handleFormulaRecognizeMouseUp);

  // 监听绘图结束，发送一个结束信号 (Ghost Brush)
  canvas.on('path:created', (e) => {
    // 自由画笔路径在某些版本下 object:added 时机不稳定，这里在 path:created 明确入栈与广播
    const pathObj = e && (e.path || e.target);
    // 跳过远端创建的对象：远端不应该再给“更远端”发送自己的 Ghost End
    if (pathObj && pathObj.__fromRemote === true) return;

    // 仅用于结束远程的 Ghost 绘制状态（本地用户画完一笔时发送）
    // 注意：这里会先 flush 一次缓存点，避免“尾点还在队列里没来得及发”就直接 isEnd 导致远端断笔
    ghostBrushSender.endStroke();

    if (!pathObj) return;

    // 确保有 ID
    if (!pathObj.id) {
      pathObj.id = generateId();
    }
    applyRenderPerfDefaultsToObject(pathObj);

    // 记录到 Map，方便后续撤销查找
    objectMap.set(pathObj.id, pathObj);
    scheduleViewportStatsUpdate();

    const rollbackLocalCreatedPath = () => {
      canvas.remove(pathObj);
      objectMap.delete(pathObj.id);
      canvas.requestRenderAll();

      const crdtState = crdtManager.delete(pathObj.id);
      if (crdtState) {
        socketService.emit('draw-event', {
          roomId: ROOM_ID,
          ...crdtState
        });
      }
    };

    if (suppressNextLocalPathCreated) {
      suppressNextLocalPathCreated = false;
      if (suppressNextLocalPathCreatedTimeout) {
        clearTimeout(suppressNextLocalPathCreatedTimeout);
        suppressNextLocalPathCreatedTimeout = null;
      }
      rollbackLocalCreatedPath();
      return;
    }

    if (undoRedoInProgress || isUndoRedo) {
      rollbackLocalCreatedPath();
      return;
    }

    historyManager.push(new AddCommand(getAppContext(), pathObj));

    const crdtState = crdtManager.localUpdate(pathObj.id, pathObj.toJSON());
    socketService.emit('draw-event', {
      roomId: ROOM_ID,
      ...crdtState
    });
  });

  // 'object:added' 是任何对象(包括画笔路径、矩形、圆形)被添加到 Canvas 时触发
  canvas.on('object:added', (e) => {
    const obj = e.target;
    if (!obj) return;
    if (obj.__isGhost === true) {
      return;
    }
    if (obj.__draftShape === true) {
      return;
    }
    // 避免将远程添加的对象误判为本地操作（由 handleRemoteUpdate 标记）
    if (obj.__fromRemote === true) {
      return;
    }
    // 自由画笔路径改由 path:created 负责入栈/广播，避免双重入栈
    if (obj.type === 'path') {
      return;
    }

    if (currentTool.value === 'eraser') {
      if (!eraserHoverCursorBackup) eraserHoverCursorBackup = new WeakMap();
      if (!eraserHoverCursorBackup.has(obj)) {
        eraserHoverCursorBackup.set(obj, obj.hoverCursor);
      }
      obj.hoverCursor = QB_CURSOR_ERASER;
      obj.moveCursor = QB_CURSOR_ERASER;
    }

    // 1. 分配 ID (如果还没有)
    if (!obj.id) {
      obj.id = generateId();
    }
    applyRenderPerfDefaultsToObject(obj);

    // 2. 存入 Map
    objectMap.set(obj.id, obj);
    scheduleViewportStatsUpdate();

    // [关键修复] 如果是撤销/重做操作触发的添加，不要记录到历史记录中
    if (isUndoRedo) {
      // 撤销/重做操作只需要发送CRDT更新，不需要记录到历史记录
      const crdtState = crdtManager.localUpdate(obj.id, obj.toJSON());
      socketService.emit('draw-event', {
        roomId: ROOM_ID,
        ...crdtState
      });
      return;
    }

    // 3. [History] 记录添加操作（正常的用户操作）
    // 对于 Path 对象，我们需要特别小心，它的 toJSON 有时会丢失信息
    // 最好是在下一个 tick 记录，或者确信它已经 ready
    historyManager.push(new AddCommand(getAppContext(), obj));

    // 4. CRDT 处理与广播
    const crdtState = crdtManager.localUpdate(obj.id, obj.toJSON());
    socketService.emit('draw-event', {
      roomId: ROOM_ID,
      ...crdtState
    });
  });

  let transformStartData = null;
  let transformStartObjectId = null;

  canvas.on('object:modified', (e) => {
    if (isRemoteUpdate) return;

    const obj = e.target;
    if (!obj.id) return;
    const isUserTransform =
      !!e.transform &&
      !!e.transform.target &&
      transformStartObjectId === obj.id &&
      !!transformStartData;

    if (!isUserTransform && !isUndoRedo) {
      transformStartData = null;
      transformStartObjectId = null;
      return;
    }

    // [关键修复] 如果是撤销/重做操作触发的修改，不要记录到历史记录中
    // 但仍然需要发送CRDT更新以保持同步
    if (isUndoRedo) {
      // 撤销/重做操作只需要发送CRDT更新，不需要记录到历史记录
      const crdtState = crdtManager.localUpdate(obj.id, obj.toJSON());
      socketService.emit('draw-event', {
        roomId: ROOM_ID,
        ...crdtState
      });
      transformStartData = null;
      transformStartObjectId = null;
      return;
    }

    // [History] 记录修改操作（正常的用户操作）
    if (transformStartData) {
      historyManager.push(new ModifyCommand(getAppContext(), obj, transformStartData, obj.toJSON()));
    }
    transformStartData = null;
    transformStartObjectId = null;

    const crdtState = crdtManager.localUpdate(obj.id, obj.toJSON());
    socketService.emit('draw-event', {
      roomId: ROOM_ID,
      ...crdtState
    });
  });

  // 6. 初始化 Socket 连接 (移到最后，确保 canvas 已就绪)
  if (renderPerfMode) {
    connectionState.value = 'disconnected';
    void runRenderPerfBenchmark();
  } else {
    initSocket();
  }
});


// --- 生命周期：卸载 ---
onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('keyup', handleKeyup);
  if (typeof toolRingDetach === 'function') {
    toolRingDetach();
    toolRingDetach = null;
  }
  clearToolRingTimers();
  if (netSimPollTimer) {
    clearInterval(netSimPollTimer);
    netSimPollTimer = null;
  }
  if (viewportStatsRafId) {
    cancelAnimationFrame(viewportStatsRafId);
    viewportStatsRafId = null;
  }
  if (eraserMoveRafId) {
    cancelAnimationFrame(eraserMoveRafId);
    eraserMoveRafId = 0;
  }
  if (remoteCursorRafId) {
    cancelAnimationFrame(remoteCursorRafId);
    remoteCursorRafId = 0;
  }
  if (cursorSendRafId) {
    cancelAnimationFrame(cursorSendRafId);
    cursorSendRafId = 0;
  }
  ghostBrushSender.dispose();
  cancelFormulaRecognize();
  void closeFormulaEditor(true);
  try {
    if (formulaOverlayRootEl && formulaOverlayRootEl.parentNode) {
      formulaOverlayRootEl.parentNode.removeChild(formulaOverlayRootEl);
    }
  } catch {
    void 0;
  }
  formulaOverlayRootEl = null;
  formulaMeasureEl = null;
  formulaOverlayMap.clear();
  if (canvas) canvas.dispose();
  socketService.disconnect();
});

const handleLockState = (payload) => {
  if (!payload || payload.roomId !== ROOM_ID) return;
  const next = {};
  const locks = Array.isArray(payload.locks) ? payload.locks : [];
  locks.forEach((l) => {
    if (!l || !l.resourceId) return;
    next[l.resourceId] = {
      resourceId: l.resourceId,
      ownerId: l.ownerId,
      ownerName: l.ownerName || '',
      expiresAt: l.expiresAt
    };
  });
  lockState.value = next;
};

// --- 方法：Socket 初始化 ---
const initSocket = () => {
  connectionState.value = 'connecting';

  // Socket.IO 内部具备自动重连机制，这里只做状态映射用于 UI 告知用户“当前是否在线”
  socketService.on('connect', () => {
    connectionState.value = 'connected';
    mySocketId.value = socketService.getSocketId();
    upsertOnlineUser(mySocketId.value, myName.value);
    // 连接/重连成功后，清理上一次断线残留的“临时 UI 状态”（远程光标/ghost 预览线）
    // 原因：断线期间无法收到 user-left / drawing-end 等事件，可能导致本地残留“幽灵光标/幽灵线”。
    cleanupEphemeralState();
  });
  socketService.on('disconnect', () => {
    connectionState.value = 'disconnected';
    // 断线时也主动清掉临时层，避免用户误以为远端还在线、还在绘制
    cleanupEphemeralState();
    lockState.value = {};
    selectedFormulaObjectId.value = null;
    void closeFormulaEditor(false);
  });
  socketService.on('connect_error', () => {
    connectionState.value = 'disconnected';
  });

  // 监听：CRDT 远程更新
  socketService.on('draw-event', (crdtState) => {
    // console.log('📩 Received CRDT update:', crdtState);
    if (crdtState && typeof crdtState.serverEpoch === 'string' && crdtState.serverEpoch) {
      applyServerEpoch(crdtState.serverEpoch);
    }
    if (crdtState && typeof crdtState.serverVersion === 'number' && Number.isFinite(crdtState.serverVersion)) {
      const sv = Math.floor(crdtState.serverVersion);
      lastServerVersion = Math.max(lastServerVersion, sv);
      socketService.setClientVersion(lastServerVersion);
    }
    handleRemoteUpdate(crdtState);
  });

  // 监听：全量同步 (Initial Sync)
  socketService.on('sync-state', (payload) => {
    if (payload && typeof payload === 'object' && payload.roomId && payload.roomId !== ROOM_ID) return;
    const allObjects = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.objects) ? payload.objects : []);
    const tombstones = payload && Array.isArray(payload.tombstones) ? payload.tombstones : [];
    if (payload && typeof payload.serverEpoch === 'string' && payload.serverEpoch) {
      applyServerEpoch(payload.serverEpoch);
    }
    const sv = payload && typeof payload.serverVersion === 'number' && Number.isFinite(payload.serverVersion)
      ? Math.floor(payload.serverVersion)
      : null;
    if (typeof sv === 'number') {
      lastServerVersion = currentServerEpoch ? Math.max(lastServerVersion, sv) : sv;
      socketService.setClientVersion(lastServerVersion);
    }
    const reason = payload && typeof payload.reason === 'string' ? payload.reason : '';
    console.log(
      '📦 Received sync state:',
      allObjects.length,
      'objects,',
      tombstones.length,
      'tombstones',
      reason ? `(reason=${reason})` : ''
    );
    // 初次同步/重连同步都是“服务端快照 + 后续增量”的模型：服务端只发存活对象，
    // 本地如果曾记录 tombstone（_deleted），不会因为快照缺少 _deleted 字段而被复活。
    // 同时：为了让漏掉“删除事件”的客户端也能收敛，快照里还会包含 tombstones（只带 _deleted）。
    // 遍历所有状态，逐个合并（先应用存活对象，再应用 tombstones，让删除在 LWW 里自然获胜）
    const allStates = allObjects.concat(tombstones);
    allStates.forEach(state => {
      // 由于 enlivenObjects 是异步的，为了保证顺序和性能，这里可以优化
      // 但 MVP 阶段逐个调用也无妨
      handleRemoteUpdate(state);
    });
  });

  // 监听：断线重连后的“增量补包”
  socketService.on('sync-delta', (payload) => {
    if (!payload || payload.roomId !== ROOM_ID) return;
    if (typeof payload.serverEpoch === 'string' && payload.serverEpoch) {
      applyServerEpoch(payload.serverEpoch);
    }
    const deltas = Array.isArray(payload.deltas) ? payload.deltas : [];
    deltas.forEach((d) => {
      if (!d || !d.id) return;
      const sv = typeof d.v === 'number' && Number.isFinite(d.v) ? Math.floor(d.v) : null;
      if (typeof sv === 'number') {
        lastServerVersion = Math.max(lastServerVersion, sv);
        socketService.setClientVersion(lastServerVersion);
      }
      handleRemoteUpdate({ id: d.id, data: d.data, timestamps: d.timestamps });
    });

    const toV = typeof payload.toVersion === 'number' && Number.isFinite(payload.toVersion) ? Math.floor(payload.toVersion) : null;
    if (typeof toV === 'number') {
      lastServerVersion = Math.max(lastServerVersion, toV);
      socketService.setClientVersion(lastServerVersion);
    }
  });

  // 监听：房间在线成员快照
  // - join-room 之后服务端会立刻 emit 一次 room-users，让新加入者能立刻看到成员列表
  // - 这个快照不影响 CRDT，只用于 UI 展示（“谁在线、昵称是什么”）
  socketService.on('room-users', (payload) => {
    if (!payload || payload.roomId !== ROOM_ID) return;
    const arr = Array.isArray(payload.users) ? payload.users : [];
    const next = {};
    arr.forEach((u) => {
      if (!u || !u.userId) return;
      next[u.userId] = { userId: u.userId, userName: u.userName || '' };
    });
    onlineUsers.value = next;
  });

  // 监听：用户改名
  socketService.on('user-name', (data) => {
    if (!data || !data.userId) return;
    upsertOnlineUser(data.userId, data.userName || '');
    const cursor = remoteCursorMap.get(data.userId);
    if (cursor) {
      updateRemoteCursorLabel(cursor, data.userId, data.userName || '');
      if (canvas) canvas.requestRenderAll();
    }
  });

  // 监听：用户加入
  socketService.on('user-joined', (data) => {
    if (!data || !data.userId) return;
    upsertOnlineUser(data.userId, data.userName || '');
  });

  // 监听：光标移动
  socketService.on('cursor-move', (data) => {
    // console.log('🖱️ Cursor move:', data.userId, data.x, data.y); // 调试日志
    updateRemoteCursor(data);
    if (data && data.userId) {
      upsertOnlineUser(data.userId, data.userName || '');
    }
  });

  // 监听：实时绘图 (Ghost Brush)
  socketService.on('drawing-process', (data) => {
    // console.log('👻 Ghost drawing:', data.userId, data.x, data.y);
    renderGhostPath(data);
  });

  // 监听：用户离开
  socketService.on('user-left', (data) => {
    if (!data || !data.userId) return;
    removeRemoteCursor(data.userId);
    removeOnlineUser(data.userId);
  });

  socketService.on('room-cleared', (data) => {
    if (!data || data.roomId !== ROOM_ID) return;
    const by = typeof data.by === 'string' ? data.by : '';
    const me = socketService.getSocketId();
    applyRoomClear();
    if (by && me && by === me) {
      pushToast('success', '房间已重置：云端存档已清除，撤销栈已清空', 4200);
    } else {
      pushToast('warning', '房间已被重置：所有人已清空并重置撤销栈', 4200);
    }
  });

  socketService.on('lock-state', (payload) => {
    handleLockState(payload);
  });

  // 连接后端服务器并加入房间
  socketService.connect({ roomId: ROOM_ID, userName: myName.value });
};

/**
 * 统一执行“房间被清空”的本地收敛逻辑。
 * 为什么需要单独封装？
 * - 该操作不是普通的“删对象”，而是“重置房间状态”（包含 CRDT/History/临时 UI 状态）
 * - 该操作可能来自本地点击，也可能来自远端广播，逻辑应完全一致
 */
const applyRoomClear = () => {
  lastServerVersion = 0;
  socketService.setClientVersion(0);
  lockState.value = {};
  selectedFormulaObjectId.value = null;
  void closeFormulaEditor(true);

  if (undoRedoTimeout) {
    clearTimeout(undoRedoTimeout);
    undoRedoTimeout = null;
  }
  if (suppressNextLocalPathCreatedTimeout) {
    clearTimeout(suppressNextLocalPathCreatedTimeout);
    suppressNextLocalPathCreatedTimeout = null;
  }

  undoRedoInProgress = false;
  isUndoRedo = false;
  suppressNextLocalPathCreated = false;
  isMouseDown = false;

  // 清理 Ghost Brush 的临时对象与渲染句柄（避免 rAF 回调在 reset 后继续跑）
  for (const [, pathData] of ghostPaths.entries()) {
    if (!pathData) continue;
    if (pathData.rafId) cancelAnimationFrame(pathData.rafId);
    if (pathData.tempLine) canvas.remove(pathData.tempLine);
  }
  ghostPaths.clear();

  for (const userId of Array.from(remoteCursorMap.keys())) {
    removeRemoteCursor(userId);
  }

  if (canvas && canvas.contextTop && canvas.clearContext) {
    canvas.clearContext(canvas.contextTop);
  }

  if (canvas) {
    canvas.clear();
    canvas.backgroundColor = 'rgba(255,255,255,0)';
  }

  objectMap.clear();
  historyManager.reset();
  crdtManager.reset();
};

/**
 * 清理“临时层（Ephemeral Layer）”状态：不影响正式对象、不会写入持久化。
 * 包含：
 * - Ghost Brush 预览线（按点流绘制的灰色 polyline）
 * - Top context（Fabric 的上层临时绘制层）
 */
const cleanupEphemeralState = () => {
  for (const [, pathData] of ghostPaths.entries()) {
    if (!pathData) continue;
    if (pathData.rafId) cancelAnimationFrame(pathData.rafId);
    if (pathData.tempLine && canvas) canvas.remove(pathData.tempLine);
  }
  ghostPaths.clear();

  for (const userId of Array.from(remoteCursorMap.keys())) {
    removeRemoteCursor(userId);
  }

  if (canvas && canvas.contextTop && canvas.clearContext) {
    canvas.clearContext(canvas.contextTop);
  }
};

/**
 * 生成并复制“当前房间”的分享链接。
 * 备注：只修改 query，不改变 pathname/hash，便于未来引入路由时保持兼容。
 */
const copyRoomLink = async () => {
  const url = new URL(window.location.href);
  url.searchParams.set('room', ROOM_ID);
  const link = url.toString();

  try {
    await navigator.clipboard.writeText(link);
    pushToast('success', '链接已复制，发给队友吧');
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      if (ok) {
        pushToast('success', '链接已复制，发给队友吧');
        return;
      }
    } catch {
      void 0;
    }
    pushToast('warning', '自动复制失败，已打开手动复制');
    openManualCopy(link);
  }
};

/**
 * 切换房间：通过刷新页面进入新房间。
 * 这么做的好处：
 * - 避免“旧房间的 socket 监听、CRDT 状态、历史栈”残留导致的复杂边界问题
 * - 与目前的项目结构（无路由、全局单白板）匹配
 */
const goToRoom = () => {
  const nextRoomId = (roomIdInput.value || '').trim();
  if (!nextRoomId) return;

  const url = new URL(window.location.href);
  url.searchParams.set('room', nextRoomId);
  window.location.assign(url.toString());
};

const isFormulaObject = (obj) => {
  return !!obj && (obj.isFormula === true || obj.latex !== undefined);
};

const getFormulaLockResourceId = (objectId) => {
  return `formula:${objectId}`;
};

const refreshSelectedFormula = () => {
  if (!canvas) {
    selectedFormulaObjectId.value = null;
    return;
  }
  const active = canvas.getActiveObject();
  if (active && isFormulaObject(active) && active.id) {
    selectedFormulaObjectId.value = active.id;
    return;
  }
  selectedFormulaObjectId.value = null;
};

const cleanupFormulaRecognizeRect = () => {
  if (!canvas) return;
  if (formulaRecognizeRect) {
    canvas.remove(formulaRecognizeRect);
    formulaRecognizeRect = null;
    canvas.requestRenderAll();
  }
};

const applyFormulaRecognizeMode = (enabled) => {
  if (!canvas) return;
  if (enabled) {
    if (!formulaRecognizePrevTool) {
      formulaRecognizePrevTool = currentTool.value;
    }
    canvas.isDrawingMode = false;
    canvas.selection = false;
    canvas.skipTargetFind = true;
    canvas.defaultCursor = QB_CURSOR_PRECISE;
    canvas.hoverCursor = QB_CURSOR_PRECISE;
    canvas.requestRenderAll();
    return;
  }
  canvas.skipTargetFind = false;
  canvas.defaultCursor = 'default';
  canvas.hoverCursor = 'move';
  if (formulaRecognizePrevTool) {
    currentTool.value = formulaRecognizePrevTool;
  }
  formulaRecognizePrevTool = null;
  if (panKeyPressed || isPanning) {
    setPanMode(true);
  } else {
    applyToolMode();
  }
  canvas.requestRenderAll();
};

const cancelFormulaRecognize = () => {
  isFormulaRecognizeMode.value = false;
  isFormulaRecognizing.value = false;
  formulaRecognizeStartPoint = null;
  if (formulaRecognizeAbortController) {
    try {
      formulaRecognizeAbortController.abort();
    } catch {
      void 0;
    }
    formulaRecognizeAbortController = null;
  }
  cleanupFormulaRecognizeRect();
  applyFormulaRecognizeMode(false);
};

const startFormulaRecognize = () => {
  if (!canvas) return;
  if (isFormulaRecognizing.value) return;
  if (!isOnline.value) {
    pushToast('warning', '离线中：无法进行公式识别（需要后端服务）。', 4200);
    return;
  }
  if (panKeyPressed || isPanning) {
    panKeyPressed = false;
    isPanning = false;
    setPanMode(false);
  }
  isFormulaRecognizeMode.value = true;
  formulaRecognizeStartPoint = null;
  cleanupFormulaRecognizeRect();
  applyFormulaRecognizeMode(true);
};

const recognizeMathFromImage = async (imageDataUrl, { signal, debug = false } = {}) => {
  const primary = await recognizeMathFromImageDataUrl({ imageDataUrl, timeoutMs: 25000, debug: Boolean(debug), signal });
  if (primary && primary.ok !== true && primary.error === 'EMPTY_LATEX' && debug !== true) {
    const retry = await recognizeMathFromImageDataUrl({ imageDataUrl, timeoutMs: 25000, debug: true, signal });
    return retry || primary;
  }
  return primary;
};

const finalizeFormulaRecognize = async ({ left, top, width, height }) => {
  if (!canvas) return;
  if (isFormulaRecognizing.value) return;
  isFormulaRecognizing.value = true;

  cleanupFormulaRecognizeRect();

  const canvasW = canvas.getWidth();
  const canvasH = canvas.getHeight();
  const vpt = Array.isArray(canvas.viewportTransform) ? canvas.viewportTransform : [1, 0, 0, 1, 0, 0];
  const zoom = typeof canvas.getZoom === 'function' ? canvas.getZoom() : 1;
  const vr = sceneRectToViewportRect(vpt, { left, top, width, height });
  const padPx = Math.max(8, Math.min(24, Math.min(vr.width, vr.height) * 0.06));
  const cropLeftV = Math.max(0, vr.left - padPx);
  const cropTopV = Math.max(0, vr.top - padPx);
  const cropRightV = Math.min(canvasW, vr.left + vr.width + padPx);
  const cropBottomV = Math.min(canvasH, vr.top + vr.height + padPx);
  const cropWidthV = Math.max(1, cropRightV - cropLeftV);
  const cropHeightV = Math.max(1, cropBottomV - cropTopV);
  const longest = Math.max(cropWidthV, cropHeightV);
  let multiplier = longest > 600 ? 2 : longest > 350 ? 3 : 4;
  while (multiplier > 2 && (cropWidthV * multiplier > 1600 || cropHeightV * multiplier > 1600)) {
    multiplier -= 1;
  }

  try {
    if (typeof canvas.renderAll === 'function') canvas.renderAll();
  } catch {
    void 0;
  }

  const lowerCanvasEl = canvas && canvas.lowerCanvasEl ? canvas.lowerCanvasEl : null;
  const rs =
    typeof canvas?.getRetinaScaling === 'function'
      ? canvas.getRetinaScaling()
      : typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
        ? window.devicePixelRatio
        : 1;
  const safeRs = typeof rs === 'number' && Number.isFinite(rs) && rs > 0 ? rs : 1;

  let imageDataUrl = '';
  if (lowerCanvasEl && typeof lowerCanvasEl.getContext === 'function') {
    const sx = Math.round(cropLeftV * safeRs);
    const sy = Math.round(cropTopV * safeRs);
    const sw = Math.max(1, Math.round(cropWidthV * safeRs));
    const sh = Math.max(1, Math.round(cropHeightV * safeRs));
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    const ctx = out.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, sw, sh);
      ctx.drawImage(lowerCanvasEl, sx, sy, sw, sh, 0, 0, sw, sh);
      if (multiplier > 1) {
        const scaled = document.createElement('canvas');
        scaled.width = Math.max(1, Math.round(sw * multiplier));
        scaled.height = Math.max(1, Math.round(sh * multiplier));
        const sctx = scaled.getContext('2d');
        if (sctx) {
          sctx.fillStyle = '#ffffff';
          sctx.fillRect(0, 0, scaled.width, scaled.height);
          sctx.drawImage(out, 0, 0, sw, sh, 0, 0, scaled.width, scaled.height);
          imageDataUrl = scaled.toDataURL('image/png');
        } else {
          imageDataUrl = out.toDataURL('image/png');
        }
      } else {
        imageDataUrl = out.toDataURL('image/png');
      }
    }
  }

  if (!imageDataUrl) {
    imageDataUrl = canvas.toDataURL({
      format: 'png',
      left: cropLeftV,
      top: cropTopV,
      width: cropWidthV,
      height: cropHeightV,
      multiplier
    });
  }

  window.__ocrDebugLastInput = { imageDataUrl, cropLeftV, cropTopV, cropWidthV, cropHeightV, multiplier, rs: safeRs };

  if (formulaRecognizeAbortController) {
    try {
      formulaRecognizeAbortController.abort();
    } catch {
      void 0;
    }
  }
  formulaRecognizeAbortController = new AbortController();
  const result = await recognizeMathFromImage(imageDataUrl, { signal: formulaRecognizeAbortController.signal });
  const latex = typeof result?.latex === 'string' ? result.latex : '';
  const debugProcessed =
    result && result.debug && typeof result.debug.processedImageDataUrl === 'string'
      ? result.debug.processedImageDataUrl
      : '';
  if (debugProcessed) {
    window.__ocrDebugLast = result.debug;
    if (!window.__ocrDebugHintShown) {
      window.__ocrDebugHintShown = true;
      pushToast('info', '已生成 OCR 调试图：F12 打开 Console，输入 window.__ocrDebugLast 查看。', 4200);
    }
  }

  isFormulaRecognizeMode.value = false;
  applyFormulaRecognizeMode(false);
  isFormulaRecognizing.value = false;
  formulaRecognizeAbortController = null;

  if (!result || result.ok !== true) {
    const err = result?.error || 'UNKNOWN_ERROR';
    const status = typeof result?.status === 'number' ? result.status : null;
    const detail = typeof result?.detail === 'string' ? result.detail.trim() : '';
    const traceId = typeof result?.traceId === 'string' ? result.traceId.trim() : '';
    if (err === 'NOT_CONFIGURED') {
      pushToast('error', '识别服务未配置。', 4500);
    } else if (err === 'ABORTED') {
      pushToast('info', '已取消识别。', 2600);
    } else if (err === 'TIMEOUT') {
      pushToast('error', '识别超时：识别服务可能在冷启动或负载较高，请稍后重试或手动编辑。', 6500);
    } else if (err === 'NETWORK_ERROR') {
      pushToast('error', '识别失败：无法连接到后端（请确认后端已启动，且 VITE_API_URL 配置正确）。', 5200);
    } else if (err === 'MODEL_NOT_INSTALLED') {
      pushToast('error', '识别失败：OCR 模型未安装/不可用（请确认 OCR 服务依赖已安装并启动）。', 6500);
    } else if (err === 'RECOGNIZE_FAILED') {
      pushToast('error', `识别失败：OCR 推理异常${detail ? `：${detail}` : ''}。`, 6500);
    } else if (err === 'UPSTREAM_ERROR') {
      pushToast(
        'error',
        `识别失败：本地识别服务不可用或返回错误${status ? `（HTTP ${status}）` : ''}${detail ? `：${detail}` : ''}${traceId ? `（traceId:${traceId}）` : ''}。`,
        6500
      );
    } else if (err === 'EMPTY_LATEX') {
      pushToast('error', '识别失败：识别服务未返回 latex。', 4500);
    } else {
      pushToast('error', `公式识别失败（${err}${status ? `, HTTP ${status}` : ''}），请重试或手动编辑。`, 5200);
    }
    return;
  }
  if (!latex.trim()) {
    pushToast('error', '识别失败：返回的 LaTeX 为空，请重试或手动编辑。', 4500);
    return;
  }

  const safeZoom = typeof zoom === 'number' && Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const padScene = padPx / safeZoom;
  const cropLeft = left - padScene;
  const cropTop = top - padScene;
  await openFormulaInsertPreview({ latex, left: cropLeft, top: cropTop, fontSize: 22 });
};

const handleFormulaRecognizeMouseDown = (e) => {
  if (isFormulaRecognizeMode.value !== true) return;
  if (!canvas) return;
  if (isFormulaRecognizing.value) return;
  const p = getScenePointFromEvent(e);
  if (!p) return;

  formulaRecognizeStartPoint = { x: p.x, y: p.y };
  cleanupFormulaRecognizeRect();

  const rect = new fabric.Rect({
    originX: 'left',
    originY: 'top',
    left: p.x,
    top: p.y,
    width: 1,
    height: 1,
    fill: 'rgba(59, 130, 246, 0.12)',
    stroke: '#3b82f6',
    strokeWidth: 2,
    strokeDashArray: [6, 4],
    selectable: false,
    evented: false
  });
  rect.__isGhost = true;
  rect.excludeFromExport = true;
  formulaRecognizeRect = rect;
  canvas.add(rect);
  canvas.requestRenderAll();
  if (e?.e?.preventDefault) e.e.preventDefault();
};

const handleFormulaRecognizeMouseMove = (e) => {
  if (isFormulaRecognizeMode.value !== true) return;
  if (!canvas) return;
  if (!formulaRecognizeRect || !formulaRecognizeStartPoint) return;
  const p = getScenePointFromEvent(e);
  if (!p) return;

  const x0 = formulaRecognizeStartPoint.x;
  const y0 = formulaRecognizeStartPoint.y;
  const left = Math.min(x0, p.x);
  const top = Math.min(y0, p.y);
  const width = Math.abs(p.x - x0);
  const height = Math.abs(p.y - y0);

  formulaRecognizeRect.set({ left, top, width, height });
  canvas.requestRenderAll();
  if (e?.e?.preventDefault) e.e.preventDefault();
};

const handleFormulaRecognizeMouseUp = async () => {
  if (isFormulaRecognizeMode.value !== true) return;
  if (!canvas) return;
  if (!formulaRecognizeRect || !formulaRecognizeStartPoint) return;

  const left = formulaRecognizeRect.left || 0;
  const top = formulaRecognizeRect.top || 0;
  const width = formulaRecognizeRect.width || 0;
  const height = formulaRecognizeRect.height || 0;

  formulaRecognizeStartPoint = null;

  if (width < 10 || height < 10) {
    cancelFormulaRecognize();
    return;
  }

  await finalizeFormulaRecognize({ left, top, width, height });
};

const stopFormulaLockRenew = () => {
  if (!formulaEditingLockRenewTimer) return;
  clearInterval(formulaEditingLockRenewTimer);
  formulaEditingLockRenewTimer = null;
};

const closeFormulaEditor = async (releaseLock = true) => {
  stopFormulaLockRenew();

  if (releaseLock && formulaEditingLockResourceId) {
    try {
      await socketService.releaseLock({
        roomId: ROOM_ID,
        resourceId: formulaEditingLockResourceId
      });
    } catch {
      // ignore
    }
  }

  isFormulaEditorOpen.value = false;
  isFormulaInsertPreviewOpen.value = false;
  formulaInsertPending = null;
  formulaEditorValue.value = '';
  formulaEditingObjectId = null;
  formulaEditingBeforeJson = null;
  formulaEditingLockResourceId = null;
  setFormulaOverlayVisible(true);
};

const saveFormulaEditor = async () => {
  if (!canvas) return;
  if (isFormulaInsertPreviewOpen.value === true) {
    const latexSrc = normalizeLatexForKatex(formulaEditorValue.value);
    if (!latexSrc) {
      pushToast('warning', '请输入 LaTeX 公式后再添加。', 3600);
      return;
    }
    const pending = formulaInsertPending && typeof formulaInsertPending === 'object' ? formulaInsertPending : null;
    const left = pending && typeof pending.left === 'number' ? pending.left : 200;
    const top = pending && typeof pending.top === 'number' ? pending.top : 150;
    const fontSize = pending && typeof pending.fontSize === 'number' ? pending.fontSize : 22;
    const size = measureFormulaSize(latexSrc, fontSize);
    const pad = 6;
    const w = (size ? size.w : 260) + pad * 2;
    const h = (size ? size.h : 60) + pad * 2;
    const obj = new fabric.Rect({
      left: left - pad,
      top: top - pad,
      width: Math.max(1, w),
      height: Math.max(1, h),
      fill: 'rgba(0,0,0,0)',
      stroke: 'rgba(0,0,0,0)',
      strokeWidth: 0,
      borderColor: '#93c5fd',
      cornerColor: '#3b82f6',
      selectable: true,
      evented: true
    });
    obj.isFormula = true;
    obj.latex = latexSrc;
    obj.text = latexSrc;
    obj.excludeFromExport = false;
    obj.formulaFontSize = fontSize;
    obj.formulaPad = pad;
    applyFormulaCanvasStyle(obj);
    canvas.add(obj);
    finalizeNewObject(obj);
    updateFormulaOverlayForObject(obj);
    await closeFormulaEditor(true);
    currentTool.value = 'select';
    applyToolMode();
    canvas.setActiveObject(obj);
    canvas.requestRenderAll();
    return;
  }

  if (!formulaEditingObjectId) return;

  const obj = objectMap.get(formulaEditingObjectId);
  if (!obj) {
    await closeFormulaEditor(true);
    return;
  }

  const beforeJson = formulaEditingBeforeJson || obj.toJSON();
  obj.latex = normalizeLatexForKatex(formulaEditorValue.value);
  obj.text = obj.latex;
  applyFormulaCanvasStyle(obj);
  updateFormulaOverlayForObject(obj);

  obj.setCoords();
  canvas.requestRenderAll();

  const afterJson = obj.toJSON();
  historyManager.push(new ModifyCommand(getAppContext(), obj, beforeJson, afterJson));

  const crdtState = crdtManager.localUpdate(obj.id, afterJson);
  socketService.emit('draw-event', {
    roomId: ROOM_ID,
    ...crdtState
  });

  await closeFormulaEditor(true);
};

const openFormulaEditor = async (obj) => {
  if (!obj || !obj.id) return;

  const resourceId = getFormulaLockResourceId(obj.id);
  const resp = await socketService.acquireLock({
    roomId: ROOM_ID,
    resourceId,
    ownerName: myName.value,
    ttlMs: 15000
  });

  if (!resp || resp.ok !== true) {
    const lockedBy = resp && resp.lockedBy;
    if (lockedBy) {
      const name = lockedBy.ownerName || lockedBy.ownerId || '未知用户';
      pushToast('warning', `该公式正在被「${name}」编辑中，请稍后再试。`, 4200);
    } else {
      pushToast('error', '当前无法进入公式编辑，请稍后重试。', 4200);
    }
    return;
  }

  obj.editable = false;
  await closeFormulaEditor(false);
  isFormulaInsertPreviewOpen.value = false;
  formulaInsertPending = null;
  setFormulaOverlayVisible(false);

  formulaEditingObjectId = obj.id;
  formulaEditingBeforeJson = obj.toJSON();
  formulaEditingLockResourceId = resourceId;
  formulaEditorValue.value = normalizeLatexForKatex(typeof obj.latex === 'string' ? obj.latex : (obj.text || ''));
  isFormulaEditorOpen.value = true;

  stopFormulaLockRenew();
  formulaEditingLockRenewTimer = setInterval(async () => {
    if (!formulaEditingLockResourceId) return;
    const renewResp = await socketService.renewLock({
      roomId: ROOM_ID,
      resourceId: formulaEditingLockResourceId,
      ttlMs: 15000
    });
    if (!renewResp || renewResp.ok !== true) {
      await closeFormulaEditor(false);
      pushToast('warning', '公式编辑锁已失效，已自动退出编辑。', 4200);
    }
  }, 5000);
};

const openFormulaInsertPreview = async ({ latex, left, top, fontSize } = {}) => {
  await closeFormulaEditor(true);
  formulaEditingObjectId = null;
  formulaEditingBeforeJson = null;
  formulaEditingLockResourceId = null;
  isFormulaInsertPreviewOpen.value = true;
  formulaInsertPending = {
    left: typeof left === 'number' ? left : 200,
    top: typeof top === 'number' ? top : 150,
    fontSize: typeof fontSize === 'number' ? fontSize : 22
  };
  formulaEditorValue.value = normalizeLatexForKatex(latex || '');
  isFormulaEditorOpen.value = true;
  setFormulaOverlayVisible(false);
};

const insertFormula = () => {
  if (!canvas) return;

  const textbox = new fabric.Textbox('', {
    left: 200,
    top: 150,
    width: 260,
    fontSize: 22,
    fill: 'rgba(0,0,0,0)',
    backgroundColor: 'rgba(0,0,0,0)',
    borderColor: '#93c5fd',
    cornerColor: '#3b82f6',
    padding: 6,
    editable: false
  });
  textbox.isFormula = true;
  textbox.latex = '';
  textbox.text = '';
  textbox.excludeFromExport = false;
  applyFormulaCanvasStyle(textbox);

  canvas.add(textbox);
  canvas.setActiveObject(textbox);
  canvas.requestRenderAll();
  updateFormulaOverlayForObject(textbox);

  setTimeout(() => {
    if (!textbox.id) return;
    openFormulaEditor(textbox);
  }, 0);
};

// --- 方法：处理本地鼠标移动 (节流发送) ---
let lastCursorSend = 0;
let cursorSendSeq = 0;
let cursorSendRafId = 0;
let pendingCursorPoint = null;
const CURSOR_SEND_INTERVAL_MS = 33;

const scheduleCursorSend = () => {
  if (cursorSendRafId) return;
  cursorSendRafId = requestAnimationFrame(() => {
    cursorSendRafId = 0;
    if (!pendingCursorPoint) return;
    const now = performance.now();
    if (now - lastCursorSend < CURSOR_SEND_INTERVAL_MS) {
      scheduleCursorSend();
      return;
    }
    lastCursorSend = now;
    cursorSendSeq += 1;
    const p = pendingCursorPoint;
    pendingCursorPoint = null;
    socketService.emit('cursor-move', {
      roomId: ROOM_ID,
      x: p.x,
      y: p.y,
      userName: myName.value,
      seq: cursorSendSeq
    });
  });
};

// --- Ghost Brush：发送端降载（批量点发送）---
//
// 给外行看的解释：
// - 鼠标移动事件（mousemove）非常高频：一秒几十到上百次；
// - 如果我们“每个 mousemove 都发一个 drawing-process 消息”，多人同时画就会造成网络风暴；
// - 所以这里把点先缓存起来，再按固定节奏（例如 33ms≈30fps）批量发出去：
//   - 视觉上仍然跟手
//   - 网络消息数量会大幅下降
const ghostBrushSender = createGhostBrushSender({
  emit: (event, payload) => socketService.emit(event, payload),
  roomId: ROOM_ID,
  flushIntervalMs: 33,
  maxPendingPoints: 300,
  maxPointsPerMessage: 60
});

// --- 方法：渲染远程 Ghost Path ---
// 存储每个用户的临时路径点与渲染句柄：
// - points：世界坐标点集（仅用于临时预览，不进入 CRDT）
// - tempLine：fabric.Polyline 临时对象（excludeFromExport）
// - rafId：合帧渲染句柄（同一帧多点只渲染一次）
const ghostPaths = new Map();

const GHOST_BRUSH_MAX_POINTS = 3000;

const scheduleGhostRender = (userId, pathData) => {
  if (!canvas) return;
  if (!pathData) return;
  if (pathData.rafId) return;

  pathData.rafId = requestAnimationFrame(() => {
    pathData.rafId = 0;
    if (!pathData.dirty) return;
    pathData.dirty = false;

    if (!pathData.tempLine) {
      const polyline = new fabric.Polyline(pathData.points, {
        stroke: 'rgba(50, 50, 50, 0.8)', // Ghost 预览线：灰黑色，避免和正式笔迹混淆
        strokeWidth: 4,
        fill: 'transparent',
        strokeLineCap: 'round',
        strokeLineJoin: 'round',
        evented: false,
        selectable: false,
        hoverCursor: 'default'
      });
      polyline.__isGhost = true;
      polyline.__ghostOwner = userId;
      polyline.excludeFromExport = true;
      pathData.tempLine = polyline;
      canvas.add(polyline);
      canvas.requestRenderAll();
      return;
    }

    // 性能关键点：
    // - 旧实现：每个点都 remove + new + add（会触发大量对象管理与重绘）
    // - 新实现：同一帧把点合并后只更新一次 points 并 requestRenderAll
    pathData.tempLine.set({ points: pathData.points });
    if (typeof pathData.tempLine.setCoords === 'function') {
      pathData.tempLine.setCoords();
    }
    canvas.requestRenderAll();
  });
};

const renderGhostPath = (raw) => {
  const { userId, isEnd, points } = normalizeGhostBrushPayload(raw);
  if (!userId) return;

  // 1) 结束信号：清除该用户的临时预览线
  if (isEnd) {
    const pathData = ghostPaths.get(userId);
    if (pathData) {
      if (pathData.rafId) cancelAnimationFrame(pathData.rafId);
      if (pathData.tempLine) canvas.remove(pathData.tempLine);
      ghostPaths.delete(userId);
      canvas.requestRenderAll();
    }
    return;
  }

  // 2) 批量点：追加到 points
  if (!points || points.length === 0) return;

  let pathData = ghostPaths.get(userId);
  if (!pathData) {
    pathData = { points: [], tempLine: null, rafId: 0, dirty: false };
    ghostPaths.set(userId, pathData);
  }

  pathData.points.push(...points);

  // 3) 点数上限：避免极端情况下点集无限增长（例如某端卡住一直不收到 isEnd）
  if (pathData.points.length > GHOST_BRUSH_MAX_POINTS) {
    const compact = downsamplePointsKeepTail(
      pathData.points.map((p) => [p.x, p.y]),
      GHOST_BRUSH_MAX_POINTS
    );
    pathData.points = compact.map(([x, y]) => ({ x, y }));
  }

  if (pathData.points.length < 2) return;
  pathData.dirty = true;
  scheduleGhostRender(userId, pathData);
};

// --- 方法：更新远程光标 ---
const updateRemoteCursor = ({ userId, x, y, userName, seq }) => {
  if (!userId) return;
  if (!canvas) return;
  const nx = toFiniteNumber(x);
  const ny = toFiniteNumber(y);
  if (nx === null || ny === null) return;

  let cursor = remoteCursorMap.get(userId);

  if (!cursor) {
    const c = getStableUserColor(userId);
    const pointer = new fabric.Path('M0 0 L0 20 L5 14 L8 23 L10.5 22 L7.6 13 L16 13 Z', {
      fill: c.solid,
      originX: 'left',
      originY: 'top',
      left: 0,
      top: 0,
      selectable: false,
      evented: false
    });
    pointer.shadow = new fabric.Shadow({
      color: 'rgba(2,6,23,0.28)',
      blur: 7,
      offsetX: 0,
      offsetY: 3
    });
    const labelBg = new fabric.Rect({
      left: REMOTE_CURSOR_LABEL_OFFSET_X,
      top: REMOTE_CURSOR_LABEL_OFFSET_Y,
      originX: 'center',
      originY: 'top',
      width: 24,
      height: 16,
      rx: REMOTE_CURSOR_LABEL_RADIUS,
      ry: REMOTE_CURSOR_LABEL_RADIUS,
      fill: getRemoteCursorLabelBgFill(c.hue),
      stroke: getRemoteCursorLabelBgStroke(c.hue),
      strokeWidth: 1,
      selectable: false,
      evented: false
    });
    labelBg.shadow = new fabric.Shadow({
      color: 'rgba(2,6,23,0.10)',
      blur: 6,
      offsetX: 0,
      offsetY: 4
    });
    const label = new fabric.Text(userName || userId.slice(0, 4), {
      fontSize: 11,
      fill: REMOTE_CURSOR_LABEL_TEXT,
      originX: 'center',
      originY: 'top',
      left: REMOTE_CURSOR_LABEL_OFFSET_X,
      top: REMOTE_CURSOR_LABEL_OFFSET_Y + REMOTE_CURSOR_LABEL_PAD_Y,
      fontFamily: 'system-ui',
      fontWeight: '400',
      selectable: false,
      evented: false
    });
    label.shadow = null;
    const group = new fabric.Group([pointer, labelBg, label], {
      left: nx,
      top: ny,
      originX: 'left',
      originY: 'top',
      selectable: false,
      evented: false,
      hasControls: false,
      hasBorders: false,
      excludeFromExport: true
    });
    group.__isGhost = true;
    canvas.add(group);
    if (typeof canvas.bringObjectToFront === 'function') {
      canvas.bringObjectToFront(group);
    }
    cursor = {
      obj: group,
      labelObj: label,
      labelBgObj: labelBg,
      tx: nx,
      ty: ny,
      cx: nx,
      cy: ny,
      lastSeq: null,
      lastSeenAt: 0,
      lastRenderAt: 0,
      snapNext: true,
      lastScale: null
    };
    remoteCursorMap.set(userId, cursor);
    updateRemoteCursorLabel(cursor, userId, userName);
  }

  updateRemoteCursorLabel(cursor, userId, userName);

  if (!shouldAcceptMonotonicSeq(cursor.lastSeq, seq)) return;
  if (typeof seq === 'number' && Number.isFinite(seq)) cursor.lastSeq = Math.floor(seq);
  cursor.tx = nx;
  cursor.ty = ny;
  cursor.lastSeenAt = performance.now();
  ensureRemoteCursorLoop();
  renderRemoteCursorsOnce(false);
};

/**
 * 当视图发生变化（平移/缩放）时，刷新所有远端光标的位置。
 */
const refreshRemoteCursors = () => {
  for (const cursor of remoteCursorMap.values()) {
    if (cursor) cursor.snapNext = true;
  }
  renderRemoteCursorsOnce(true);
};

// --- 方法：移除远程光标 ---
const removeRemoteCursor = (userId) => {
  const cursor = remoteCursorMap.get(userId);
  if (cursor) {
    if (cursor.obj && canvas) {
      canvas.remove(cursor.obj);
    }
    remoteCursorMap.delete(userId);
    if (remoteCursorMap.size === 0 && remoteCursorRafId) {
      cancelAnimationFrame(remoteCursorRafId);
      remoteCursorRafId = 0;
    }
  }
};

// --- 方法：统一处理远程更新 ---
const handleRemoteUpdate = (crdtState) => {
  // 标记为远程更新，防止触发 object:added/modified 再次发送
  isRemoteUpdate = true;

  // [关键修复] 如果在撤销/重做保护期内，延迟处理远程更新
  if (undoRedoInProgress) {
    if (isDev) {
      console.log(`[Remote Update] Delaying update during undo/redo for object ${crdtState.id}`);
    }
    setTimeout(() => {
      handleRemoteUpdate(crdtState);
    }, 150); // 稍长于撤销保护期
    isRemoteUpdate = false;
    return;
  }

  // 交给 CRDT 管理器处理合并
  const { isNew, changes } = crdtManager.mergeRemoteUpdate(crdtState);

  // [关键修复] 检查时间戳，确保不覆盖本地正在进行的撤销操作
  // 如果远程更新的时间戳比本地撤销操作旧，则忽略
  const currentCrdtState = crdtManager.getObjectState(crdtState.id);
  if (currentCrdtState && crdtState.timestamps) {
    const remoteMaxTime = Math.max(...Object.values(crdtState.timestamps));
    const localMaxTime = Math.max(...Object.values(currentCrdtState.timestamps));

    // 如果远程时间戳比本地时间戳旧，且本地对象被标记为删除，则忽略远程更新
    if (remoteMaxTime < localMaxTime && currentCrdtState.data && currentCrdtState.data._deleted) {
      if (isDev) {
        console.log(`[Remote Update] Ignoring outdated update for deleted object ${crdtState.id}`);
      }
      isRemoteUpdate = false;
      return;
    }
  }

  // 1. 处理删除 (Tombstone)
  // 如果是新对象但已被标记删除，直接忽略
  if (isNew && crdtState.data && crdtState.data._deleted) {
    isRemoteUpdate = false;
    return;
  }
  // 如果是现有对象且包含删除标记
  if (!isNew && changes._deleted) {
    if (crdtState.id && crdtState.id === formulaEditingObjectId) {
      void closeFormulaEditor(true);
    }
    if (crdtState.id && selectedFormulaObjectId.value === crdtState.id) {
      selectedFormulaObjectId.value = null;
    }
    const obj = objectMap.get(crdtState.id);
    if (obj) {
      canvas.remove(obj);
      objectMap.delete(crdtState.id);
      canvas.requestRenderAll();
    }
    isRemoteUpdate = false;
    return;
  }

  if (isNew) {
    // 如果是新对象，创建并添加到画布
    fabric.util.enlivenObjects([crdtState.data]).then((objects) => {
      objects.forEach((obj) => {
        // 标记该对象为远程来源，避免触发本地 object:added 逻辑
        obj.__fromRemote = true;
        // 对于远端的 path，也不会触发本地入栈，因为我们在 object:added 对 path 直接 return
        obj.id = crdtState.id; // 绑定 ID
        if (isFormulaObject(obj)) {
          obj.editable = false;
        }
        applyRenderPerfDefaultsToObject(obj);
        objectMap.set(obj.id, obj);
        canvas.add(obj);
        // 下一拍移除标记
        setTimeout(() => {
          delete obj.__fromRemote;
        }, 0);
      });
      canvas.renderAll();
      scheduleViewportStatsUpdate();
      isRemoteUpdate = false;
    });
  } else {
    // 如果是现有对象，仅更新变更的属性
    const obj = objectMap.get(crdtState.id);
    if (obj && Object.keys(changes).length > 0) {
      obj.set(changes);
      if (isFormulaObject(obj)) {
        obj.editable = false;
      }
      obj.setCoords(); // 更新坐标控制点
      applyRenderPerfDefaultsToObject(obj);
      canvas.requestRenderAll();
      scheduleViewportStatsUpdate();
    }
    isRemoteUpdate = false;
  }
};


// --- (以下是之前的绘图逻辑，保持不变) ---
const handleResize = () => {
  viewportWidth.value = window.innerWidth;
  if (canvas) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (typeof canvas.setDimensions === 'function') {
      canvas.setDimensions({ width: w, height: h });
    } else {
      if (typeof canvas.setWidth === 'function') canvas.setWidth(w);
      if (typeof canvas.setHeight === 'function') canvas.setHeight(h);
    }
    if (typeof canvas.calcOffset === 'function') canvas.calcOffset();
    canvas.requestRenderAll();
    scheduleViewportStatsUpdate();
  }
};

/**
 * 将“当前工具状态”应用到 Fabric Canvas。
 * 注意：这里仅控制本地交互（绘图/选择），不参与协同同步。
 */
const applyToolMode = () => {
  if (!canvas) return;

  if (currentTool.value === 'pencil') {
    applyEraserHoverCursorOverride(false);
    canvas.isDrawingMode = true;
    canvas.selection = false;
    canvas.skipTargetFind = false;
    setCanvasCursor(QB_CURSOR_PRECISE);
    canvas.freeDrawingCursor = QB_CURSOR_PRECISE;
    canvas.requestRenderAll();
    return;
  } else {
    canvas.isDrawingMode = false;
    canvas.selection = true;
  }

  if (currentTool.value === 'rect' || currentTool.value === 'circle') {
    applyEraserHoverCursorOverride(false);
    canvas.selection = false;
    canvas.skipTargetFind = true;
    setCanvasCursor(QB_CURSOR_PRECISE);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    return;
  }

  if (currentTool.value === 'eraser') {
    applyEraserHoverCursorOverride(true);
    canvas.selection = false;
    canvas.skipTargetFind = true;
    setCanvasCursor(QB_CURSOR_ERASER);
    canvas.discardActiveObject();
    canvas.requestRenderAll();
    return;
  }

  applyEraserHoverCursorOverride(false);
  canvas.skipTargetFind = false;
  canvas.defaultCursor = 'default';
  canvas.hoverCursor = 'move';
  if (canvas.upperCanvasEl && canvas.upperCanvasEl.style) {
    canvas.upperCanvasEl.style.cursor = 'default';
  }
  canvas.requestRenderAll();
};

/**
 * 开启/关闭“视图平移模式”。
 * 平移模式是“只影响本地视图”的能力：
 * - 禁用选择命中与绘图，避免拖拽时误选中/误画到对象；
 * - 仅通过 viewportTransform 改变视图位置。
 */
const setPanMode = (enabled) => {
  if (!canvas) return;

  if (enabled) {
    canvas.isDrawingMode = false;
    canvas.selection = false;
    canvas.skipTargetFind = true;
    canvas.defaultCursor = 'grab';
    canvas.hoverCursor = 'grab';
  } else {
    canvas.skipTargetFind = false;
    canvas.defaultCursor = 'default';
    canvas.hoverCursor = 'move';
    applyToolMode();
  }

  canvas.requestRenderAll();
};

/**
 * 鼠标滚轮缩放：围绕鼠标所在屏幕点进行缩放。
 * - 只改变本地视图（viewportTransform），不改变对象数据；
 * - 每个客户端可拥有不同的缩放级别，不影响协同一致性。
 */
const handleCanvasMouseWheel = (e) => {
  if (!canvas) return;
  if (!e || !e.e) return;

  const wheelEvent = e.e;
  wheelEvent.preventDefault();
  wheelEvent.stopPropagation();

  const delta = wheelEvent.deltaY;
  let zoom = canvas.getZoom();
  zoom *= 0.999 ** delta;
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

  const zoomPoint = new fabric.Point(wheelEvent.offsetX, wheelEvent.offsetY);
  canvas.zoomToPoint(zoomPoint, zoom);

  refreshRemoteCursors();
  scheduleViewportStatsUpdate();
};

/**
 * 双击复位视图。
 * 说明：
 * - 与工具栏“复位”按钮共享同一逻辑；
 * - 只改变 viewportTransform，不改变任何对象属性，因此不会触发协同同步。
 */
const handleCanvasDoubleClick = (e) => {
  if (!canvas) return;
  if (e?.e?.preventDefault) e.e.preventDefault();
  const target = e && e.target;
  if (target && isFormulaObject(target)) {
    openFormulaEditor(target);
    return;
  }
  resetView();
};

/**
 * 获取当前视图中心点（屏幕坐标）。
 * 用途：缩放时将中心作为缩放锚点（滚轮缩放则用鼠标点作为锚点）。
 */
const getViewportCenterPoint = () => {
  if (!canvas) return new fabric.Point(0, 0);
  const center = canvas.getCenter();
  return new fabric.Point(center.left, center.top);
};

/**
 * 以视图中心为锚点缩放。
 * @param {number} factor - 缩放倍率（例如 1.1 表示放大 10%，0.9 表示缩小 10%）
 */
const zoomByFactor = (factor) => {
  if (!canvas) return;
  if (!factor || !Number.isFinite(factor)) return;

  const centerPoint = getViewportCenterPoint();
  let zoom = canvas.getZoom();
  zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
  canvas.zoomToPoint(centerPoint, zoom);
  refreshRemoteCursors();
};

/**
 * 复位视图到初始状态：zoom=1、平移=0。
 * 注意：
 * - 复位的是“视图”（viewportTransform），不会影响对象坐标；
 * - 远端光标是世界坐标，需要在复位后重新映射一次屏幕位置。
 */
const resetView = () => {
  if (!canvas) return;

  canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
  canvas.setZoom(1);
  canvas.requestRenderAll();
  refreshRemoteCursors();
  scheduleViewportStatsUpdate();
};

const zoomIn = () => zoomByFactor(1.1);
const zoomOut = () => zoomByFactor(0.9);

/**
 * 判断是否应当触发“视图平移”。
 * 触发方式：
 * - 按住空格 + 左键拖拽；
 * - 或中键拖拽（不依赖键盘）。
 */
const shouldStartPan = (e) => {
  const button = e?.e?.button;
  return panKeyPressed || button === 1;
};

const handleCanvasPanStart = (e) => {
  if (!canvas) return false;
  if (!shouldStartPan(e)) return false;

  isPanning = true;
  setPanMode(true);

  lastPanClientX = e.e.clientX;
  lastPanClientY = e.e.clientY;
  canvas.setCursor('grabbing');

  return true;
};

const handleCanvasPanMove = (e) => {
  if (!canvas) return false;
  if (!isPanning) return false;
  if (!e || !e.e) return true;

  const dx = e.e.clientX - lastPanClientX;
  const dy = e.e.clientY - lastPanClientY;
  lastPanClientX = e.e.clientX;
  lastPanClientY = e.e.clientY;

  const vpt = canvas.viewportTransform;
  if (vpt) {
    vpt[4] += dx;
    vpt[5] += dy;
    canvas.setViewportTransform(vpt);
    canvas.requestRenderAll();
    refreshRemoteCursors();
    scheduleViewportStatsUpdate();
  }

  return true;
};

const handleCanvasPanEnd = () => {
  if (!canvas) return;
  if (!isPanning) return;

  isPanning = false;
  if (panKeyPressed) {
    canvas.setCursor('grab');
  } else {
    setPanMode(false);
    canvas.setCursor('default');
  }
};

const stopLocalDrawingOnce = () => {
  if (!canvas) return;
  const shouldResume = currentTool.value === 'pencil';
  canvas.isDrawingMode = false;
  canvas.freeDrawingBrush?._reset?.();
  if (canvas.contextTop && canvas.clearContext) {
    canvas.clearContext(canvas.contextTop);
  }
  canvas.requestRenderAll();
  if (shouldResume) {
    setTimeout(() => {
      if (canvas) canvas.isDrawingMode = true;
    }, 0);
  }
};

// --- 方法：处理键盘事件 (删除选中物体) ---
const handleKeydown = (e) => {
  // 如果当前焦点在输入框/可编辑区域，则不拦截快捷键（避免影响输入）
  const target = e?.target;
  const isEditable =
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (isEditable) return;

  if (helpOpen.value && e.key === 'Escape') {
    e.preventDefault();
    helpOpen.value = false;
    return;
  }

  if (toolRingVisible.value && e.key === 'Escape') {
    e.preventDefault();
    closeToolRing();
    return;
  }

  if (e.key === '?' || (e.shiftKey && e.key === '/')) {
    e.preventDefault();
    helpOpen.value = true;
    return;
  }

  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    const k = String(e.key || '').toLowerCase();
    if (k === 'v') {
      e.preventDefault();
      setTool('select');
      return;
    }
    if (k === 'p') {
      e.preventDefault();
      setTool('pencil');
      return;
    }
    if (k === 'e') {
      e.preventDefault();
      setTool('eraser');
      return;
    }
    if (k === 'r') {
      e.preventDefault();
      setTool('rect');
      return;
    }
    if (k === 'c') {
      e.preventDefault();
      setTool('circle');
      return;
    }
  }

  if (isFormulaRecognizeMode.value === true && e.key === 'Escape') {
    e.preventDefault();
    cancelFormulaRecognize();
    return;
  }

  if ((currentTool.value === 'rect' || currentTool.value === 'circle') && e.key === 'Escape') {
    e.preventDefault();
    cancelShapeDraft();
    setTool('select');
    return;
  }

  // 0. 处理视图快捷键（只影响本地视图）
  // - Ctrl+0：复位视图
  // - Ctrl+=：放大
  // - Ctrl+-：缩小
  if (e.ctrlKey || e.metaKey) {
    if (e.key === '0') {
      e.preventDefault();
      resetView();
      return;
    }
    if (e.key === '=' || e.key === '+') {
      e.preventDefault();
      zoomIn();
      return;
    }
    if (e.key === '-') {
      e.preventDefault();
      zoomOut();
      return;
    }
  }

  // 0. 处理视图平移快捷键（按住空格）
  if (e.code === 'Space') {
    e.preventDefault();
    if (!panKeyPressed) {
      panKeyPressed = true;
      setPanMode(true);
      if (canvas) canvas.setCursor('grab');
    }
    return;
  }

  // 1. 处理撤销 (Ctrl+Z)
  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { // 严格匹配 Ctrl+Z (不含 Shift)
    e.preventDefault();
    performUndo();
    return;
  }

  // 2. 处理重做 (Ctrl+Y 或 Ctrl+Shift+Z)
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
    e.preventDefault();
    performRedo();
    return;
  }

  // 3. 处理删除 (Delete/Backspace)
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // 获取当前选中的所有对象 (可能是单个，也可能是多选)
    const activeObjects = canvas.getActiveObjects();
    if (activeObjects.length) {
      // 遍历删除
      activeObjects.forEach((obj) => {
        if (obj && obj.id && isFormulaObject(obj) && obj.id === formulaEditingObjectId) {
          void closeFormulaEditor(true);
        }
        // 从画布移除
        canvas.remove(obj);

        if (obj.id) {
          objectMap.delete(obj.id);

          // [History] 记录删除操作
          if (!isUndoRedo) {
            historyManager.push(new RemoveCommand(getAppContext(), obj));
          }

          // CRDT 删除 (生成 Tombstone)
          const crdtState = crdtManager.delete(obj.id);

          // 广播删除事件
          if (crdtState) {
            socketService.emit('draw-event', {
              roomId: ROOM_ID,
              ...crdtState
            });
          }
        }
      });
      canvas.discardActiveObject();
      canvas.requestRenderAll();
      refreshSelectedFormula();
    }
  }
};

/**
 * 键盘抬起：用于结束“按住空格平移”的语义。
 */
const handleKeyup = (e) => {
  if (e.code !== 'Space') return;

  panKeyPressed = false;
  if (!isPanning) {
    setPanMode(false);
    if (canvas) canvas.setCursor('default');
  }
};

// --- 方法：切换工具 ---
const setTool = (tool) => {
  currentTool.value = tool;
  if (!canvas) return;

  // 如果正在进行“视图平移”（空格按住或正在拖拽），先不切换交互模式；
  // 等平移结束后，再由 applyToolMode 将最新工具状态应用到 Canvas。
  if (panKeyPressed || isPanning) {
    return;
  }

  // 1. 处理绘图/选择模式开关
  applyToolMode();
};

// --- 方法：清空画布 ---
const clearCanvas = async () => {
  if (!canvas) return;
  const objects = canvas.getObjects();
  const deletable = objects.filter((obj) => obj && obj.id && obj.__isGhost !== true && obj.__draftShape !== true);
  const deletableCount = deletable.length;
  const ok = await confirmAsync(
    '确认清空内容',
    isOnline.value
      ? `确定要删除画布上的所有内容吗？将同步给房间内所有人。（对象数：${deletableCount}）`
      : `确定要删除画布上的所有内容吗？离线时不会同步给他人。（对象数：${deletableCount}）`,
    '删除全部',
    '取消'
  );
  if (!ok) return;

  // 遍历所有对象进行 CRDT 删除
  deletable.forEach((obj) => {
    const crdtState = crdtManager.delete(obj.id);
    if (crdtState) {
      socketService.emit('draw-event', {
        roomId: ROOM_ID,
        ...crdtState
      });
    }
  });

  canvas.clear();
  canvas.backgroundColor = 'rgba(255,255,255,0)';
  objectMap.clear();
  pushToast('success', isOnline.value ? `已删除 ${deletableCount} 个对象（已同步）` : `已删除 ${deletableCount} 个对象（未同步）`);
};

const resetRoom = async () => {
  if (!isOnline.value) {
    pushToast('warning', '离线中：暂时无法重置房间，等我重连一下。', 4200);
    return;
  }
  const ok = await confirmAsync(
    '确认重置房间',
    `确定要重置房间「${ROOM_ID}」吗？这会清除服务端保存的云端存档与版本号，并让所有人清空撤销栈（无法撤销）。`,
    '重置房间',
    '取消'
  );
  if (!ok) return;
  socketService.emit('clear-room', { roomId: ROOM_ID });
  pushToast('info', '已发出重置请求：等待服务端广播“房间已重置”…', 4200);
};

/**
 * 在导出时临时隐藏“临时层对象”（如 Ghost Brush 预览线），避免导出的 PNG/JSON 里混入协同临时效果。
 * 说明：
 * - Ghost Polyline 会被添加到 canvas（便于显示），但不应作为“真实画布内容”保存；
 * - 临时移除与恢复只发生在本地，且不会触发协同写入（object:added 已对 __isGhost 做了短路）。
 */
const withEphemeralObjectsHidden = (fn) => {
  if (!canvas) return;

  const ephemeralObjects = canvas
    .getObjects()
    .filter(obj => obj && (obj.__isGhost === true || obj.excludeFromExport === true));

  ephemeralObjects.forEach(obj => canvas.remove(obj));

  const activeObject = canvas.getActiveObject();
  canvas.discardActiveObject();
  canvas.requestRenderAll();

  try {
    return fn();
  } finally {
    ephemeralObjects.forEach(obj => canvas.add(obj));
    if (activeObject && canvas.getObjects().includes(activeObject)) {
      canvas.setActiveObject(activeObject);
    }
    canvas.requestRenderAll();
  }
};

/**
 * 触发浏览器下载：data URL 或 Blob。
 */
const triggerDownload = (filename, href) => {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
};

/**
 * 导出当前视图为 PNG（等价于“截图”）。
 * 说明：
 * - 导出的是“当前缩放/平移后的视图区域”；
 * - 若需要导出全量内容，可以在未来增加“导出全画布”的专用逻辑（基于对象边界计算）。
 */
const exportPng = () => {
  if (!canvas) return;

  withEphemeralObjectsHidden(() => {
    const prevBg = canvas.backgroundColor;
    canvas.backgroundColor = '#ffffff';
    canvas.requestRenderAll();
    const dataUrl = canvas.toDataURL({
      format: 'png',
      multiplier: 2
    });
    canvas.backgroundColor = prevBg;
    canvas.requestRenderAll();
    triggerDownload(`quickboard-${ROOM_ID}.png`, dataUrl);
  });
};

/**
 * 导出画布内容为 JSON（用于调试/存档）。
 * 说明：
 * - 导出的对象包含 id，便于后续回放或与 CRDT 状态对照；
 * - 不导出临时对象（Ghost Brush）。
 */
const exportJson = () => {
  if (!canvas) return;

  withEphemeralObjectsHidden(() => {
    const payload = {
      meta: {
        roomId: ROOM_ID,
        exportedAt: new Date().toISOString(),
        zoom: canvas.getZoom(),
      },
      canvas: canvas.toJSON(['id', 'excludeFromExport', '__isGhost'])
    };

    if (Array.isArray(payload.canvas.objects)) {
      payload.canvas.objects = payload.canvas.objects.filter(
        obj => !(obj && (obj.__isGhost === true || obj.excludeFromExport === true))
      );
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    triggerDownload(`quickboard-${ROOM_ID}.json`, url);
    URL.revokeObjectURL(url);
  });
};

</script>

<template>
  <div class="relative w-full h-full overflow-hidden">
    <div class="pointer-events-none absolute inset-0">
      <div class="absolute inset-0 bg-white/70" />
      <div class="absolute inset-0 qb-grid opacity-60" />
      <div class="absolute inset-0 qb-noise opacity-[0.12]" />
      <div
        class="absolute inset-0"
        style="background: radial-gradient(900px circle at 50% 30%, rgba(59,130,246,0.09), transparent 70%), radial-gradient(1100px circle at 50% 100%, rgba(168,85,247,0.06), transparent 68%), radial-gradient(900px circle at 0% 50%, rgba(34,197,94,0.035), transparent 70%), radial-gradient(900px circle at 100% 50%, rgba(59,130,246,0.035), transparent 70%);"
      />
    </div>

    <!-- Canvas 容器 -->
    <canvas ref="canvasEl"></canvas>

    <div
      v-if="currentTool === 'eraser'"
      class="fixed left-0 top-0 z-50 pointer-events-none"
      :style="{
        transform: `translate(${eraserCursorClientX}px, ${eraserCursorClientY}px) translate(-50%, -50%)`
      }"
    >
      <div class="relative w-7 h-7">
        <div class="absolute inset-0 rounded-full border-2 border-white/90 shadow-[0_10px_24px_-14px_rgba(2,6,23,0.65)]" />
        <div class="absolute inset-0 rounded-full border border-slate-900/80" />
        <div class="absolute left-1/2 top-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-900/90" />
      </div>
    </div>

    <div v-if="toolRingMounted" class="absolute inset-0 z-40 pointer-events-none">
      <div
        class="absolute left-0 top-0 qb-ring-container"
        :class="toolRingVisible ? 'qb-ring-enter' : ''"
        :style="{
          width: `${toolRingSize}px`,
          height: `${toolRingSize}px`,
          '--qb-ring-x': `${toolRingX}px`,
          '--qb-ring-y': `${toolRingY}px`,
          opacity: toolRingVisible ? 1 : 0,
          transition: 'opacity 180ms ease-out'
        }"
      >
        <div class="absolute inset-0 qb-ring-shadow" />

        <svg class="absolute inset-0" :viewBox="`0 0 ${toolRingSize} ${toolRingSize}`">
        <defs>
          <radialGradient id="qbRingBase" cx="50%" cy="45%" r="70%">
            <stop offset="0%" stop-color="rgba(255,255,255,0.88)" />
            <stop offset="60%" stop-color="rgba(255,255,255,0.62)" />
            <stop offset="100%" stop-color="rgba(255,255,255,0.52)" />
          </radialGradient>
          <linearGradient id="qbWedgeHover" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="rgba(59,130,246,0.20)" />
            <stop offset="55%" stop-color="rgba(168,85,247,0.18)" />
            <stop offset="100%" stop-color="rgba(34,197,94,0.14)" />
          </linearGradient>
          <filter id="qbRingGlow" x="-140%" y="-140%" width="380%" height="380%">
            <feDropShadow dx="0" dy="0" stdDeviation="10" flood-color="rgba(59,130,246,0.26)" />
          </filter>
        </defs>

        <g :key="toolRingOpenSeq">
          <circle
            :cx="toolRingCenter"
            :cy="toolRingCenter"
            :r="toolRingOuterRadius + 2"
            fill="url(#qbRingBase)"
            stroke="rgba(148,163,184,0.35)"
            stroke-width="1"
          />
          <circle
            :cx="toolRingCenter"
            :cy="toolRingCenter"
            :r="toolRingInnerRadius - 2"
            fill="rgba(255,255,255,0.74)"
            stroke="rgba(148,163,184,0.35)"
            stroke-width="1"
          />

          <g filter="url(#qbRingGlow)">
            <path
              v-for="(it, idx) in toolRingItems"
              :key="it.key"
              :d="getToolRingSectorPath(idx, toolRingItems.length)"
              :style="getToolRingSectorStyle(idx)"
              :fill="toolRingHoverKey === it.key ? 'url(#qbWedgeHover)' : 'rgba(255,255,255,0.62)'"
              :stroke="toolRingHoverKey === it.key ? 'rgba(59,130,246,0.58)' : 'rgba(148,163,184,0.50)'"
              stroke-width="1"
            />

            <g
              v-for="(it, idx) in toolRingItems"
              :key="`t-${it.key}`"
              :style="getToolRingIconStyle(idx, toolRingItems.length, toolRingHoverKey === it.key)"
              v-html="it.iconSvg"
            ></g>
          </g>
        </g>
        </svg>

        <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
          <div class="text-xs text-gray-500">工具环</div>
          <div class="mt-0.5 text-sm font-medium text-gray-800">
            {{ toolRingHoverLabel || '拖到扇形松开' }}
          </div>
        </div>
      </div>
    </div>

    <!-- Toast 容器：右上角非阻塞提示 -->
    <div class="absolute top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="pointer-events-auto max-w-[min(360px,92vw)] rounded-md border px-3 py-2 text-sm shadow-lg backdrop-blur bg-white/90"
        :class="{
          'border-green-200 text-green-700': t.type === 'success',
          'border-red-200 text-red-700': t.type === 'error',
          'border-yellow-200 text-yellow-800': t.type === 'warning',
          'border-gray-200 text-gray-700': t.type === 'info'
        }"
      >
        {{ t.message }}
      </div>
    </div>

    <div class="absolute top-4 left-1/2 -translate-x-1/2 z-40 pointer-events-auto select-none">
      <div class="relative">
        <div
          class="rounded-full border border-gray-200/70 bg-white/72 backdrop-blur shadow-md px-2 py-1.5 opacity-90 hover:opacity-100 transition-opacity"
        >
          <div class="flex items-center gap-1">
            <button
              @click="toggleToolbarExpanded"
              :class="simpleBtnClass()"
              :title="toolbarShowAdvanced ? '收起更多操作' : '展开更多操作'"
            >
              <span class="text-base">{{ toolbarShowAdvanced ? '▾' : '▸' }}</span>
              <span class="text-sm">更多</span>
            </button>

            <button @click="openHelp" :class="simpleBtnClass()" title="快捷键与帮助 (?)">
              <span class="text-base">?</span>
              <span class="text-sm">帮助</span>
            </button>

            <div class="mx-1 h-6 w-px bg-gray-200" />

            <button @click="setTool('select')" :class="toolBtnClass('select')" title="选择/移动 (V)">
              <span class="text-sm">选择</span>
            </button>

            <button @click="setTool('pencil')" :class="toolBtnClass('pencil')" title="画笔 (P)">
              <span class="text-sm">画笔</span>
            </button>

            <button @click="setTool('eraser')" :class="toolBtnClass('eraser')" title="橡皮 (E) 点到对象就删除">
              <span class="text-sm">橡皮</span>
            </button>

            <div class="ml-1 text-[11px] text-gray-500 whitespace-nowrap">
              右键/长按：调色盘工具环
            </div>
          </div>
        </div>

        <div class="absolute left-1/2 -translate-x-1/2 mt-2 w-[min(820px,92vw)]">
            <div
            class="rounded-2xl border border-gray-200/70 bg-white/76 backdrop-blur shadow-lg p-3 origin-top overflow-hidden transition-all duration-200 ease-out"
            :class="
              toolbarShowAdvanced
                ? 'max-h-[480px] opacity-100 translate-y-0 scale-100'
                : 'max-h-0 opacity-0 -translate-y-1 scale-[0.98] pointer-events-none'
            "
          >
            <div class="flex flex-col gap-3">
              <div class="flex flex-wrap items-center gap-1">
                <div class="text-xs font-medium text-gray-600 mr-2">工具</div>

                <button @click="setTool('select')" :class="toolBtnClass('select')" title="选择/移动 (V)">
                  <span class="text-sm">选择</span>
                </button>

                <button @click="setTool('pencil')" :class="toolBtnClass('pencil')" title="画笔 (P)">
                  <span class="text-sm">画笔</span>
                </button>

                <button @click="setTool('eraser')" :class="toolBtnClass('eraser')" title="橡皮 (E) 点到对象就删除">
                  <span class="text-sm">橡皮</span>
                </button>

                <button @click="setTool('rect')" :class="simpleBtnClass()" title="矩形 (R)">
                  <span v-if="!toolbarCompact">矩形</span>
                </button>

                <button @click="setTool('circle')" :class="simpleBtnClass()" title="圆形 (C)">
                  <span v-if="!toolbarCompact">圆形</span>
                </button>

                <button @click="insertFormula" :class="simpleBtnClass()" title="插入公式（LaTeX，编辑时上锁）">
                  <span v-if="!toolbarCompact">公式</span>
                </button>

                <button
                  @click="startFormulaRecognize"
                  :disabled="isFormulaRecognizing || !isOnline"
                  :class="simpleBtnDisabledClass()"
                  :title="isOnline ? '识别手写公式（框选区域 → 转 LaTeX）' : '离线中：识别需要后端服务'"
                >
                  <span v-if="!toolbarCompact">识别</span>
                </button>
              </div>

              <div class="flex flex-wrap items-center gap-1">
                <div class="text-xs font-medium text-gray-600 mr-2">操作</div>

                <button @click="performUndo" :class="simpleBtnClass()" title="撤销 (Ctrl+Z)">
                  <span v-if="!toolbarCompact">撤销</span>
                </button>

                <button @click="performRedo" :class="simpleBtnClass()" title="重做 (Ctrl+Y / Ctrl+Shift+Z)">
                  <span v-if="!toolbarCompact">重做</span>
                </button>

                <button @click="exportPng" :class="simpleBtnClass()" title="导出 PNG（当前视图）">
                  <span v-if="!toolbarCompact">PNG</span>
                </button>

                <button @click="exportJson" :class="simpleBtnClass()" title="导出 JSON（画布对象）">
                  <span v-if="!toolbarCompact">JSON</span>
                </button>

                <button @click="resetView" :class="simpleBtnClass()" title="复位视图 (Ctrl+0 / 双击画布)">
                  <span v-if="!toolbarCompact">复位</span>
                </button>

                <button
                  @click="requestFullSync"
                  :disabled="!canRequestSync"
                  :class="simpleBtnDisabledClass()"
                  :title="canRequestSync ? '强制从服务端拉全量快照，用于不同步时的兜底对齐' : '离线中：等待重连后再对齐'"
                >
                  <span v-if="!toolbarCompact">对齐</span>
                </button>

                <button @click="copyRoomLink" :class="simpleBtnClass()" title="复制房间链接">
                  <span v-if="!toolbarCompact">分享</span>
                </button>

                <button @click="openShareQr" :class="simpleBtnClass()" title="显示房间二维码（扫码加入）">
                  <span v-if="!toolbarCompact">二维码</span>
                </button>
              </div>

              <div class="flex flex-wrap items-center gap-1">
                <div class="text-xs font-medium text-gray-600 mr-2">房间</div>

                <input
                  v-model="myName"
                  class="h-9 w-28 px-2 rounded-md border border-gray-200 text-sm bg-white/70 focus:outline-none focus:ring-2 focus:ring-blue-200"
                  placeholder="昵称"
                  title="昵称（回车/失焦保存）"
                  @keydown.enter="saveMyName"
                  @blur="saveMyName"
                />

                <input
                  v-model="roomIdInput"
                  class="h-9 w-32 px-2 rounded-md border border-gray-200 text-sm bg-white/70 focus:outline-none focus:ring-2 focus:ring-blue-200"
                  placeholder="room id"
                  title="输入房间号并回车/点击进入"
                  @keydown.enter="goToRoom"
                />

                <button @click="goToRoom" :class="simpleBtnClass()" title="进入房间（会刷新页面）">
                  <span v-if="!toolbarCompact">进入</span>
                </button>

                <button @click="clearCanvas" :class="dangerBtnClass()" title="删除全部内容（会同步给房间内所有人）">
                  <span v-if="!toolbarCompact">清空内容</span>
                </button>

                <button
                  @click="resetRoom"
                  :disabled="!isOnline"
                  :class="dangerBtnDisabledClass()"
                  :title="isOnline ? '重置房间（清除云端存档与撤销栈，所有人都会被清空）' : '离线中：无法重置房间'"
                >
                  <span v-if="!toolbarCompact">重置房间</span>
                </button>
              </div>

              <div v-if="toolbarCompact" class="text-[10px] text-gray-500">
                <span :title="onlineUsersLabel">在线 {{ onlineUsersCount }} 人</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      class="absolute bottom-4 right-4 z-40 w-[min(360px,92vw)] rounded-xl border border-gray-200 bg-white/85 backdrop-blur px-3 py-2 shadow-md pointer-events-auto"
    >
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span
            class="inline-flex h-2.5 w-2.5 rounded-full"
            :class="{
              'bg-green-500': connectionState === 'connected',
              'bg-yellow-400': connectionState === 'connecting',
              'bg-red-500': connectionState === 'disconnected'
            }"
          />
          <div class="text-xs text-gray-700">
            <span class="font-medium">{{ ROOM_ID }}</span>
            <span class="ml-1 text-gray-500">
              <span v-if="connectionState === 'connected'">在线</span>
              <span v-else-if="connectionState === 'connecting'">连接中</span>
              <span v-else>离线</span>
            </span>
          </div>
        </div>
        <button
          @click="requestFullSync"
          :disabled="!canRequestSync"
          class="h-8 px-2 rounded-md text-xs border border-gray-200 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          :title="canRequestSync ? '对齐同步' : '离线中：等待重连后再对齐'"
        >
          对齐
        </button>
      </div>

      <div v-if="connectionState === 'disconnected'" class="mt-1 text-[11px] text-red-600">
        离线中：你的本地绘制不会同步给其他人
      </div>

      <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-gray-600">
        <span v-if="onlineUsersCount" :title="onlineUsersLabel">在线 {{ onlineUsersCount }} 人</span>
        <span v-if="selectedFormulaLockLabel">{{ selectedFormulaLockLabel }}</span>
        <span v-if="formulaRecognizeHint">{{ formulaRecognizeHint }}</span>
      </div>

      <div v-if="syncErrorLabel" class="mt-1 text-[11px] text-red-600">
        对齐失败：{{ syncErrorLabel }}
      </div>
      <div v-else-if="lastSyncAt" class="mt-1 text-[11px] text-gray-600">
        最近对齐：{{ new Date(lastSyncAt).toLocaleTimeString() }}
      </div>

      <div v-if="netSimEnabled" class="mt-1 text-[11px] text-gray-600" :title="netSimTooltip">
        弱网：{{ netSimLabel }}
      </div>
    </div>

    <div v-if="helpOpen" class="absolute inset-0 z-40 bg-black/30 flex items-center justify-center pointer-events-auto">
      <div class="w-[min(560px,92vw)] bg-white rounded-lg shadow-xl border border-gray-200 p-4">
        <div class="flex items-center justify-between gap-2">
          <div class="text-sm font-medium text-gray-800">快捷键与小贴士</div>
          <button
            @click="closeHelp"
            class="h-8 px-2 rounded-md border border-gray-200 hover:bg-gray-50 text-sm"
            title="关闭 (Esc)"
          >
            关闭
          </button>
        </div>
        <div class="mt-2 text-sm text-gray-600">
          快速上手：选中工具 → 画/拖/缩放 → 分享房间链接。
        </div>

        <div class="mt-2 text-xs text-gray-500">
          矩形/圆形：切到工具后，在画布上<strong>按住拖拽</strong>创建；<span class="font-mono">Esc</span> 可取消。
        </div>

        <div class="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
          <div class="rounded-md border border-gray-200 bg-gray-50 p-3">
            <div class="text-xs font-medium text-gray-700">工具</div>
            <div class="mt-1 text-xs text-gray-600 space-y-1">
              <div><span class="font-mono">V</span> 选择/移动</div>
              <div><span class="font-mono">P</span> 画笔</div>
              <div><span class="font-mono">E</span> 橡皮（点到对象就删除）</div>
              <div><span class="font-mono">R</span> 矩形</div>
              <div><span class="font-mono">C</span> 圆形</div>
            </div>
          </div>

          <div class="rounded-md border border-gray-200 bg-gray-50 p-3">
            <div class="text-xs font-medium text-gray-700">视图</div>
            <div class="mt-1 text-xs text-gray-600 space-y-1">
              <div><span class="font-mono">Space</span> 按住拖拽平移</div>
              <div><span class="font-mono">Ctrl/⌘ + 0</span> 复位视图</div>
              <div><span class="font-mono">Ctrl/⌘ + +/-</span> 缩放</div>
              <div>双击画布：复位视图 / 公式对象双击编辑</div>
            </div>
          </div>

          <div class="rounded-md border border-gray-200 bg-gray-50 p-3">
            <div class="text-xs font-medium text-gray-700">历史</div>
            <div class="mt-1 text-xs text-gray-600 space-y-1">
              <div><span class="font-mono">Ctrl/⌘ + Z</span> 撤销</div>
              <div><span class="font-mono">Ctrl/⌘ + Y</span> 重做</div>
              <div><span class="font-mono">Ctrl/⌘ + Shift + Z</span> 重做</div>
            </div>
          </div>

          <div class="rounded-md border border-gray-200 bg-gray-50 p-3">
            <div class="text-xs font-medium text-gray-700">识别与同步</div>
            <div class="mt-1 text-xs text-gray-600 space-y-1">
              <div><span class="font-mono">Esc</span> 取消框选识别 / 关闭帮助</div>
              <div>不同步时：点右下角“对齐”兜底</div>
              <div>想复现弱网：URL 加 <span class="font-mono">netsim=1</span></div>
            </div>
          </div>
        </div>

        <div class="mt-3 text-xs text-gray-500">
          轻量小乐趣：把链接发给朋友，一起画出“同步的涂鸦”。
        </div>
      </div>
    </div>

    <!-- 确认弹窗：用于危险操作（清空/重置） -->
    <div v-if="confirmOpen" class="absolute inset-0 z-40 bg-black/30 flex items-center justify-center pointer-events-auto">
      <div class="w-[min(420px,92vw)] bg-white rounded-lg shadow-xl border border-gray-200 p-4">
        <div class="text-sm font-medium text-gray-800">{{ confirmTitle }}</div>
        <div class="mt-2 text-sm text-gray-600 whitespace-pre-wrap">{{ confirmMessage }}</div>
        <div class="mt-4 flex justify-end gap-2">
          <button
            @click="closeConfirm(false)"
            class="px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50 text-sm"
          >
            {{ confirmCancelText }}
          </button>
          <button
            @click="closeConfirm(true)"
            class="px-3 py-1.5 rounded bg-red-600 hover:bg-red-700 text-white text-sm"
          >
            {{ confirmOkText }}
          </button>
        </div>
      </div>
    </div>

    <!-- 手动复制弹窗：剪贴板 API 失败时兜底 -->
    <div v-if="manualCopyOpen" class="absolute inset-0 z-40 bg-black/30 flex items-center justify-center pointer-events-auto">
      <div class="w-[min(520px,92vw)] bg-white rounded-lg shadow-xl border border-gray-200 p-4">
        <div class="text-sm font-medium text-gray-800">手动复制链接</div>
        <div class="mt-2 text-xs text-gray-500">浏览器未授予剪贴板权限或环境限制，已提供可手动复制的链接。</div>
        <input
          :value="manualCopyText"
          readonly
          class="mt-3 w-full h-10 px-2 rounded border border-gray-200 text-sm font-mono"
          @focus="$event.target && $event.target.select && $event.target.select()"
        />
        <div class="mt-4 flex justify-end gap-2">
          <button
            @click="closeManualCopy"
            class="px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50 text-sm"
          >
            关闭
          </button>
        </div>
      </div>
    </div>

    <div v-if="shareQrOpen" class="absolute inset-0 z-40 bg-black/30 flex items-center justify-center pointer-events-auto">
      <div class="w-[min(520px,92vw)] bg-white rounded-lg shadow-xl border border-gray-200 p-4">
        <div class="text-sm font-medium text-gray-800">扫码加入房间</div>
        <div class="mt-2 text-xs text-gray-500">把二维码展示给对方，对方用手机扫码即可打开并加入该房间。</div>
        <div class="mt-3 flex items-center justify-center">
          <div v-if="shareQrDataUrl" class="p-3 rounded-lg border border-gray-200 bg-white">
            <img :src="shareQrDataUrl" alt="Room QR" class="w-[240px] h-[240px]" />
          </div>
          <div v-else class="text-xs text-gray-500">二维码生成失败，请改用“分享”复制链接。</div>
        </div>
        <input
          :value="shareQrLink"
          readonly
          class="mt-3 w-full h-10 px-2 rounded border border-gray-200 text-sm font-mono"
          @focus="$event.target && $event.target.select && $event.target.select()"
        />
        <div class="mt-4 flex justify-end gap-2">
          <button
            @click="closeShareQr"
            class="px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50 text-sm"
          >
            关闭
          </button>
        </div>
      </div>
    </div>

    <div v-if="isFormulaEditorOpen" class="absolute inset-0 z-40 bg-black/30 flex items-center justify-center pointer-events-auto">
      <div class="w-[min(720px,92vw)] bg-white rounded-lg shadow-xl border border-gray-200 p-4">
        <div class="text-sm font-medium text-gray-700 mb-2">{{ formulaEditorTitle }}</div>
        <textarea
          v-model="formulaEditorValue"
          class="w-full h-40 p-2 border border-gray-200 rounded text-sm font-mono outline-none focus:ring-2 focus:ring-blue-200"
          placeholder="例如：\\frac{a}{b} + \\sqrt{x}"
        />
        <div class="mt-3 rounded border border-gray-200 bg-gray-50 p-3 overflow-auto max-h-56">
          <div v-if="formulaPreviewHtml" v-html="formulaPreviewHtml" />
          <div v-else class="text-xs text-gray-400">输入 LaTeX 后显示预览</div>
        </div>
        <div class="mt-3 flex justify-end gap-2">
          <button @click="closeFormulaEditor(true)" class="px-3 py-1.5 rounded border border-gray-200 hover:bg-gray-50 text-sm">
            取消
          </button>
          <button @click="saveFormulaEditor" class="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm">
            {{ formulaEditorOkText }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
:global(.qb-remote-cursor) {
  will-change: transform;
}

:global(.qb-remote-cursor) .qb-cursor-halo {
  position: absolute;
  width: 36px;
  height: 36px;
  border-radius: 999px;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  background: radial-gradient(circle, var(--qb-cursor-soft), transparent 62%);
  box-shadow: 0 0 0 0 var(--qb-cursor-soft);
  animation: qbCursorBreathe 1.8s ease-in-out infinite;
  opacity: 0.75;
  z-index: -1;
}

@keyframes qbCursorBreathe {
  0% {
    transform: translateX(-50%) scale(0.9);
    opacity: 0.55;
    box-shadow: 0 0 0 0 var(--qb-cursor-soft);
  }
  50% {
    transform: translateX(-50%) scale(1.15);
    opacity: 0.95;
    box-shadow: 0 0 18px 6px var(--qb-cursor-soft);
  }
  100% {
    transform: translateX(-50%) scale(0.9);
    opacity: 0.55;
    box-shadow: 0 0 0 0 var(--qb-cursor-soft);
  }
}
</style>
