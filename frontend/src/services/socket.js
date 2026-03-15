import { io } from 'socket.io-client';

class SocketService {
  constructor() {
    this.socket = null;
    this.callbacks = new Map();
    this.roomId = null;
    this._fallbackTried = false;
  }

  /**
   * 初始化 Socket 连接（并绑定常用生命周期事件）。
   *
   * 设计要点：
   * - Socket.IO 客户端默认会自动重连（断网/后端重启后会尝试恢复连接）。
   * - 重连成功后，服务端并不会“自动把你放回之前的 room”，因此必须在每次 connect 时重新 join-room。
   * - 本方法允许被重复调用：如果 socket 已存在，会更新 roomId，并在必要时重新加入房间。
   *
   * @param {string} roomId - 要加入的房间 ID（用于初次连接和后续重连）
   */
  connect(roomId) {
    if (roomId) {
      this.roomId = roomId;
    }

    const envUrl = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
    const protocol = String(window.location?.protocol || 'http:');
    const host = String(window.location?.hostname || 'localhost');
    const apiUrl = envUrl || `${protocol}//${host}:3000`;
    
    if (!this.socket) {
      this.socket = io(apiUrl);

      this.socket.on('connect', () => {
        console.log('Socket connected:', this.socket.id);
        this._fallbackTried = false;
        if (this.roomId) {
          this.joinRoom(this.roomId);
        }
      });

      this.socket.on('disconnect', () => {
        console.log('Socket disconnected');
      });

      this.socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
      });
    } else if (this.socket.connected && this.roomId) {
      this.joinRoom(this.roomId);
    }
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
    this.roomId = roomId;
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

  emitWithAck(event, data, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve({ ok: false, error: 'NO_SOCKET' });
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: 'TIMEOUT' });
      }, timeoutMs);

      this.socket.emit(event, data, (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(resp);
      });
    });
  }

  acquireLock({ roomId, resourceId, ownerName, ttlMs }) {
    return this.emitWithAck('lock-acquire', { roomId, resourceId, ownerName, ttlMs });
  }

  renewLock({ roomId, resourceId, ttlMs }) {
    return this.emitWithAck('lock-renew', { roomId, resourceId, ttlMs });
  }

  releaseLock({ roomId, resourceId }) {
    return this.emitWithAck('lock-release', { roomId, resourceId });
  }
}

// 导出单例对象
export default new SocketService();
