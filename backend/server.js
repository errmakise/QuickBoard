const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();

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
  
  // 监听：用户加入房间
  socket.on('join-room', (roomId) => {
    socket.join(roomId);
    console.log(`[Socket] User ${socket.id} joined room ${roomId}`);
    
    // 告诉房间里的其他人：有新人来了
    socket.to(roomId).emit('user-joined', { userId: socket.id });
  });

  // --- 绘图同步逻辑 ---
  
  // 监听：绘图事件 (接收前端发来的 JSON 数据)
  socket.on('draw-event', (data) => {
    const { roomId, object } = data;
    // 广播给房间内的其他人 (除了自己)
    socket.to(roomId).emit('draw-event', object);
  });

  // 监听：断开连接
  socket.on('disconnect', () => {
    console.log(`[Socket] User disconnected: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Backend server running on http://localhost:${PORT}`);
  console.log(`📡 Socket.IO is ready for connections`);
});
