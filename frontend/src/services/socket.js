import { io } from 'socket.io-client';

class SocketService {
  constructor() {
    this.socket = null;
    this.callbacks = new Map();
    this.wrappedCallbacks = new Map();
    this.roomId = null;
    this.userName = '';
    this.clientVersion = 0;
    this._fallbackTried = false;

    // --- 弱网模拟（仅用于开发/验证）---
    //
    // 给外行看的解释：
    // - “协同白板”这类实时系统，问题往往不在功能本身，而在“网络不稳定时是否还能收敛一致”；
    // - 真实弱网很难复现，所以我们在客户端做一个“可控的网络模拟器”：
    //   - 发出去的消息可以随机延迟/丢弃；
    //   - 收到的消息也可以随机延迟/丢弃；
    // - 这样就能在本机开 2 个标签页，稳定复现“乱序/丢包/延迟”并观察一致性效果。
    //
    // 设计原则：
    // - 只模拟“业务事件”（draw-event / sync-state / cursor-move 等），不模拟 socket.io 的底层握手；
    // - 默认关闭；可通过 URL 参数或 localStorage 开启（详见文档）。
    this.netSim = {
      enabled: false,
      send: { dropRate: 0, delayMs: 0, jitterMs: 0 },
      receive: { dropRate: 0, delayMs: 0, jitterMs: 0 }
    };
    this.netSimStats = {
      sendTotal: 0,
      sendDropped: 0,
      sendDelayed: 0,
      recvTotal: 0,
      recvDropped: 0,
      recvDelayed: 0,
      lastSendDelayMs: 0,
      lastRecvDelayMs: 0
    };
    this._netSimInitialized = false;
  }

  _clampNumber(v, min, max, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  _truthyFlag(raw) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (!s) return false;
    return ['1', 'true', 'yes', 'on', 'enable', 'enabled'].includes(s);
  }

  _shouldSimulateEvent(event) {
    // Socket.IO 内建生命周期事件不做模拟，避免误导连接状态。
    return event !== 'connect' && event !== 'disconnect' && event !== 'connect_error';
  }

  _randomDelay(baseMs, jitterMs) {
    const base = this._clampNumber(baseMs, 0, 60000, 0);
    const jitter = this._clampNumber(jitterMs, 0, 60000, 0);
    if (jitter <= 0) return base;
    return base + Math.floor(Math.random() * jitter);
  }

  _emitNow(event, data, ack) {
    if (!this.socket || !this.socket.connected) return;
    if (typeof ack === 'function') {
      this.socket.emit(event, data, ack);
    } else {
      this.socket.emit(event, data);
    }
  }

  _emitWithSimulation(event, data, ack) {
    if (!this.socket || !this.socket.connected) return;
    if (!this.netSim.enabled || !this._shouldSimulateEvent(event)) {
      this._emitNow(event, data, ack);
      return;
    }

    this.netSimStats.sendTotal += 1;
    const dropRate = this._clampNumber(this.netSim.send.dropRate, 0, 1, 0);
    if (Math.random() < dropRate) {
      this.netSimStats.sendDropped += 1;
      return;
    }

    const delay = this._randomDelay(this.netSim.send.delayMs, this.netSim.send.jitterMs);
    this.netSimStats.lastSendDelayMs = delay;
    if (delay > 0) {
      this.netSimStats.sendDelayed += 1;
      setTimeout(() => {
        this._emitNow(event, data, ack);
      }, delay);
      return;
    }

    this._emitNow(event, data, ack);
  }

  _getWrappedCallback(event, callback) {
    if (!this.wrappedCallbacks.has(event)) {
      this.wrappedCallbacks.set(event, new Map());
    }
    const m = this.wrappedCallbacks.get(event);
    if (m.has(callback)) return m.get(callback);

    const wrapped = (...args) => {
      if (!this.netSim.enabled || !this._shouldSimulateEvent(event)) {
        callback(...args);
        return;
      }

      this.netSimStats.recvTotal += 1;
      const dropRate = this._clampNumber(this.netSim.receive.dropRate, 0, 1, 0);
      if (Math.random() < dropRate) {
        this.netSimStats.recvDropped += 1;
        return;
      }

      const delay = this._randomDelay(this.netSim.receive.delayMs, this.netSim.receive.jitterMs);
      this.netSimStats.lastRecvDelayMs = delay;
      if (delay > 0) {
        this.netSimStats.recvDelayed += 1;
        setTimeout(() => {
          callback(...args);
        }, delay);
        return;
      }

      callback(...args);
    };

    m.set(callback, wrapped);
    return wrapped;
  }

