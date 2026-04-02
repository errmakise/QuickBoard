import { LWWMap } from './LWWMap';
import logicalClock from './Clock'; // 引入逻辑时钟

/**
 * CRDT 管理器 (Controller)
 * 
 * 作用：
 * 它是 Fabric.js (UI层) 和 LWWMap (数据层) 之间的桥梁。
 * 
 * 职责：
 * 1. 维护所有白板对象的 CRDT 状态 (this.objects)。
 * 2. 处理本地操作：将 UI 变动转换为 CRDT 更新，并驱动逻辑时钟前进。
 * 3. 处理远程操作：接收网络包，调用 LWWMap 进行合并，并计算出需要更新 UI 的差异 (Delta)。
 */
export class CRDTManager {
  constructor() {
    this.objects = new Map(); // 存储所有的 LWWMap 实例，Key 是对象 ID
  }

  /**
   * [本地操作] 用户在画布上绘图或修改对象
   * 
   * @param {string} id 对象唯一ID
   * @param {object} data Fabric 对象的数据 (如 { left: 100, top: 200, fill: 'red' })
   * @returns {object} 准备发送给服务器的序列化对象 (包含最新的时间戳)
   */
  localUpdate(id, data) {
    // 1. 每次本地发生操作，逻辑时钟必须 +1，确保这是一个“新”的事件
    const newTime = logicalClock.tick();

    let lww = this.objects.get(id);
    
    if (!lww) {
      // 如果是新对象，创建一个新的 LWWMap 实例
      lww = new LWWMap(id, data);
      this.objects.set(id, lww);
    } else {
      // 如果是现有对象，遍历所有变更的属性，逐个更新时间戳
      Object.keys(data).forEach(key => {
        // 显式传入新的逻辑时间
        lww.set(key, data[key], newTime);
      });
    }
    
    // 返回包含时间戳的数据，供 Socket 发送
    return lww.toJSON();
  }

  /**
   * [远程操作] 收到服务器发来的更新
   * 
   * @param {object} remoteState 接收到的 CRDT 对象
   * @returns {object} { isNew, changes } 
   * - isNew: 是否是新对象
   * - changes: 经过 LWW 合并后，确实需要更新到 UI 上的属性集合
   */
  mergeRemoteUpdate(remoteState) {
    const { id, data, timestamps } = remoteState;
    let lww = this.objects.get(id);
    
    if (!lww) {
      // Case 1: 这是一个本地不存在的新对象
      lww = new LWWMap(id, data);
      
      // 更新本地逻辑时钟：我们需要“追赶”远程的时间
      // 规则：Clock = max(Local, Remote) + 1
      const maxRemoteTs = Math.max(...Object.values(timestamps));
      logicalClock.update(maxRemoteTs);

      // 信任远程的初始状态，直接覆盖
      lww.timestamps = timestamps; 
      this.objects.set(id, lww);
      return { isNew: true, changes: data };
    } else {
      // Case 2: 这是一个已存在的对象，需要合并冲突
      // LWWMap.merge 会自动处理时间戳比较，并同步时钟
      const changes = lww.merge(remoteState);
      return { isNew: false, changes };
    }
  }

  /**
   * 获取某个对象的最新数据
   */
  getData(id) {
    const lww = this.objects.get(id);
    // 如果对象不存在或已被标记删除 (Tombstone)，返回 null
    if (!lww || lww.isDeleted()) return null;
    return lww.data;
  }

  /**
   * 获取某个对象的完整CRDT状态（包括时间戳）
   */
  getObjectState(id) {
    const lww = this.objects.get(id);
    if (!lww) return null;
    return lww.toJSON();
  }

  /**
   * 使用指定时间戳进行本地更新（用于撤销/重做操作）
   */
  localUpdateWithTimestamp(id, data, timestamp) {
    let lww = this.objects.get(id);
    
    if (!lww) {
      /**
       * 如果是“新对象”，不能直接用 `new LWWMap(id, data)`：
       * - LWWMap 构造函数会用 `logicalClock.get()` 给每个字段打时间戳；
       * - 但撤销/重做的语义是“强制使用指定 timestamp”，否则会出现：
       *   1) 发送给服务端的时间戳过小，被判定为旧数据而丢弃；
       *   2) 本地与远端在冲突裁决上出现不一致（看起来像‘重做没生效’）。
       *
       * 所以这里先创建空对象，再把每个字段用同一个 timestamp 写入。
       */
      lww = new LWWMap(id, {});
      Object.keys(data).forEach(key => {
        lww.set(key, data[key], timestamp);
      });
      this.objects.set(id, lww);
    } else {
      // 如果是现有对象，遍历所有变更的属性，使用指定时间戳
      Object.keys(data).forEach(key => {
        lww.set(key, data[key], timestamp);
      });
    }
    
    // 更新逻辑时钟到指定时间戳之后
    logicalClock.update(timestamp);
    
    // 返回包含时间戳的数据，供 Socket 发送
    return lww.toJSON();
  }

  /**
   * 使用指定时间戳删除对象（用于撤销/重做操作）
   */
  deleteWithTimestamp(id, timestamp) {
    let lww = this.objects.get(id);
    
    if (!lww) {
      lww = new LWWMap(id, {});
      this.objects.set(id, lww);
    }

    lww.set('_deleted', true, timestamp);

    Object.keys(lww.data).forEach(key => {
      if (key !== '_deleted') {
        lww.timestamps[key] = timestamp;
      }
    });

    logicalClock.update(timestamp);

    return lww.toJSON();
  }

  /**
   * 获取当前逻辑时钟时间戳
   */
  getCurrentTimestamp() {
    return logicalClock.tick(); // 获取当前时间戳并递增
  }
  
  /**
   * 删除对象 (Tombstone 实现)
   * 真正的 CRDT 使用 Tombstone (墓碑机制)，标记为 _deleted=true，而不是物理删除
   * 这样可以防止并发编辑时的“僵尸复活”问题
   */
  delete(id) {
    const newTime = logicalClock.tick(); // 本地删除，时钟+1
    let lww = this.objects.get(id);
    
    if (!lww) {
      lww = new LWWMap(id, {});
      this.objects.set(id, lww);
    }

    lww.set('_deleted', true, newTime);
    return lww.toJSON();
  }

  /**
   * 全量重置 CRDT 状态。
   * 用途：
   * - 配合“房间重置 (Reset Room)”：当服务端声明该房间被重置时，客户端必须丢弃本地所有 CRDT 记录（含 tombstone）。
   *
   * 注意：
   * - 该操作会清空 objects 并将逻辑时钟归零；
   * - 重置后，下一次本地操作从低时间戳重新开始，因此只能在“房间全员同时清空”的语义下使用。
   */
  reset() {
    this.objects.clear();
    logicalClock.reset(0);
  }
}

// 导出单例，方便全局使用
export default new CRDTManager();
