import { io } from 'socket.io-client';

class SocketService {
  constructor() {
    this.socket = null;
    this.callbacks = new Map();
    this.roomId = null;
    this.userName = '';
    this.clientVersion = 0;
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
  connect(room) {
    if (room && typeof room === 'object') {
      if (room.roomId) this.roomId = room.roomId;
      if (typeof room.userName === 'string') this.userName = room.userName;
    } else if (room) {
      this.roomId = room;
    }

    const envUrl = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
    const protocol = String(window.location?.protocol || 'http:');
    const host = String(window.location?.hostname || 'localhost');
    const apiUrl = envUrl || `${protocol}//${host}:3000`;
    
    if (!this.socket) {
      // 关键点：autoConnect=false
      // - 这会阻止 socket.io-client 在构造时立刻发起连接；
      // - 我们可以先把所有 on(...) 监听器挂好，再手动 connect()；
      // - 这样就不会出现“连接太快导致 sync-state/room-users 先到，但监听还没注册”的竞态。
      this.socket = io(apiUrl, { autoConnect: false });

      // 把 connect() 之前注册的监听器“补挂”到真实 socket 上。
      // 这样业务层可以放心先 on(...)，再 connect(...)。
      for (const [event, callbacks] of this.callbacks.entries()) {
        for (const cb of callbacks) {
          this.socket.on(event, cb);
        }
      }

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

      this.socket.connect();
    } else if (this.socket.connected && this.roomId) {
      this.joinRoom(this.roomId);
    }
  }

  setUserName(userName) {
    this.userName = String(userName || '').trim();
  }

  /**
   * 设置“我已同步到的服务端版本号”（用于断线重连后增量补包）。
   *
   * 背景（给外行看的解释）：
   * - 服务端会为每个房间维护一个递增的 serverVersion；
   * - 客户端每次收到 sync-state（快照）或 draw-event（增量）后都会更新自己的 clientVersion；
   * - 重连 join-room 时把 clientVersion 带过去，服务端就能只返回缺失的增量（sync-delta），而不是全量快照。
   *
   * 注意：
   * - 版本号只是“网络补包索引”，不参与 CRDT 冲突解决；
   * - 如果传入非法值，会被归零，保证 join-room 不携带错误版本号。
   */
  setClientVersion(version) {
    const v = typeof version === 'number' && Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0;
    this.clientVersion = v;
  }

  /**
   * 获取当前 socketId（用于 UI 把“我”与其他成员区分开）。
   * 说明：socketId 是“连接级别”的临时身份，刷新页面/重连后会变化。
   */
  getSocketId() {
    return this.socket && this.socket.id ? this.socket.id : '';
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
  joinRoom(room) {
    if (room && typeof room === 'object') {
      if (room.roomId) this.roomId = room.roomId;
      if (typeof room.userName === 'string') this.userName = room.userName;
    } else if (room) {
      this.roomId = room;
    }
    if (this.socket && this.socket.connected) {
      const payloadObj = { roomId: this.roomId };
      if (this.userName) payloadObj.userName = this.userName;
      if (this.clientVersion > 0) payloadObj.clientVersion = this.clientVersion;
      const payload = Object.keys(payloadObj).length > 1 ? payloadObj : this.roomId;
      this.socket.emit('join-room', payload);
    }
  }

  /**
   * 发送事件
   * @param {string} event 
   * @param {any} data 
   */
  emit(event, data) {
    if (this.socket && this.socket.connected) {
      this.socket.emit(event, data);
    }
  }

  /**
   * 监听事件
   * @param {string} event 
   * @param {Function} callback 
   */
  on(event, callback) {
    if (!this.callbacks.has(event)) {
      this.callbacks.set(event, new Set());
    }
    this.callbacks.get(event).add(callback);
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
    if (this.callbacks.has(event)) {
      this.callbacks.get(event).delete(callback);
      if (this.callbacks.get(event).size === 0) {
        this.callbacks.delete(event);
      }
    }
  }

  emitWithAck(event, data, timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (!this.socket) {
        resolve({ ok: false, error: 'NO_SOCKET' });
        return;
      }
      if (!this.socket.connected) {
        resolve({ ok: false, error: 'DISCONNECTED' });
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
