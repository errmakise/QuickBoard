<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import * as fabric from 'fabric'; 
import socketService from '../services/socket'; // 引入 Socket 服务

// --- 状态变量 ---
const canvasEl = ref(null); // 对应 <canvas ref="canvasEl">
let canvas = null; // 存放 Fabric Canvas 实例 (注意：不要用 ref 包裹它！)

// 当前选中的工具：'pencil' (画笔) | 'select' (选择/移动) | 'rect' (矩形) | 'circle' (圆形)
const currentTool = ref('pencil');
// socket 实例由 socketService 管理

// 定义一个房间ID，暂时写死，后续可以做成动态的
const ROOM_ID = 'demo-room';
// 标记是否是远程更新，防止回环死锁
let isRemoteUpdate = false; 

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

  // 2. 配置画笔样式
  const brush = new fabric.PencilBrush(canvas);
  brush.width = 5;
  brush.color = '#000000';
  canvas.freeDrawingBrush = brush;

  // 3. 监听窗口大小改变
  window.addEventListener('resize', handleResize);
  
  // 4. 监听键盘删除键 (Delete/Backspace)
  window.addEventListener('keydown', handleKeydown);

  // 2. 初始化 Socket 连接
  initSocket();

  // 3. 监听 Canvas 变动 (核心：将本地操作发给服务器)
  // 'path:created' 是自由绘图完成时触发的事件
  canvas.on('path:created', (e) => {
    if (isRemoteUpdate) return; // 如果是远程同步过来的，就不再发回去了
    
    // 序列化对象
    const json = e.path.toJSON(); 
    // 发送给服务器
    socketService.emit('draw-event', {
      roomId: ROOM_ID,
      object: json
    });
  });

  // 'object:added' 是添加矩形/圆形时触发
  canvas.on('object:added', (e) => {
    // 过滤掉 path，因为 path 已经被 path:created 处理了
    if (e.target.type === 'path') return;
    if (isRemoteUpdate) return;

    const json = e.target.toJSON();
    socketService.emit('draw-event', {
      roomId: ROOM_ID,
      object: json
    });
  });
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

  // 监听：其他人画了东西
  socketService.on('draw-event', (objectData) => {
    console.log('📩 Received draw event:', objectData);
    
    // 标记为远程更新，防止触发 object:added 再次发送
    isRemoteUpdate = true;

    // 将 JSON 数据还原为 Fabric 对象
    fabric.util.enlivenObjects([objectData]).then((objects) => {
      objects.forEach((obj) => {
        canvas.add(obj);
      });
      canvas.renderAll();
      
      // 恢复标记
      isRemoteUpdate = false;
    });
  });

  socketService.on('user-joined', (data) => {
    console.log('👋 User joined:', data.userId);
  });
};

// --- (以下是之前的绘图逻辑，保持不变) ---
const handleResize = () => {
  if (canvas) {
    canvas.setWidth(window.innerWidth);
    canvas.setHeight(window.innerHeight);
    canvas.renderAll(); 
  }
};

// --- 方法：处理键盘事件 (删除选中物体) ---
const handleKeydown = (e) => {
  if (e.key === 'Delete' || e.key === 'Backspace') {
    // 获取当前选中的所有对象 (可能是单个，也可能是多选)
    const activeObjects = canvas.getActiveObjects();
    if (activeObjects.length) {
      // 遍历删除
      activeObjects.forEach((obj) => {
        canvas.remove(obj);
      });
      // 清除选中框
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
    canvas.clear();
    canvas.backgroundColor = '#ffffff'; // 清空后要重新设置背景色
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
    <div class="absolute top-4 left-1/2 -translate-x-1/2 bg-white px-4 py-2 rounded-lg shadow-lg border border-gray-200 flex gap-2 pointer-events-auto select-none">
      
      <!-- 选择工具 -->
      <button 
        @click="setTool('select')"
        class="p-2 rounded hover:bg-gray-100 transition"
        :class="{ 'bg-blue-100 text-blue-600': currentTool === 'select' }"
        title="选择/移动 (V)"
      >
        🖱️ 选择
      </button>

      <!-- 画笔工具 -->
      <button 
        @click="setTool('pencil')"
        class="p-2 rounded hover:bg-gray-100 transition"
        :class="{ 'bg-blue-100 text-blue-600': currentTool === 'pencil' }"
        title="画笔 (P)"
      >
        ✏️ 画笔
      </button>

      <div class="w-px h-8 bg-gray-200 mx-1"></div> <!-- 分隔线 -->

      <!-- 形状工具 -->
      <button 
        @click="setTool('rect')"
        class="p-2 rounded hover:bg-gray-100 transition"
        title="添加矩形"
      >
        ⬛ 矩形
      </button>

      <button 
        @click="setTool('circle')"
        class="p-2 rounded hover:bg-gray-100 transition"
        title="添加圆形"
      >
        ⭕ 圆形
      </button>

      <div class="w-px h-8 bg-gray-200 mx-1"></div> <!-- 分隔线 -->

      <!-- 操作工具 -->
      <button 
        @click="clearCanvas"
        class="p-2 rounded hover:bg-red-100 text-red-500 transition"
        title="清空画布"
      >
        🗑️ 清空
      </button>
    <!-- 连接状态指示器 -->
    <div class="absolute bottom-4 right-4 bg-white/80 backdrop-blur px-3 py-1 rounded-full text-xs text-gray-500 shadow-sm border border-gray-200">
      Room: demo-room 🟢 Connected
    </div>
    </div>
  </div>
</template>

<style scoped></style>
