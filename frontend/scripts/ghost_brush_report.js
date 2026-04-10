import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

import { createGhostBrushSender } from '../src/utils/ghostBrush.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function nowStamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds())
  ].join('')
}

function ensureDirSync(dirPath) {
  if (fs.existsSync(dirPath)) return
  fs.mkdirSync(dirPath, { recursive: true })
}

function createFakeTimers() {
  let nowMs = 0
  let nextId = 1
  const timers = new Map()

  const setTimeoutFn = (cb, delayMs) => {
    const id = nextId++
    const due = nowMs + Math.max(0, Number(delayMs) || 0)
    timers.set(id, { due, cb })
    return id
  }

  const clearTimeoutFn = (id) => {
    timers.delete(id)
  }

  const advanceTo = (targetMs) => {
    const end = Math.max(nowMs, targetMs)

    while (true) {
      let next = null
      let nextTimerId = null
      for (const [id, t] of timers.entries()) {
        if (t.due > end) continue
        if (!next || t.due < next.due) {
          next = t
          nextTimerId = id
        }
      }
      if (!next) break

      nowMs = next.due
      timers.delete(nextTimerId)
      try {
        next.cb()
      } catch {
        // ignore
      }
    }

    nowMs = end
  }

  return {
    now: () => nowMs,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    advanceTo
  }
}

function writeReport(report) {
  const docDir = path.resolve(__dirname, '..', '..', '..', 'doc', 'test_reports')
  ensureDirSync(docDir)

  const stamp = nowStamp()
  const jsonPath = path.join(docDir, `quickboard_ghost_brush_${stamp}.json`)
  const mdPath = path.join(docDir, `quickboard_ghost_brush_${stamp}.md`)

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')

  const lines = []
  lines.push(`# QuickBoard Ghost Brush 降载测试报告 (${stamp})`)
  lines.push('')
  lines.push(`- 结果：${report.ok ? 'PASS' : 'FAIL'}`)
  lines.push(`- 模拟时长(ms)：${report.config.durationMs}`)
  lines.push(`- 点采样间隔(ms)：${report.config.pointIntervalMs}`)
  lines.push(`- flush 间隔(ms)：${report.config.flushIntervalMs}`)
  lines.push(`- 发送上限：maxPending=${report.config.maxPendingPoints}, maxPointsPerMsg=${report.config.maxPointsPerMessage}`)
  lines.push('')
  lines.push('## 指标')
  lines.push(`- 采样点数（理论等同“逐点发送”的消息数）：${report.metrics.pointsEnqueued}`)
  lines.push(`- 实际发送消息数：${report.metrics.messagesEmitted}`)
  lines.push(`- 实际发送点数：${report.metrics.pointsSent}`)
  lines.push(`- 平均每条消息携带点数：${report.metrics.avgPointsPerMessage}`)
  lines.push(`- 单条消息最大点数：${report.metrics.maxPointsInMessage}`)
  lines.push(`- isEnd 信号次数：${report.metrics.endSignals}`)
  lines.push(`- 降载倍率（点数/消息数）：${report.metrics.reductionFactor}`)
  lines.push('')
  lines.push('## 说明')
  lines.push('- 该测试是“纯算法级”验证：不依赖 Canvas/Fabric/Socket.IO。')
  lines.push('- 目标是验证：批处理生效（消息数显著降低）、末尾 isEnd 存在、单包点数受控。')
  lines.push('')
  lines.push(`- 详细数据：${path.basename(jsonPath)}`)
  lines.push('')

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')

  return { jsonPath, mdPath }
}

function round(n, digits) {
  const p = 10 ** digits
  return Math.round(n * p) / p
}

async function main() {
  const startedAt = Date.now()

  const durationMs = Number(process.env.GHOST_DURATION_MS || 10_000)
  const pointIntervalMs = Number(process.env.GHOST_POINT_INTERVAL_MS || 4)
  const flushIntervalMs = Number(process.env.GHOST_FLUSH_INTERVAL_MS || 33)

  const maxPendingPoints = Number(process.env.GHOST_MAX_PENDING || 300)
  const maxPointsPerMessage = Number(process.env.GHOST_MAX_POINTS_PER_MSG || 60)

  const timers = createFakeTimers()

  const emitted = []
  const sender = createGhostBrushSender({
    emit: (event, payload) => emitted.push({ event, payload }),
    roomId: 'room-report',
    flushIntervalMs,
    maxPendingPoints,
    maxPointsPerMessage,
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout
  })

  let pointsEnqueued = 0
  for (let t = 0; t < durationMs; t += pointIntervalMs) {
    timers.advanceTo(t)
    sender.enqueuePoint(t, t / 2)
    pointsEnqueued += 1
  }

  timers.advanceTo(durationMs)
  sender.endStroke()
  timers.advanceTo(durationMs + flushIntervalMs * 2)

  const drawingMessages = emitted.filter((x) => x.event === 'drawing-process')
  const messagesEmitted = drawingMessages.length
  let pointsSent = 0
  let maxPointsInMessage = 0
  let endSignals = 0

  for (const m of drawingMessages) {
    if (m.payload && m.payload.isEnd === true) {
      endSignals += 1
      continue
    }
    const pts = Array.isArray(m.payload?.points) ? m.payload.points.length : 0
    pointsSent += pts
    if (pts > maxPointsInMessage) maxPointsInMessage = pts
  }

  const avgPointsPerMessage = messagesEmitted > 0 ? round(pointsSent / Math.max(1, messagesEmitted - endSignals), 2) : 0
  const reductionFactor = messagesEmitted > 0 ? round(pointsEnqueued / messagesEmitted, 2) : 0

  const ok =
    endSignals === 1 &&
    messagesEmitted > 0 &&
    maxPointsInMessage <= maxPointsPerMessage &&
    pointsSent > 0 &&
    pointsSent <= pointsEnqueued

  const report = {
    ok,
    startedAt,
    finishedAt: Date.now(),
    host: { platform: os.platform(), node: process.version },
    config: { durationMs, pointIntervalMs, flushIntervalMs, maxPendingPoints, maxPointsPerMessage },
    metrics: {
      pointsEnqueued,
      messagesEmitted,
      pointsSent,
      avgPointsPerMessage,
      maxPointsInMessage,
      endSignals,
      reductionFactor
    },
    notes: {
      baselineMessagesIfUnbatched: pointsEnqueued,
      expectation: 'messagesEmitted << pointsEnqueued'
    }
  }

  const out = writeReport(report)
  console.log(`[Report] ${report.ok ? 'PASS' : 'FAIL'} ${out.mdPath}`)
  process.exit(report.ok ? 0 : 1)
}

main().catch((e) => {
  console.error('[Report] FAIL', e)
  process.exit(1)
})

