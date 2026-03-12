import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename)


const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(express.static(join(__dirname, 'public')))

app.get('/api/status', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    connectedClients: io.engine.clientsCount
  })
})

io.on('connection', (socket) => {
  console.log('✅ 用户连接成功，用户ID：', socket.id);

  socket.emit('server message', {
    type: 'welcome',
    message: '欢迎来到QuickBoard',
    userId: socket.id,
    timestamp: Date.now(),
  });

  socket.broadcast.emit('server message', {
    type: 'user__joined',
    message: `用户 ${socket.id} 加入了 QuickBoard`,
    timestamp: Date.now(),
  });

  socket.on('chat message', (data) => {
    console.log('💬 收到消息：', { from: socket.id, message: data });

    const messageData = {
      id: socket.id,
      userId: socket.id,
      message: data,
      timestamp: Date.now(),
      type: 'chat'
    }

    io.emit('chat message', messageData)
  })

  socket.on('typing', (isTyping) => {
    // 向其他用户广播输入状态（排除自己）
    socket.broadcast.emit('user typing', {
      userId: socket.id,
      isTyping: isTyping,
      username: `用户${socket.id.slice(-6)}`
    });
  });

  // Whiteboard: 接收并转发绘画数据
  socket.on('drawings', (payload) => {
    const isArray = Array.isArray(payload);
    if (!isArray) return;
    // 简单校验每条线段结构
    const valid = payload.every(
      (d) => d && typeof d.x0 === 'number' && typeof d.y0 === 'number' && typeof d.x1 === 'number' && typeof d.y1 === 'number'
    );
    if (!valid) return;
    // 广播给其他客户端（不含自己）
    socket.broadcast.emit('drawings', payload);
  });

  // 9. 监听用户断开连接的事件
  socket.on('disconnect', (reason) => {
    console.log('❌ 用户断开连接：', socket.id, '原因：', reason);

    // 向其他用户广播用户离开的消息
    socket.broadcast.emit('server message', {
      type: 'user_left',
      message: `用户 ${socket.id.slice(-6)} 离开了聊天室`,
      timestamp: new Date().toISOString()
    });
  });

  // 10. 错误处理
  socket.on('error', (error) => {
    console.error('Socket错误:', error);
  });

})


// 11. 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Socket.IO服务器运行在: http://localhost:${PORT}`);
  console.log(`📊 监控面板: http://localhost:${PORT}/admin`);
});

// 12. 优雅关闭处理
process.on('SIGTERM', () => {
  console.log('收到SIGTERM信号，正在关闭服务器...');
  server.close(() => {
    console.log('服务器已关闭');
    process.exit(0);
  });
});