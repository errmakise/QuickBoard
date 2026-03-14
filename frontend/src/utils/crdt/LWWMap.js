import logicalClock from './Clock';

/**
 * LWW-Map (Last-Write-Wins Map) - 最终一致性数据结构
 * 
 * 核心思想：
 * 当两个用户同时修改同一个属性（如矩形的 x 坐标）时，
 * 谁的“逻辑时间戳”更大，谁就赢（Last Write Wins）。
 * 
 * 数据结构设计：
 * 不仅保存数据本身，还为**每一个属性**保存了最后一次修改的时间戳。
 * 
 * 例子：
 * data: { x: 100, y: 200 }
 * timestamps: { x: 5, y: 3 }
 * 
 * 意味着：
 * - x 坐标是在逻辑时间 5 修改的。
 * - y 坐标是在逻辑时间 3 修改的。
 */
export class LWWMap {
  /**
   * @param {string} id 对象唯一ID
   * @param {object} initialData 初始数据
   */
  constructor(id, initialData = {}) {
    this.id = id;
    this.data = { ...initialData };
    this.timestamps = {};
    
    // 初始化时，给所有属性打上当前时间戳
    const now = logicalClock.get();
    Object.keys(initialData).forEach(key => {
      this.timestamps[key] = now;
    });
  }

  /**
   * [本地操作] 设置属性值
   * 
   * 只有当新的时间戳 > 旧的时间戳时，才允许写入。
   * 这防止了“旧消息覆盖新消息”的问题（比如网络延迟导致的消息乱序）。
   * 
   * @param {string} key 属性名 (如 'left', 'fill')
   * @param {any} value 属性值
   * @param {number} timestamp 可选，默认使用当前逻辑时钟
   */
  set(key, value, timestamp = logicalClock.get()) {
    const lastTs = this.timestamps[key] || 0;
    
    // 注意：如果是 _deleted 标记，我们总是倾向于认为“删除”是更强的操作（或者至少应该严格遵守时钟）
    if (timestamp > lastTs) {
      this.data[key] = value;
      this.timestamps[key] = timestamp;
      return true;
    }
    // 如果 timestamp <= lastTs，说明这是个过时的操作，直接忽略
    return false; 
  }

  /**
   * 标记对象为删除状态 (Tombstone)
   * @param {number} timestamp 
   */
  delete(timestamp = logicalClock.get()) {
    this.set('_deleted', true, timestamp);
  }

  /**
   * 判断对象是否已删除
   */
  isDeleted() {
    return !!this.data._deleted;
  }

  /**
   * 合并远程状态
   * @param {object} remoteState 远程传输过来的状态对象 { data, timestamps }
   * @returns {object} 实际发生变更的属性集合 (Delta)
   */
  merge(remoteState) {
    const { data: remoteData, timestamps: remoteTimestamps } = remoteState;
    const changes = {};

    // 1. 同步全局时钟 (一次性更新)
    // 找出远程最大的时间戳，更新本地时钟
    const allRemoteTs = Object.values(remoteTimestamps);
    if (allRemoteTs.length > 0) {
        const maxRemoteTs = Math.max(...allRemoteTs);
        logicalClock.update(maxRemoteTs);
    }

    Object.keys(remoteData).forEach(key => {
      const remoteTs = remoteTimestamps[key] || 0;
      const localTs = this.timestamps[key] || 0;

      // 如果远程时间戳更新，则接受远程值
      if (remoteTs > localTs) {
        this.data[key] = remoteData[key];
        this.timestamps[key] = remoteTs;
        changes[key] = remoteData[key];
      }
    });

    return changes; // 返回差异，以便 UI 层按需更新
  }

  /**
   * 序列化 (用于网络传输)
   */
  toJSON() {
    return {
      id: this.id,
      data: this.data,
      timestamps: this.timestamps
    };
  }
}
