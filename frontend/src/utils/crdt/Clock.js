/**
 * 逻辑时钟 (Logical Clock) - 基于 Lamport Timestamp 算法
 * 
 * 为什么不用 Date.now()?
 * 1. 物理时间不可靠：不同用户的电脑时间可能不准（有人快几分钟，有人慢几分钟）。
 * 2. 精度不够：JavaScript 的 Date.now() 精度只有毫秒级，如果在 1ms 内发生多次操作，时间戳会相同。
 * 
 * 核心原理：
 * 逻辑时钟不关心“现在是几点”，只关心“事件发生的先后顺序”。
 * 它是一个单调递增的整数计数器。
 * 
 * 规则：
 * 1. 初始化为 0。
 * 2. 本地发生任何事件（如绘图）时，计数器 +1。
 * 3. 收到远程消息时，将计数器更新为 max(本地计数器, 远程计数器) + 1。
 *    这保证了收到的消息一定发生在“过去”，而新的本地操作一定发生在“未来”。
 */
export class LogicalClock {
  constructor() {
    this.time = 0;
  }

  /**
   * 获取当前逻辑时间
   */
  get() {
    return this.time;
  }

  /**
   * [本地事件]：时钟向前拨动一格
   * 每次用户绘图、移动物体时调用
   * @returns {number} 新的时间戳
   */
  tick() {
    this.time += 1;
    return this.time;
  }

  /**
   * [同步事件]：根据远程时间调整本地时钟
   * 当收到其他用户的操作时调用
   * @param {number} remoteTime 远程消息携带的时间戳
   */
  update(remoteTime) {
    // 追赶远程时间，并确保比它大 1
    this.time = Math.max(this.time, remoteTime) + 1;
  }

  /**
   * 重置逻辑时钟。
   * 典型场景：
   * - “房间重置 (Reset Room)”：服务端删除 roomStates 后，客户端需要回到“新房间初始态”；
   * - 测试/调试：希望从 0 开始重新观察时间戳增长与冲突处理过程。
   *
   * 注意：
   * - 这不是普通协同流程的一部分；不要在常规 join-room / sync-state 时调用，否则可能破坏因果顺序。
   */
  reset(time = 0) {
    this.time = time;
  }
}

export default new LogicalClock();
