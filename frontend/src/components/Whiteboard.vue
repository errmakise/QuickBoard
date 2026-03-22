<script setup>
defineOptions({ name: 'WhiteboardBoard' })
import { computed, onMounted, onUnmounted, ref } from 'vue';
import * as fabric from 'fabric';
import katex from 'katex';
import socketService from '../services/socket'; // 引入 Socket 服务
import crdtManager from '../utils/crdt/CRDTManager'; // 引入 CRDT 管理器
import historyManager, { AddCommand, RemoveCommand, ModifyCommand } from '../utils/History'; // 引入历史记录管理器

// --- 状态变量 ---
const isDev = import.meta.env?.DEV === true;
const canvasEl = ref(null); // 对应 <canvas ref="canvasEl">
let canvas = null; // 存放 Fabric Canvas 实例 (注意：不要用 ref 包裹它！)
const objectMap = new Map(); // id -> fabricObject (用于快速查找)
// Socket 连接状态（用于 UI 展示；不参与协同逻辑）
// - connecting: 正在建立连接/重连中
// - connected: 连接已建立
// - disconnected: 连接断开（可能会自动重连）
const connectionState = ref('connecting');

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

const applyServerEpoch = (serverEpoch) => {
  const next = typeof serverEpoch === 'string' ? serverEpoch.trim() : '';
  if (!next) return;
  if (currentServerEpoch && currentServerEpoch !== next) {
    lastServerVersion = 0;
    socketService.setClientVersion(0);
  }
  currentServerEpoch = next;
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
const cursorMap = new Map(); // userId -> { element, x, y }
//
// 昵称策略（给外行看的解释）：
// - 昵称只用于“展示身份”（光标标签/锁提示/成员列表），不影响 CRDT 数据正确性；
// - 这里把昵称存在 localStorage，保证刷新页面后仍然是同一个名字；
// - 同时把昵称同步给服务端，让其它用户能在 user-joined / user-left / user-name 等事件里看到名字。
const NAME_STORAGE_KEY = 'qb:nickname';
let initialName = '';
try {
  initialName = String(localStorage.getItem(NAME_STORAGE_KEY) || '').trim();
} catch (e) {
  initialName = '';
}
const myName = ref(initialName || `User ${Math.floor(Math.random() * 1000)}`);
try {
  if (!initialName) localStorage.setItem(NAME_STORAGE_KEY, myName.value);
} catch (e) {
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
  } catch (e) {
  }

  // 通知服务端“我改名了”，避免必须等我移动鼠标（cursor-move）别人才看到新名字。
  // 这里使用带 ack 的事件：如果离线，会返回 DISCONNECTED，我们直接忽略即可。
  await socketService.emitWithAck('set-user-name', { userName: next }, 2000);
};

