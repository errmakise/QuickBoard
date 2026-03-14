const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

// --- 简单的内存存储 (用于演示 CRDT 状态持久化) ---
// 结构: { roomId: { objectId: { id, data, timestamps } } }
const roomStates = {};

// [关键修复] 状态持久化文件路径
const STATE_FILE = path.join(__dirname, 'roomStates.json');

// [关键修复] 从文件加载状态
function loadStates() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const loadedStates = JSON.parse(data);
      Object.assign(roomStates, loadedStates);
      console.log('[Server] Loaded room states from file');
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

// 1. 配置 CORS (跨域资源共享)
// 允许前端 (localhost:5174) 访问后端 API
app.use(cors({
  origin: "*", // 暂时允许所有来源，方便调试
  methods: ["GET", "POST"]
}));

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

  // --- 房间管理逻辑 ---
  
  // 监听：新用户加入
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId}`);

    // 发送当前房间的完整状态 (Full Sync)
    if (roomStates[roomId]) {
      // [关键优化] 过滤掉已删除的对象 (Tombstones)
      // 虽然 CRDT 理论上需要同步墓碑，但在 "Initial Sync" 阶段，
      // 为了减小包大小并防止客户端渲染出"僵尸"对象，我们可以只发送存活的对象
      // (前提是客户端不需要知道"历史删除记录"来解决它本地的冲突，对于新加入者这是成立的)
      const activeObjects = Object.values(roomStates[roomId]).filter(item => {
        // 如果 data 中包含 _deleted: true，则过滤掉
        return !(item.data && item.data._deleted);
      });
      
      socket.emit('sync-state', activeObjects);
    } else {
      socket.emit('sync-state', []);
    }

    // 广播给其他人
    socket.to(roomId).emit('user-joined', { userId: socket.id });
  });

  // --- 绘图同步逻辑 ---
  
  // 监听：绘图事件 (接收前端发来的 CRDT 数据)
  // data: { roomId, id, data, timestamps }
  socket.on('draw-event', (payload) => {
    const { roomId, id, data, timestamps } = payload;
    
    if (!roomStates[roomId]) {
      roomStates[roomId] = {};
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

  // 监听：断开连接
  socket.on('disconnect', () => {
    console.log(`[Socket] User disconnected: ${socket.id}`);
    // 通知所有房间，该用户已离开 (简化处理：通知所有连接的客户端，实际上应该记录用户在哪个房间)
    socket.broadcast.emit('user-left', { userId: socket.id });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Backend server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO is ready for connections`);
});