  initNetworkSimulation() {
    if (this._netSimInitialized) return this.getNetworkSimulation();
    this._netSimInitialized = true;

    const next = {
      enabled: false,
      send: { dropRate: 0, delayMs: 0, jitterMs: 0 },
      receive: { dropRate: 0, delayMs: 0, jitterMs: 0 }
    };

    // 1) localStorage（持久化配置）
    try {
      const raw = window?.localStorage?.getItem('QB_NETSIM');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (typeof parsed.enabled === 'boolean') next.enabled = parsed.enabled;
          if (parsed.send && typeof parsed.send === 'object') {
            next.send.dropRate = this._clampNumber(parsed.send.dropRate, 0, 1, 0);
            next.send.delayMs = this._clampNumber(parsed.send.delayMs, 0, 60000, 0);
            next.send.jitterMs = this._clampNumber(parsed.send.jitterMs, 0, 60000, 0);
          }
          if (parsed.receive && typeof parsed.receive === 'object') {
            next.receive.dropRate = this._clampNumber(parsed.receive.dropRate, 0, 1, 0);
            next.receive.delayMs = this._clampNumber(parsed.receive.delayMs, 0, 60000, 0);
            next.receive.jitterMs = this._clampNumber(parsed.receive.jitterMs, 0, 60000, 0);
          }
        }
      }
    } catch {
      // localStorage 或 JSON 解析失败时，直接忽略（不影响主功能）
    }

    // 2) URL 参数（临时覆盖，便于演示/复现实验）
    try {
      const params = new URLSearchParams(window?.location?.search || '');
      const flag = params.get('netsim') || params.get('netSim') || params.get('qb_netsim');
      if (this._truthyFlag(flag)) next.enabled = true;
      if (['0', 'false', 'no', 'off'].includes(String(flag || '').trim().toLowerCase())) next.enabled = false;

      const dropBoth = params.get('netsimDrop') || params.get('netSimDrop') || params.get('drop');
      const delayBoth = params.get('netsimDelay') || params.get('netSimDelay') || params.get('delay');
      const jitterBoth = params.get('netsimJitter') || params.get('netSimJitter') || params.get('jitter');

      const sendDrop = params.get('netsimSendDrop') || params.get('sendDrop');
      const recvDrop = params.get('netsimRecvDrop') || params.get('recvDrop');
      const sendDelay = params.get('netsimSendDelay') || params.get('sendDelay');
      const recvDelay = params.get('netsimRecvDelay') || params.get('recvDelay');
      const sendJitter = params.get('netsimSendJitter') || params.get('sendJitter');
      const recvJitter = params.get('netsimRecvJitter') || params.get('recvJitter');

      if (dropBoth != null) {
        const v = this._clampNumber(dropBoth, 0, 1, next.send.dropRate);
        next.send.dropRate = v;
        next.receive.dropRate = v;
      }
      if (delayBoth != null) {
        const v = this._clampNumber(delayBoth, 0, 60000, next.send.delayMs);
        next.send.delayMs = v;
        next.receive.delayMs = v;
      }
      if (jitterBoth != null) {
        const v = this._clampNumber(jitterBoth, 0, 60000, next.send.jitterMs);
        next.send.jitterMs = v;
        next.receive.jitterMs = v;
      }

      if (sendDrop != null) next.send.dropRate = this._clampNumber(sendDrop, 0, 1, next.send.dropRate);
      if (recvDrop != null) next.receive.dropRate = this._clampNumber(recvDrop, 0, 1, next.receive.dropRate);
      if (sendDelay != null) next.send.delayMs = this._clampNumber(sendDelay, 0, 60000, next.send.delayMs);
      if (recvDelay != null) next.receive.delayMs = this._clampNumber(recvDelay, 0, 60000, next.receive.delayMs);
      if (sendJitter != null) next.send.jitterMs = this._clampNumber(sendJitter, 0, 60000, next.send.jitterMs);
      if (recvJitter != null) next.receive.jitterMs = this._clampNumber(recvJitter, 0, 60000, next.receive.jitterMs);

      // 如果用户明确传了 netsim 参数，认为他希望“本次会话也记住”，方便刷新继续复现。
      if (flag != null) {
        try {
          window?.localStorage?.setItem('QB_NETSIM', JSON.stringify(next));
        } catch {
          // ignore
        }
      }
    } catch {
      // URL 不可用时忽略（例如某些测试环境）
    }

    this.netSim = next;
    return this.getNetworkSimulation();
  }

  setNetworkSimulation(config) {
    const c = config && typeof config === 'object' ? config : {};
    const next = {
      enabled: typeof c.enabled === 'boolean' ? c.enabled : !!this.netSim.enabled,
      send: {
        dropRate: this._clampNumber(c.send && c.send.dropRate, 0, 1, this.netSim.send.dropRate),
        delayMs: this._clampNumber(c.send && c.send.delayMs, 0, 60000, this.netSim.send.delayMs),
        jitterMs: this._clampNumber(c.send && c.send.jitterMs, 0, 60000, this.netSim.send.jitterMs)
      },
      receive: {
        dropRate: this._clampNumber(c.receive && c.receive.dropRate, 0, 1, this.netSim.receive.dropRate),
        delayMs: this._clampNumber(c.receive && c.receive.delayMs, 0, 60000, this.netSim.receive.delayMs),
        jitterMs: this._clampNumber(c.receive && c.receive.jitterMs, 0, 60000, this.netSim.receive.jitterMs)
      }
    };
    this.netSim = next;
    try {
      window?.localStorage?.setItem('QB_NETSIM', JSON.stringify(next));
    } catch {
      // ignore
    }
    return this.getNetworkSimulation();
  }

  getNetworkSimulation() {
    const c = this.netSim || {};
    return {
      enabled: !!c.enabled,
      send: { ...(c.send || {}) },
      receive: { ...(c.receive || {}) }
    };
  }

  getNetworkSimulationStats() {
    return { ...(this.netSimStats || {}) };
  }

  resetNetworkSimulationStats() {
    this.netSimStats = {
      sendTotal: 0,
      sendDropped: 0,
      sendDelayed: 0,
      recvTotal: 0,
      recvDropped: 0,
      recvDelayed: 0,
      lastSendDelayMs: 0,
      lastRecvDelayMs: 0
    };
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
    this.initNetworkSimulation();
    if (room && typeof room === 'object') {
      if (room.roomId) this.roomId = room.roomId;
      if (typeof room.userName === 'string') this.userName = room.userName;
    } else if (room) {
      this.roomId = room;
    }

    const envUrl = String(import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
    const protocol = String(window.location?.protocol || 'http:');
    const host = String(window.location?.hostname || 'localhost');
    const port = String(window.location?.port || '');
    const isDev = !!import.meta.env.DEV;
    const apiUrl = envUrl || (isDev ? `${protocol}//${host}:3000` : `${protocol}//${host}${port ? `:${port}` : ''}`);
    
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
          this.socket.on(event, this._getWrappedCallback(event, cb));
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
      this._emitWithSimulation('join-room', payload);
    }
  }

  /**
   * 发送事件
   * @param {string} event 
   * @param {any} data 
   */
  emit(event, data) {
    if (this.socket && this.socket.connected) {
      this._emitWithSimulation(event, data);
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
      this.socket.on(event, this._getWrappedCallback(event, callback));
    }
  }

  /**
   * 移除事件监听
   * @param {string} event 
   * @param {Function} callback 
   */
  off(event, callback) {
    if (this.socket) {
      const m = this.wrappedCallbacks.get(event);
      const wrapped = m && m.get(callback);
      this.socket.off(event, wrapped || callback);
    }
    if (this.callbacks.has(event)) {
      this.callbacks.get(event).delete(callback);
      if (this.callbacks.get(event).size === 0) {
        this.callbacks.delete(event);
      }
    }
    if (this.wrappedCallbacks.has(event)) {
      this.wrappedCallbacks.get(event).delete(callback);
      if (this.wrappedCallbacks.get(event).size === 0) {
        this.wrappedCallbacks.delete(event);
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

      this._emitWithSimulation(event, data, (resp) => {
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