const lockState = ref({});
const isFormulaEditorOpen = ref(false);
const formulaEditorValue = ref('');
const formulaPreviewHtml = computed(() => {
  const src = (formulaEditorValue.value || '').trim();
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
let suppressNextLocalPathCreated = false;
let suppressNextLocalPathCreatedTimeout = null;

// --- 视图交互：平移/缩放 (Pan & Zoom) ---
// 目标：每个客户端都可以自由漫游自己的视图（不影响协同数据，只改变本地 viewportTransform）
let panKeyPressed = false; // 是否按住空格（按住空格拖拽平移）
let isPanning = false; // 是否正在拖拽平移中
let lastPanClientX = 0;
let lastPanClientY = 0;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;

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

  // 1. 初始化 Fabric Canvas
  const fabricCanvas = new fabric.Canvas(canvasEl.value, {
    isDrawingMode: true, // 默认开启自由绘图模式
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: '#ffffff',
  });
  canvas = fabricCanvas;
  if (isDev) {
    window.__canvas = canvas;
  }

  // 2. 配置画笔样式
  const brush = new fabric.PencilBrush(canvas);
  brush.width = 5;
  brush.color = '#000000';
  canvas.freeDrawingBrush = brush;

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

    // 节流发送 (Throttle)
    // 鼠标移动事件触发频率极高 (每秒60+次)，如果每次都发送 WebSocket 消息，会造成“网络风暴”
    // 所以我们限制发送频率，每 50ms (即每秒 20 次) 最多发送一次
    const now = Date.now();
    const pointer = e.scenePoint;
    if (!pointer) return;

    // 1. 发送光标位置 (50ms 节流)
    if (now - lastCursorSend > 50) {
      socketService.emit('cursor-move', {
        roomId: ROOM_ID,
        x: pointer.x,
        y: pointer.y,
        userName: myName.value
      });
      lastCursorSend = now;
    }

    // 2. 发送实时绘图路径 (如果正在绘图)
    // 调试：打印状态
    // console.log('Move:', canvas.isDrawingMode, isMouseDown, e.e.buttons);

    if (canvas.isDrawingMode && (isMouseDown || e.e.buttons === 1)) {
      // console.log('✏️ Emit drawing:', pointer.x, pointer.y);
      socketService.emit('drawing-process', {
        roomId: ROOM_ID,
        x: pointer.x,
        y: pointer.y,
        isEnd: false
      });
    }
  });

  // 手动追踪鼠标按键状态
  canvas.on('mouse:down', (e) => {
    isMouseDown = true;
    // 如果本次 mouse down 用于平移视图，则不认为“正在绘图按下”
    if (handleCanvasPanStart(e)) {
      isMouseDown = false;
    }
  });
  canvas.on('mouse:up', (e) => {
    isMouseDown = false;
    handleCanvasPanEnd(e);
  });

  canvas.on('mouse:down', handleFormulaRecognizeMouseDown);
  canvas.on('mouse:move', handleFormulaRecognizeMouseMove);
  canvas.on('mouse:up', handleFormulaRecognizeMouseUp);

  // 监听绘图结束，发送一个结束信号 (Ghost Brush)
  canvas.on('path:created', (e) => {
    // 仅用于结束远程的 Ghost 绘制状态
    socketService.emit('drawing-process', {
      roomId: ROOM_ID,
      isEnd: true
    });

    // 自由画笔路径在某些版本下 object:added 时机不稳定，这里在 path:created 明确入栈与广播
    const pathObj = e && (e.path || e.target);
    if (!pathObj) return;

    // 跳过远端创建的对象
    if (pathObj.__fromRemote === true) return;

    // 确保有 ID
    if (!pathObj.id) {
      pathObj.id = generateId();
    }

    // 记录到 Map，方便后续撤销查找
    objectMap.set(pathObj.id, pathObj);

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
    // 避免将远程添加的对象误判为本地操作（由 handleRemoteUpdate 标记）
    if (obj.__fromRemote === true) {
      return;
    }
    // 自由画笔路径改由 path:created 负责入栈/广播，避免双重入栈
    if (obj.type === 'path') {
      return;
    }

    // 1. 分配 ID (如果还没有)
    if (!obj.id) {
      obj.id = generateId();
    }

    // 2. 存入 Map
    objectMap.set(obj.id, obj);

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
  initSocket();
});


