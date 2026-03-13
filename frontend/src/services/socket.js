import { io } from 'socket.io-client';

class SocketService {
  constructor() {
    this.socket = null;
    this.callbacks = new Map();
  }

  /**
   * 初始化 Socket 连接
   * @param {string} roomId - 要加入的房间ID
   */
  connect(roomId) {
    if (this.socket) {
      return;
    }

    const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000';
    
    this.socket = io(apiUrl);

    this.socket.on('connect', () => {
      console.log('✅ Socket connected:', this.socket.id);
      if (roomId) {
        this.joinRoom(roomId);
      }
    });

    this.socket.on('disconnect', () => {
      console.log('❌ Socket disconnected');
    });

    this.socket.on('connect_error', (error) => {
      console.error('⚠️ Socket connection error:', error);
    });
  }

  /**
   * 断开连接
   */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  /**
   * 加入房间
   * @param {string} roomId 
   */
  joinRoom(roomId) {
    if (this.socket) {
      this.socket.emit('join-room', roomId);
    }
  }

  /**
   * 发送事件
   * @param {string} event 
   * @param {any} data 
   */
  emit(event, data) {
    if (this.socket) {
      this.socket.emit(event, data);
    }
  }

  /**
   * 监听事件
   * @param {string} event 
   * @param {Function} callback 
   */
  on(event, callback) {
    if (this.socket) {
      this.socket.on(event, callback);
    }
  }

  /**
   * 移除事件监听
   * @param {string} event 
   * @param {Function} callback 
   */
  off(event, callback) {
    if (this.socket) {
      this.socket.off(event, callback);
    }
  }
}

// 导出单例对象
export default new SocketService();
