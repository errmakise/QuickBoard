<script setup>
defineOptions({ name: 'WhiteboardBoard' })
import { onMounted, onUnmounted, ref } from 'vue';
import * as fabric from 'fabric';
import socketService from '../services/socket'; // 引入 Socket 服务
import crdtManager from '../utils/crdt/CRDTManager'; // 引入 CRDT 管理器
import historyManager, { AddCommand, RemoveCommand, ModifyCommand } from '../utils/History'; // 引入历史记录管理器

// --- 状态变量 ---
const isDev = import.meta.env?.DEV === true;
const canvasEl = ref(null); // 对应 <canvas ref="canvasEl">
let canvas = null; // 存放 Fabric Canvas 实例 (注意：不要用 ref 包裹它！)
const objectMap = new Map(); // id -> fabricObject (用于快速查找)

// --- 光标相关 ---
const cursorMap = new Map(); // userId -> { element, x, y }
const myName = 'User ' + Math.floor(Math.random() * 1000); // 随机生成我的名字

// 当前选中的工具：'pencil' (画笔) | 'select' (选择/移动) | 'rect' (矩形) | 'circle' (圆形)
const currentTool = ref('pencil');
// socket 实例由 socketService 管理

// 定义一个房间ID，暂时写死，后续可以做成动态的
const ROOM_ID = 'demo-room';
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

// 生成唯一ID
const generateId = () => crypto.randomUUID();

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

  // 5. 监听鼠标移动 (发送光标位置)
  canvas.on('mouse:move', (e) => {
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
        userName: myName
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
  canvas.on('mouse:down', () => { isMouseDown = true; });
  canvas.on('mouse:up', () => { isMouseDown = false; });

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
  if (canvas) canvas.dispose();
  socketService.disconnect();
});

// --- 方法：Socket 初始化 ---
const initSocket = () => {
  // 连接后端服务器并加入房间
  socketService.connect(ROOM_ID);

  // 监听：CRDT 远程更新
  socketService.on('draw-event', (crdtState) => {
    // console.log('📩 Received CRDT update:', crdtState);
    handleRemoteUpdate(crdtState);
  });

  // 监听：全量同步 (Initial Sync)
  socketService.on('sync-state', (allObjects) => {
    console.log('📦 Received initial sync state:', allObjects.length, 'objects');
    // 遍历所有对象，逐个合并
    allObjects.forEach(state => {
      // 由于 enlivenObjects 是异步的，为了保证顺序和性能，这里可以优化
      // 但 MVP 阶段逐个调用也无妨
      handleRemoteUpdate(state);
    });
  });

  // 监听：用户加入
  socketService.on('user-joined', (data) => {
    console.log('👋 User joined:', data.userId);
  });

  // 监听：光标移动
  socketService.on('cursor-move', (data) => {
    // console.log('🖱️ Cursor move:', data.userId, data.x, data.y); // 调试日志
    updateRemoteCursor(data);
  });

  // 监听：实时绘图 (Ghost Brush)
  socketService.on('drawing-process', (data) => {
    // console.log('👻 Ghost drawing:', data.userId, data.x, data.y);
    renderGhostPath(data);
  });

  // 监听：用户离开
  socketService.on('user-left', (data) => {
    removeRemoteCursor(data.userId);
  });
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
      cursor = { el };
      cursorMap.set(userId, cursor);
    } else {
      return;
    }
  }

  // 更新位置 (使用 transform 性能更好)
  // 注意：我们使用 CSS transform 来移动光标
  // 必须确保 .absolute 的父容器 (div.relative) 的左上角与 Canvas 的 (0,0) 重合
  // translate(x, y) 是相对于元素初始位置的偏移
  // 如果元素初始 left/top 未设置，可能会受 padding/margin 影响
  // 所以我们在 style 中强制设置 left:0, top:0
  cursor.el.style.left = '0px';
  cursor.el.style.top = '0px';
  cursor.el.style.transform = `translate(${x}px, ${y}px)`;
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
    }
  }
};

// --- 方法：切换工具 ---
const setTool = (tool) => {
  currentTool.value = tool;
  if (!canvas) return;

  // 1. 处理绘图模式开关
  if (tool === 'pencil') {
    canvas.isDrawingMode = true; // 开启画笔
  } else {
    canvas.isDrawingMode = false; // 关闭画笔 (进入选择模式)
  }

  // 2. 处理添加形状逻辑
  if (tool === 'rect') {
    addRect();
    // 添加完后，自动切回选择模式，方便用户拖拽
    // 同时也更新 UI 状态
    currentTool.value = 'select';
  } else if (tool === 'circle') {
    addCircle();
    currentTool.value = 'select';
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

      <div class="w-px h-8 bg-gray-200 mx-1"></div> <!-- 分隔线 -->

      <!-- 形状工具 -->
      <button @click="setTool('rect')" class="p-2 rounded hover:bg-gray-100 transition" title="添加矩形">
        ⬛ 矩形
      </button>

      <button @click="setTool('circle')" class="p-2 rounded hover:bg-gray-100 transition" title="添加圆形">
        ⭕ 圆形
      </button>

      <div class="w-px h-8 bg-gray-200 mx-1"></div> <!-- 分隔线 -->

      <!-- 操作工具 -->
      <button @click="clearCanvas" class="p-2 rounded hover:bg-red-100 text-red-500 transition" title="清空画布">
        🗑️ 清空
      </button>
      <!-- 连接状态指示器 -->
      <div
        class="absolute bottom-4 right-4 bg-white/80 backdrop-blur px-3 py-1 rounded-full text-xs text-gray-500 shadow-sm border border-gray-200">
        Room: demo-room 🟢 Connected
      </div>
    </div>
  </div>
</template>

<style scoped></style>