// --- 生命周期：卸载 ---
onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
  window.removeEventListener('keydown', handleKeydown);
  window.removeEventListener('keyup', handleKeyup);
  cancelFormulaRecognize();
  void closeFormulaEditor(true);
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
    const allObjects = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.objects) ? payload.objects : []);
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
    console.log('📦 Received initial sync state:', allObjects.length, 'objects');
    // 初次同步/重连同步都是“服务端快照 + 后续增量”的模型：服务端只发存活对象，
    // 本地如果曾记录 tombstone（_deleted），不会因为快照缺少 _deleted 字段而被复活。
    // 遍历所有对象，逐个合并
    allObjects.forEach(state => {
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
    applyRoomClear();
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

  ghostPaths.clear();

  for (const userId of Array.from(cursorMap.keys())) {
    removeRemoteCursor(userId);
  }

  if (canvas && canvas.contextTop && canvas.clearContext) {
    canvas.clearContext(canvas.contextTop);
  }

  if (canvas) {
    canvas.clear();
    canvas.backgroundColor = '#ffffff';
  }

  objectMap.clear();
  historyManager.reset();
  crdtManager.reset();
};

/**
 * 清理“临时层（Ephemeral Layer）”状态：不影响正式对象、不会写入持久化。
 * 包含：
 * - Ghost Brush 预览线（按点流绘制的灰色 polyline）
 * - 远程光标 DOM
 * - Top context（Fabric 的上层临时绘制层）
 */
const cleanupEphemeralState = () => {
  ghostPaths.clear();

  for (const userId of Array.from(cursorMap.keys())) {
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
    alert('已复制房间链接');
  } catch {
    window.prompt('复制失败，请手动复制：', link);
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
    canvas.defaultCursor = 'crosshair';
    canvas.hoverCursor = 'crosshair';
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
  cleanupFormulaRecognizeRect();
  applyFormulaRecognizeMode(false);
};

const startFormulaRecognize = () => {
  if (!canvas) return;
  if (isFormulaRecognizing.value) return;
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

const recognizeMathFromImage = async (imageDataUrl) => {
  const envUrl = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
  const protocol = String(window.location?.protocol || 'http:');
  const host = String(window.location?.hostname || 'localhost');
  const apiUrl = envUrl || `${protocol}//${host}:3000`;

  try {
    const resp = await fetch(`${apiUrl}/api/recognize-math`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const error = data && typeof data.error === 'string' ? data.error : 'HTTP_ERROR';
      const status =
        data && typeof data.status === 'number' ? data.status : typeof resp.status === 'number' ? resp.status : 0;
      return { ok: false, error, status };
    }
    return data || { ok: false, error: 'EMPTY_RESPONSE' };
  } catch {
    return { ok: false, error: 'NETWORK_ERROR' };
  }
};

const finalizeFormulaRecognize = async ({ left, top, width, height }) => {
  if (!canvas) return;
  if (isFormulaRecognizing.value) return;
  isFormulaRecognizing.value = true;

  cleanupFormulaRecognizeRect();

  const canvasW = canvas.getWidth();
  const canvasH = canvas.getHeight();
  const pad = Math.max(8, Math.min(24, Math.min(width, height) * 0.06));
  const cropLeft = Math.max(0, left - pad);
  const cropTop = Math.max(0, top - pad);
  const cropRight = Math.min(canvasW, left + width + pad);
  const cropBottom = Math.min(canvasH, top + height + pad);
  const cropWidth = Math.max(1, cropRight - cropLeft);
  const cropHeight = Math.max(1, cropBottom - cropTop);
  const longest = Math.max(cropWidth, cropHeight);
  let multiplier = longest > 600 ? 2 : longest > 350 ? 3 : 4;
  while (multiplier > 2 && (cropWidth * multiplier > 1600 || cropHeight * multiplier > 1600)) {
    multiplier -= 1;
  }

  const imageDataUrl = canvas.toDataURL({
    format: 'png',
    left: cropLeft,
    top: cropTop,
    width: cropWidth,
    height: cropHeight,
    multiplier
  });

  const result = await recognizeMathFromImage(imageDataUrl);
  const latex = typeof result?.latex === 'string' ? result.latex : '';
  const debugProcessed =
    result && result.debug && typeof result.debug.processedImageDataUrl === 'string'
      ? result.debug.processedImageDataUrl
      : '';
  if (debugProcessed) {
    window.__ocrDebugLast = result.debug;
    if (!window.__ocrDebugHintShown) {
      window.__ocrDebugHintShown = true;
      alert('已生成 OCR 调试图：按 F12 打开 Console，输入 window.__ocrDebugLast 查看。');
    }
  }

  isFormulaRecognizeMode.value = false;
  applyFormulaRecognizeMode(false);
  isFormulaRecognizing.value = false;

  if (!result || result.ok !== true) {
    const err = result?.error || 'UNKNOWN_ERROR';
    const status = typeof result?.status === 'number' ? result.status : null;
    const detail = typeof result?.detail === 'string' ? result.detail.trim() : '';
    if (err === 'NOT_CONFIGURED') {
      alert('识别服务未配置。');
    } else if (err === 'NETWORK_ERROR') {
      alert('识别失败：无法连接到后端（请确认后端已启动，且 VITE_API_URL 配置正确）。');
    } else if (err === 'UPSTREAM_ERROR') {
      alert(
        `识别失败：本地识别服务不可用或返回错误${status ? `（HTTP ${status}）` : ''}${detail ? `：${detail}` : ''}。`
      );
    } else if (err === 'EMPTY_LATEX') {
      alert('识别失败：识别服务未返回 latex。');
    } else {
      alert(`公式识别失败（${err}${status ? `, HTTP ${status}` : ''}），请重试或手动编辑。`);
    }
    return;
  }
  if (!latex.trim()) {
    alert('识别失败：返回的 LaTeX 为空，请重试或手动编辑。');
    return;
  }

  const textbox = new fabric.Textbox(latex, {
    left: cropLeft,
    top: cropTop,
    width: Math.max(220, Math.min(520, cropWidth)),
    fontSize: 22,
    fill: '#000000',
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderColor: '#93c5fd',
    cornerColor: '#3b82f6',
    padding: 6,
    editable: false
  });
  textbox.isFormula = true;
  textbox.latex = latex;
  textbox.excludeFromExport = false;

  canvas.add(textbox);
  canvas.setActiveObject(textbox);
  canvas.requestRenderAll();

  setTimeout(() => {
    if (!textbox.id) return;
    openFormulaEditor(textbox);
  }, 0);
};

const handleFormulaRecognizeMouseDown = (e) => {
  if (isFormulaRecognizeMode.value !== true) return;
  if (!canvas) return;
  if (isFormulaRecognizing.value) return;
  const p = e?.scenePoint;
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
  const p = e?.scenePoint;
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
  formulaEditorValue.value = '';
  formulaEditingObjectId = null;
  formulaEditingBeforeJson = null;
  formulaEditingLockResourceId = null;
};

const saveFormulaEditor = async () => {
  if (!canvas) return;
  if (!formulaEditingObjectId) return;

  const obj = objectMap.get(formulaEditingObjectId);
  if (!obj) {
    await closeFormulaEditor(true);
    return;
  }

  const beforeJson = formulaEditingBeforeJson || obj.toJSON();
  obj.latex = formulaEditorValue.value;
  obj.text = formulaEditorValue.value;

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
      alert(`该公式正在被「${name}」编辑中，请稍后再试。`);
    } else {
      alert('当前无法进入公式编辑，请稍后重试。');
    }
    return;
  }

  obj.editable = false;
  await closeFormulaEditor(false);

  formulaEditingObjectId = obj.id;
  formulaEditingBeforeJson = obj.toJSON();
  formulaEditingLockResourceId = resourceId;
  formulaEditorValue.value = typeof obj.latex === 'string' ? obj.latex : (obj.text || '');
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
      alert('公式编辑锁已失效，已自动退出编辑。');
    }
  }, 5000);
};

