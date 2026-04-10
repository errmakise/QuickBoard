/*
  Ghost Brush（实时绘制预览）降载工具

  给外行看的解释：
  - “Ghost Brush”是画画过程中那条灰色的临时线，它只是预览，不是最终内容；
  - 最终内容由 path:created 产生 Path 对象，并走 CRDT draw-event 同步；
  - 但 Ghost Brush 如果“每个 mousemove 都发消息”，多人同时画就会造成网络风暴；
  - 本文件提供一个非常朴素但有效的工程方案：
    1) 先把点缓存起来（pendingPoints）
    2) 每隔一小段时间（例如 33ms）把一批点一次性发出去（batch）
    3) 队列太大时做抽样/裁剪，优先保留尾端（最新轨迹更重要）
*/

export const clampNumber = (raw, min, max, fallback) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
};

/*
  抽样策略：把过长的点序列压缩到 maxPoints。

  直觉理解：
  - 预览线最重要的是“看起来跟手”，所以尾端（最新的点）更重要；
  - 如果队列过长，我们宁愿丢掉中间的部分点，也不要让队列无限增长；
  - 这里采用“均匀抽样 + 必保最后一个点”的策略：
    - 先计算步长 step
    - 每隔 step 取一个点
    - 最后确保包含最后一个点
*/
export const downsamplePointsKeepTail = (points, maxPoints) => {
  const arr = Array.isArray(points) ? points : [];
  const max = clampNumber(maxPoints, 2, 200000, 2000);
  if (arr.length <= max) return arr;

  const step = Math.ceil(arr.length / max);
  const out = [];
  for (let i = 0; i < arr.length; i += step) {
    out.push(arr[i]);
    if (out.length >= max) break;
  }
  const last = arr[arr.length - 1];
  if (out.length > 0) {
    const tail = out[out.length - 1];
    if (tail !== last) out[out.length - 1] = last;
  } else {
    out.push(last);
  }
  return out;
};

/*
  Ghost Brush 发送端批处理器

  用法：
  - const sender = createGhostBrushSender({ emit, roomId })
  - sender.enqueuePoint(x, y)   // mousemove 时调用
  - sender.endStroke()          // path:created 时调用
  - sender.dispose()            // 组件卸载时调用

  emit 约定：
  - emit(eventName, payload)
  - 本工具只负责 drawing-process，不会影响其它事件
*/
export const createGhostBrushSender = (options) => {
  const emit = typeof options?.emit === 'function' ? options.emit : () => void 0;
  const roomId = String(options?.roomId || '');

  const flushIntervalMs = clampNumber(options?.flushIntervalMs, 16, 200, 33);
  const maxPendingPoints = clampNumber(options?.maxPendingPoints, 10, 5000, 300);
  const maxPointsPerMessage = clampNumber(options?.maxPointsPerMessage, 10, 500, 60);

  const now = typeof options?.now === 'function' ? options.now : () => Date.now();
  const setTimer = typeof options?.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearTimer = typeof options?.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;

  let pendingPoints = [];
  let flushTimer = null;
  // lastFlushAt 初始化为“当前时间”，这样一开始的前几个点会被正常合并到同一批次里
  let lastFlushAt = now();

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimer(() => {
      flushTimer = null;
      flushNow('timer');
    }, flushIntervalMs);
  };

  const emitPoints = (points) => {
    if (!roomId) return;
    if (!Array.isArray(points) || points.length === 0) return;

    // 分包：避免一次 payload 过大
    for (let i = 0; i < points.length; i += maxPointsPerMessage) {
      const chunk = points.slice(i, i + maxPointsPerMessage);
      emit('drawing-process', { roomId, points: chunk, isEnd: false });
    }
  };

  const flushNow = (reason) => {
    if (pendingPoints.length === 0) return;

    // 1) 队列过长则抽样，避免“网络跟不上导致越积越多”
    if (pendingPoints.length > maxPendingPoints) {
      pendingPoints = downsamplePointsKeepTail(pendingPoints, maxPendingPoints);
    }

    // 2) 发送并清空队列
    const toSend = pendingPoints;
    pendingPoints = [];
    lastFlushAt = now();
    emitPoints(toSend);

    return { reason: reason || 'manual', sent: toSend.length, flushedAt: lastFlushAt };
  };

  const enqueuePoint = (x, y) => {
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;

    // points 用数组而不是对象，体积更小：
    // - [x, y] 比 {x, y} 更省字段名开销
    pendingPoints.push([px, py]);

    const t = now();
    if (t - lastFlushAt >= flushIntervalMs) {
      flushNow('interval');
      return;
    }

    scheduleFlush();
  };

  const endStroke = () => {
    flushNow('endStroke');
    if (!roomId) return;
    emit('drawing-process', { roomId, isEnd: true });
  };

  const dispose = () => {
    if (flushTimer) clearTimer(flushTimer);
    flushTimer = null;
    pendingPoints = [];
  };

  return {
    enqueuePoint,
    flushNow,
    endStroke,
    dispose,
    getStats: () => ({
      flushIntervalMs,
      maxPendingPoints,
      maxPointsPerMessage,
      pending: pendingPoints.length
    })
  };
};

/*
  兼容解析：把 drawing-process 的 payload 统一成 “points 批量 + isEnd”。

  历史兼容原因：
  - 老版本只会发单点 {x, y}
  - 新版本会发批量 {points: [[x,y], ...]}
*/
export const normalizeGhostBrushPayload = (data) => {
  const userId = data && typeof data.userId === 'string' ? data.userId : '';
  const isEnd = Boolean(data && data.isEnd);

  const points = [];
  const rawPoints = data && Array.isArray(data.points) ? data.points : null;

  if (rawPoints && rawPoints.length) {
    for (const item of rawPoints) {
      if (Array.isArray(item) && item.length >= 2) {
        const x = Number(item[0]);
        const y = Number(item[1]);
        if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
      } else if (item && typeof item === 'object') {
        const x = Number(item.x);
        const y = Number(item.y);
        if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
      }
    }
  } else {
    const x = Number(data && data.x);
    const y = Number(data && data.y);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
  }

  return { userId, isEnd, points };
};