const insertFormula = () => {
  if (!canvas) return;

  const textbox = new fabric.Textbox('', {
    left: 200,
    top: 150,
    width: 260,
    fontSize: 22,
    fill: '#000000',
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderColor: '#93c5fd',
    cornerColor: '#3b82f6',
    padding: 6,
    editable: false
  });
  textbox.isFormula = true;
  textbox.latex = '';
  textbox.excludeFromExport = false;

  canvas.add(textbox);
  canvas.setActiveObject(textbox);
  canvas.requestRenderAll();

  setTimeout(() => {
    if (!textbox.id) return;
    openFormulaEditor(textbox);
  }, 0);
};

// --- 方法：处理本地鼠标移动 (节流发送) ---
let lastCursorSend = 0;

// --- 方法：渲染远程 Ghost Path ---
// 存储每个用户的临时路径点: userId -> [{x,y}, {x,y}...]
const ghostPaths = new Map();

const renderGhostPath = ({ userId, x, y, isEnd }) => {
  // 1. 如果是结束信号，清除临时路径
  if (isEnd) {
    const pathData = ghostPaths.get(userId);
    if (pathData) {
      if (pathData.tempLine) {
        canvas.remove(pathData.tempLine);
      }
      ghostPaths.delete(userId);
      canvas.requestRenderAll();
    }
    return;
  }

  // 2. 如果是新的点，添加到路径
  let pathData = ghostPaths.get(userId);
  if (!pathData) {
    pathData = { points: [], tempLine: null };
    ghostPaths.set(userId, pathData);
  }

  pathData.points.push({ x, y });

  // 3. 绘制/更新线段
  // 如果点太少，不画
  if (pathData.points.length < 2) return;

  // 移除旧线 (性能优化：实际应该更新 path data 而不是重建，但 fabric v6 更新 path 比较复杂)
  // 为了简单且高性能，我们用 Polyline
  if (pathData.tempLine) {
    canvas.remove(pathData.tempLine);
  }

  const polyline = new fabric.Polyline(pathData.points, {
    stroke: 'rgba(50, 50, 50, 0.8)', // 黑色，更明显
    strokeWidth: 4, // 加粗
    fill: 'transparent',
    strokeLineCap: 'round',
    strokeLineJoin: 'round',
    evented: false, // 不能被选中
    selectable: false,
    hoverCursor: 'default'
  });
  polyline.__isGhost = true;
  polyline.excludeFromExport = true;

  pathData.tempLine = polyline;
  canvas.add(polyline);
  canvas.requestRenderAll();
};

// --- 方法：更新远程光标 ---
const updateRemoteCursor = ({ userId, x, y, userName }) => {
  let cursor = cursorMap.get(userId);

  if (!cursor) {
    // 创建光标元素 (使用 HTML DOM 覆盖在 Canvas 上)
    const el = document.createElement('div');
    // 设置基础样式：绝对定位，不阻挡鼠标事件，过渡效果
    el.className = 'absolute pointer-events-none transition-transform duration-100 ease-linear z-50 flex flex-col items-center';

    // 生成随机颜色 (或根据 userId 生成)
    const userColor = '#' + userId.slice(0, 6);

    el.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 2px rgba(0,0,0,0.2));">
        <path d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19177L11.7841 12.3673H5.65376Z" fill="${userColor}" stroke="white" stroke-width="1.5"/>
      </svg>
      <span class="text-white text-[10px] px-1.5 py-0.5 rounded-full shadow-sm mt-0.5 whitespace-nowrap" style="background-color: ${userColor};">${userName || userId.slice(0, 4)}</span>
    `;

    // 强制设置初始位置为 0,0，防止 translate 偏移错误
    el.style.left = '0px';
    el.style.top = '0px';

    // 将光标添加到 Canvas 容器的父级
    if (canvasEl.value && canvasEl.value.parentElement) {
      canvasEl.value.parentElement.appendChild(el);
      cursor = { el, x: 0, y: 0 };
      cursorMap.set(userId, cursor);
    } else {
      return;
    }
  }

  // 光标标签（昵称）需要可更新：
  // - 初次创建时会写入 userName；
  // - 但如果用户中途修改昵称（user-name 事件），或者 cursor-move 带了新名字，
  //   我们希望不用等“光标重建”也能更新文字。
  const span = cursor && cursor.el ? cursor.el.querySelector('span') : null;
  if (span) {
    span.textContent = userName || userId.slice(0, 4);
  }

  // 存储远端光标的“世界坐标（canvas 坐标）”，在视图平移/缩放时可用来重新计算屏幕位置
  cursor.x = x;
  cursor.y = y;

  applyRemoteCursorTransform(cursor);
};

/**
 * 将远端光标的“世界坐标”映射到当前视图的“屏幕坐标”，并更新 DOM 位置。
 * 说明：
 * - 协同传输的是世界坐标（对象/路径同一坐标系）；
 * - 每个客户端 viewportTransform 不同，所以必须在渲染阶段做一次变换。
 */
const applyRemoteCursorTransform = (cursor) => {
  if (!cursor?.el) return;
  if (!canvas) return;

  const vpt = canvas.viewportTransform;
  const worldPoint = new fabric.Point(cursor.x || 0, cursor.y || 0);
  const screenPoint = vpt ? fabric.util.transformPoint(worldPoint, vpt) : worldPoint;

  cursor.el.style.left = '0px';
  cursor.el.style.top = '0px';
  cursor.el.style.transform = `translate(${screenPoint.x}px, ${screenPoint.y}px)`;
};

/**
 * 当视图发生变化（平移/缩放）时，刷新所有远端光标的位置。
 */
const refreshRemoteCursors = () => {
  for (const cursor of cursorMap.values()) {
    applyRemoteCursorTransform(cursor);
  }
};

// --- 方法：移除远程光标 ---
const removeRemoteCursor = (userId) => {
  const cursor = cursorMap.get(userId);
  if (cursor) {
    cursor.el.remove();
    cursorMap.delete(userId);
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
        objectMap.set(obj.id, obj);
        canvas.add(obj);
        // 下一拍移除标记
        setTimeout(() => {
          delete obj.__fromRemote;
        }, 0);
      });
      canvas.renderAll();
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
      canvas.requestRenderAll();
    }
    isRemoteUpdate = false;
  }
};


// --- (以下是之前的绘图逻辑，保持不变) ---
const handleResize = () => {
  if (canvas) {
    canvas.setWidth(window.innerWidth);
    canvas.setHeight(window.innerHeight);
    canvas.renderAll();
  }
};

/**
 * 将“当前工具状态”应用到 Fabric Canvas。
 * 注意：这里仅控制本地交互（绘图/选择），不参与协同同步。
 */
const applyToolMode = () => {
  if (!canvas) return;

  if (currentTool.value === 'pencil') {
    canvas.isDrawingMode = true;
    canvas.selection = false;
  } else {
    canvas.isDrawingMode = false;
    canvas.selection = true;
  }
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

  if (isFormulaRecognizeMode.value === true && e.key === 'Escape') {
    e.preventDefault();
    cancelFormulaRecognize();
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

    // [关键修复] 撤销操作保护机制
    if (undoRedoInProgress) return; // 防止重复撤销

    undoRedoInProgress = true;
    isUndoRedo = true;

    // 执行撤销操作
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
    const cmd = historyManager.undo();
    if (isDev) {
      console.log('[UNDO]', cmd?.constructor?.name, cmd?.id);
    }

    // [关键修复] 延迟完成撤销操作，防止竞态条件
    // 等待所有异步操作完成后再重置标志
    if (undoRedoTimeout) clearTimeout(undoRedoTimeout);
    undoRedoTimeout = setTimeout(() => {
      isUndoRedo = false;
      undoRedoInProgress = false;
      if (isDev) {
        console.log('[Undo] Protection released');
      }
    }, 100); // 100ms 保护期

    return;
  }

  // 2. 处理重做 (Ctrl+Y 或 Ctrl+Shift+Z)
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
    e.preventDefault();

    // [关键修复] 重做操作保护机制
    if (undoRedoInProgress) return; // 防止重复重做

    undoRedoInProgress = true;
    isUndoRedo = true;

    // 执行重做操作
    historyManager.redo();

    // [关键修复] 延迟完成重做操作，防止竞态条件
    if (undoRedoTimeout) clearTimeout(undoRedoTimeout);
    undoRedoTimeout = setTimeout(() => {
      isUndoRedo = false;
      undoRedoInProgress = false;
      console.log('[Redo] Protection released');
    }, 100); // 100ms 保护期

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

  // 2. 处理添加形状逻辑
  if (tool === 'rect') {
    addRect();
    // 添加完后，自动切回选择模式，方便用户拖拽
    // 同时也更新 UI 状态
    currentTool.value = 'select';
    applyToolMode();
  } else if (tool === 'circle') {
    addCircle();
    currentTool.value = 'select';
    applyToolMode();
  }
};

// --- 方法：添加矩形 ---
const addRect = () => {
  const rect = new fabric.Rect({
    left: 100,
    top: 100,
    fill: 'transparent', // 填充透明
    stroke: 'black',     // 边框黑色
    strokeWidth: 3,
    width: 100,
    height: 100,
    rx: 5, // 圆角
    ry: 5
  });
  // id 会在 object:added 事件中生成
  canvas.add(rect);
  canvas.setActiveObject(rect); // 自动选中它
};

// --- 方法：添加圆形 ---
const addCircle = () => {
  const circle = new fabric.Circle({
    left: 250,
    top: 100,
    fill: 'transparent',
    stroke: 'black',
    strokeWidth: 3,
    radius: 50
  });
  canvas.add(circle);
  canvas.setActiveObject(circle);
};

// --- 方法：清空画布 ---
const clearCanvas = () => {
  if (confirm('确定要清空画布吗？')) {
    // 遍历所有对象进行 CRDT 删除
    const objects = canvas.getObjects();
    objects.forEach(obj => {
      if (obj.id) {
        // 生成 Tombstone 并广播
        const crdtState = crdtManager.delete(obj.id);
        if (crdtState) {
          socketService.emit('draw-event', {
            roomId: ROOM_ID,
            ...crdtState
          });
        }
      }
    });

    canvas.clear();
    canvas.backgroundColor = '#ffffff';
    objectMap.clear();
  }
};

const resetRoom = () => {
  if (confirm(`确定要重置房间「${ROOM_ID}」吗？所有人都会被清空，且会删除服务端保存的状态。`)) {
    socketService.emit('clear-room', { roomId: ROOM_ID });
  }
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
    const dataUrl = canvas.toDataURL({
      format: 'png',
      multiplier: 2
    });
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
    <!-- Canvas 容器 -->
    <canvas ref="canvasEl"></canvas>

    <!-- 
      工具栏悬浮层 (Overlay)
      pointer-events-auto: 允许点击按钮
    -->
    <div
      class="absolute top-4 left-1/2 -translate-x-1/2 bg-white px-4 py-2 rounded-lg shadow-lg border border-gray-200 flex gap-2 pointer-events-auto select-none">

      <!-- 选择工具 -->
      <button @click="setTool('select')" class="p-2 rounded hover:bg-gray-100 transition"
        :class="{ 'bg-blue-100 text-blue-600': currentTool === 'select' }" title="选择/移动 (V)">
        🖱️ 选择
      </button>

      <!-- 画笔工具 -->
      <button @click="setTool('pencil')" class="p-2 rounded hover:bg-gray-100 transition"
        :class="{ 'bg-blue-100 text-blue-600': currentTool === 'pencil' }" title="画笔 (P)">
        ✏️ 画笔
      </button>

      <div class="w-px h-8 bg-gray-200 mx-1"></div>

      <!-- 形状工具 -->
      <button @click="setTool('rect')" class="p-2 rounded hover:bg-gray-100 transition" title="添加矩形">
        ⬛ 矩形
      </button>

      <button @click="setTool('circle')" class="p-2 rounded hover:bg-gray-100 transition" title="添加圆形">
        ⭕ 圆形
      </button>

      <button @click="insertFormula" class="p-2 rounded hover:bg-gray-100 transition" title="插入公式（LaTeX，编辑时上锁）">
        ∑ 公式
      </button>
      <button
        @click="startFormulaRecognize"
        :disabled="isFormulaRecognizing"
        class="p-2 rounded hover:bg-gray-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
        title="公式识别（框选手写区域 → 转 LaTeX）"
      >
        🔍 识别
      </button>

      <div class="w-px h-8 bg-gray-200 mx-1"></div>

      <!-- 操作工具 -->
      <button @click="clearCanvas" class="p-2 rounded hover:bg-red-100 text-red-500 transition" title="清空画布">
        🗑️ 清空
      </button>
      <button @click="resetRoom" class="p-2 rounded hover:bg-red-100 text-red-500 transition" title="重置房间">
        ♻️ 重置
      </button>

      <div class="w-px h-8 bg-gray-200 mx-1"></div> <!-- 分隔线 -->

      <!-- 导出工具 -->
      <button @click="exportPng" class="p-2 rounded hover:bg-gray-100 transition" title="导出 PNG（当前视图）">
        🖼️ PNG
      </button>
      <button @click="exportJson" class="p-2 rounded hover:bg-gray-100 transition" title="导出 JSON（画布对象）">
        🧾 JSON
      </button>
      <button @click="resetView" class="p-2 rounded hover:bg-gray-100 transition" title="复位视图 (Ctrl+0 / 双击画布)">
        🧭 复位
      </button>

      <div class="w-px h-8 bg-gray-200 mx-1"></div> <!-- 分隔线 -->

      <input
        v-model="myName"
        class="h-9 w-28 px-2 rounded border border-gray-200 text-sm"
        placeholder="昵称"
        title="设置昵称（本地保存）"
        @keydown.enter="saveMyName"
        @blur="saveMyName"
      />

      <div class="w-px h-8 bg-gray-200 mx-1"></div>

      <!-- 房间工具：分享链接 / 切换房间 -->
      <button @click="copyRoomLink" class="p-2 rounded hover:bg-gray-100 transition" title="复制房间链接">
        🔗 分享
      </button>
      <input
        v-model="roomIdInput"
        class="h-9 w-32 px-2 rounded border border-gray-200 text-sm"
        placeholder="room id"
        title="输入房间号并回车/点击进入"
        @keydown.enter="goToRoom"
      />
      <button @click="goToRoom" class="p-2 rounded hover:bg-gray-100 transition" title="进入房间（会刷新页面）">
        ↩️ 进入
      </button>
      <!-- 连接状态指示器 -->
      <div
        class="absolute bottom-4 right-4 bg-white/80 backdrop-blur px-3 py-1 rounded-full text-xs text-gray-500 shadow-sm border border-gray-200">
        Room: {{ ROOM_ID }}
        <span v-if="connectionState === 'connected'">🟢 Connected</span>
        <span v-else-if="connectionState === 'connecting'">🟡 Connecting</span>
        <span v-else>🔴 Disconnected</span>
        <div v-if="onlineUsersCount" class="mt-0.5 text-[10px] text-gray-600" :title="onlineUsersLabel">
          在线：{{ onlineUsersCount }}人
        </div>
        <div v-if="selectedFormulaLockLabel" class="mt-0.5 text-[10px] text-gray-600">
          {{ selectedFormulaLockLabel }}
        </div>
        <div v-if="formulaRecognizeHint" class="mt-0.5 text-[10px] text-gray-600">
          {{ formulaRecognizeHint }}
        </div>
      </div>
    </div>

    <div v-if="isFormulaEditorOpen" class="absolute inset-0 bg-black/30 flex items-center justify-center pointer-events-auto">
      <div class="w-[min(720px,92vw)] bg-white rounded-lg shadow-xl border border-gray-200 p-4">
        <div class="text-sm font-medium text-gray-700 mb-2">编辑公式（LaTeX）</div>
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
            保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped></style>
