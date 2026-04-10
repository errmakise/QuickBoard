import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { io } from 'socket.io-client'

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

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clampNumber(v, min, max, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function createSeededRng(seed) {
  let s = (seed >>> 0) || 1
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.floor(p * (sortedAsc.length - 1))))
  return sortedAsc[idx]
}

function stableStateHash(state) {
  const ids = Array.from(state.keys()).sort()
  const compact = []
  for (const id of ids) {
    const obj = state.get(id)
    if (!obj) continue
    const data = obj.data || {}
    if (data && data._deleted === true) continue
    const keys = Object.keys(data).sort()
    const d = {}
    for (const k of keys) {
      d[k] = data[k]
    }
    compact.push([id, d])
  }
  return JSON.stringify(compact)
}

function mergeLwwIntoState(state, id, patchData, patchTimestamps, metrics) {
  if (!id) return
  const incomingData = patchData && typeof patchData === 'object' ? patchData : {}
  const incomingTs = patchTimestamps && typeof patchTimestamps === 'object' ? patchTimestamps : {}

  let obj = state.get(id)
  if (!obj) {
    obj = { data: {}, timestamps: {} }
    state.set(id, obj)
  }
  if (!obj.data) obj.data = {}
  if (!obj.timestamps) obj.timestamps = {}

  for (const key of Object.keys(incomingData)) {
    const remoteTs = Number(incomingTs[key] || 0) || 0
    const localTs = Number(obj.timestamps[key] || 0) || 0

    if (key === '_deleted') {
      if (incomingData._deleted === true && remoteTs > localTs) {
        obj.data._deleted = true
        obj.timestamps._deleted = remoteTs
        if (metrics) metrics.accepted += 1
      } else if (incomingData._deleted === false && remoteTs > localTs) {
        delete obj.data._deleted
        delete obj.timestamps._deleted
        if (metrics) metrics.accepted += 1
      } else if (metrics) {
        metrics.ignored += 1
      }
      continue
    }

    if (remoteTs > localTs) {
      obj.data[key] = incomingData[key]
      obj.timestamps[key] = remoteTs
      if (metrics) metrics.accepted += 1
    } else if (metrics) {
      metrics.ignored += 1
    }
  }
}

function applyNaivePatch(state, id, patchData, patchTimestamps, metrics) {
  if (!id) return
  const incomingData = patchData && typeof patchData === 'object' ? patchData : {}
  const incomingTs = patchTimestamps && typeof patchTimestamps === 'object' ? patchTimestamps : {}

  let obj = state.get(id)
  if (!obj) {
    obj = { data: {}, timestamps: {} }
    state.set(id, obj)
  }
  if (!obj.data) obj.data = {}
  if (!obj.timestamps) obj.timestamps = {}

  for (const key of Object.keys(incomingData)) {
    const remoteTs = Number(incomingTs[key] || 0) || 0
    const localTs = Number(obj.timestamps[key] || 0) || 0
    const isRollback = remoteTs > 0 && localTs > 0 && remoteTs < localTs

    if (key === '_deleted' && incomingData._deleted === false) {
      delete obj.data._deleted
    } else {
      obj.data[key] = incomingData[key]
    }
    obj.timestamps[key] = Math.max(localTs, remoteTs, localTs + 0)

    if (metrics) {
      metrics.applied += 1
      if (isRollback) metrics.rollbackOverwrites += 1
    }
  }
}

class SimSocket {
  constructor({ url, netSim, name }) {
    this.name = name
    this.netSim = netSim || {
      enabled: false,
      send: { dropRate: 0, delayMs: 0, jitterMs: 0 },
      receive: { dropRate: 0, delayMs: 0, jitterMs: 0 }
    }
    this.netStats = {
      sendTotal: 0,
      sendDropped: 0,
      sendDelayed: 0,
      recvTotal: 0,
      recvDropped: 0,
      recvDelayed: 0,
      lastSendDelayMs: 0,
      lastRecvDelayMs: 0
    }
    this.handlers = new Map()
    this.socket = io(url, { transports: ['websocket'], autoConnect: true })
    this.socket.on('connect', () => this._deliverIncoming('connect', []))
    this.socket.on('disconnect', () => this._deliverIncoming('disconnect', []))
    this.socket.on('connect_error', (err) => this._deliverIncoming('connect_error', [err]))
    this.socket.onAny((event, ...args) => {
      this._deliverIncoming(event, args)
    })
  }

  _shouldSimulateEvent(event) {
    return event !== 'connect' && event !== 'disconnect' && event !== 'connect_error'
  }

  _randomDelay(baseMs, jitterMs) {
    const base = clampNumber(baseMs, 0, 60000, 0)
    const jitter = clampNumber(jitterMs, 0, 60000, 0)
    if (jitter <= 0) return base
    return base + Math.floor(Math.random() * jitter)
  }

  _deliverIncoming(event, args) {
    const cbs = this.handlers.get(event)
    if (!cbs || cbs.size === 0) return

    this.netStats.recvTotal += 1
    if (!this.netSim.enabled || !this._shouldSimulateEvent(event)) {
      for (const cb of cbs) cb(...args)
      return
    }

    const dropRate = clampNumber(this.netSim.receive.dropRate, 0, 1, 0)
    if (Math.random() < dropRate) {
      this.netStats.recvDropped += 1
      return
    }

    const delay = this._randomDelay(this.netSim.receive.delayMs, this.netSim.receive.jitterMs)
    this.netStats.lastRecvDelayMs = delay
    if (delay > 0) {
      this.netStats.recvDelayed += 1
      setTimeout(() => {
        for (const cb of cbs) cb(...args)
      }, delay)
      return
    }

    for (const cb of cbs) cb(...args)
  }

  on(event, cb) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event).add(cb)
  }

  emit(event, data) {
    if (!this.socket || !this.socket.connected) return
    this.netStats.sendTotal += 1
    if (!this.netSim.enabled || !this._shouldSimulateEvent(event)) {
      this.socket.emit(event, data)
      return
    }

    const dropRate = clampNumber(this.netSim.send.dropRate, 0, 1, 0)
    if (Math.random() < dropRate) {
      this.netStats.sendDropped += 1
      return
    }

    const delay = this._randomDelay(this.netSim.send.delayMs, this.netSim.send.jitterMs)
    this.netStats.lastSendDelayMs = delay
    if (delay > 0) {
      this.netStats.sendDelayed += 1
      setTimeout(() => {
        if (this.socket && this.socket.connected) this.socket.emit(event, data)
      }, delay)
      return
    }

    this.socket.emit(event, data)
  }

  disconnect() {
    if (!this.socket) return
    try {
      this.socket.disconnect()
    } catch {
      // ignore
    }
  }

  connect() {
    if (!this.socket) return
    try {
      this.socket.connect()
    } catch {
      // ignore
    }
  }

  close() {
    if (!this.socket) return
    try {
      this.socket.close()
    } catch {
      // ignore
    }
  }
}

async function spawnBackend({ port, syncMode }) {
  const backendDir = path.resolve(__dirname, '..', '..', 'backend')
  const serverJs = path.join(backendDir, 'server.js')

  const env = {
    ...process.env,
    PORT: String(port),
    OCR_AUTO_START: '0',
    ROOM_TTL_MINUTES: '0',
    ROOM_SNAPSHOT_INTERVAL_SECONDS: '0',
    ROOM_STATE_PERSIST_DEBUG: '0',
    DRAW_EVENT_DEBUG: '0',
    BENCH_PASS_THROUGH: '1',
    SYNC_MODE: syncMode
  }

  const child = spawn(process.execPath, [serverJs], {
    cwd: backendDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  let stdout = ''
  let stderr = ''
  const onOut = (buf) => {
    const s = String(buf || '')
    stdout += s
  }
  const onErr = (buf) => {
    const s = String(buf || '')
    stderr += s
  }
  child.stdout.on('data', onOut)
  child.stderr.on('data', onErr)

  const startedAt = Date.now()
  while (Date.now() - startedAt < 8000) {
    if (stdout.includes('Backend server running')) {
      return { child, stdout, stderr }
    }
    if (stderr.includes('EADDRINUSE')) break
    await sleepMs(60)
  }

  try {
    child.kill()
  } catch {
    // ignore
  }
  throw new Error(`Backend start failed. stdout=${stdout.slice(-800)} stderr=${stderr.slice(-800)}`)
}

async function stopBackend(child) {
  if (!child) return
  try {
    child.kill()
  } catch {
    // ignore
  }
  await sleepMs(300)
}

function makeObjectCreatePatch({ id, rng, worldSize }) {
  const left = Math.floor(rng() * worldSize)
  const top = Math.floor(rng() * worldSize)
  const width = 40 + Math.floor(rng() * 80)
  const height = 40 + Math.floor(rng() * 80)
  const fill = `hsl(${Math.floor(rng() * 360)}, 70%, 60%)`
  return {
    type: 'rect',
    id,
    left,
    top,
    width,
    height,
    fill,
    stroke: 'rgba(0,0,0,0.12)',
    strokeWidth: 1
  }
}

function pickUpdatePatch({ current, rng }) {
  const patch = {}
  const r = rng()
  if (r < 0.5) {
    const dx = Math.floor((rng() - 0.5) * 60)
    const dy = Math.floor((rng() - 0.5) * 60)
    patch.left = Math.floor((current.left || 0) + dx)
    patch.top = Math.floor((current.top || 0) + dy)
  } else if (r < 0.85) {
    patch.fill = `hsl(${Math.floor(rng() * 360)}, 70%, 60%)`
  } else {
    patch.width = Math.max(10, Math.floor((current.width || 60) + (rng() - 0.5) * 30))
    patch.height = Math.max(10, Math.floor((current.height || 60) + (rng() - 0.5) * 30))
  }
  return patch
}

async function runOneMode({ mode, port, seed }) {
  const roomId = `bench-${mode}-${seed}`
  const url = `http://127.0.0.1:${port}`
  const rng = createSeededRng(seed)

  const clients = []
  const clientCount = clampNumber(process.env.BENCH_CLIENTS || 6, 2, 20, 6)
  const initialObjects = clampNumber(process.env.BENCH_INITIAL_OBJECTS || 200, 10, 20000, 200)
  const opsPerClient = clampNumber(process.env.BENCH_OPS_PER_CLIENT || 200, 10, 20000, 200)
  const worldSize = clampNumber(process.env.BENCH_WORLD || 6000, 500, 200000, 6000)

  const netSim = {
    enabled: false,
    send: {
      dropRate: clampNumber(process.env.BENCH_SEND_DROP || 0, 0, 1, 0),
      delayMs: clampNumber(process.env.BENCH_SEND_DELAY || 90, 0, 60000, 90),
      jitterMs: clampNumber(process.env.BENCH_SEND_JITTER || 140, 0, 60000, 140)
    },
    receive: {
      dropRate: clampNumber(process.env.BENCH_RECV_DROP || 0.15, 0, 1, 0.15),
      delayMs: clampNumber(process.env.BENCH_RECV_DELAY || 90, 0, 60000, 90),
      jitterMs: clampNumber(process.env.BENCH_RECV_JITTER || 140, 0, 60000, 140)
    }
  }

  const stateByClient = []
  const tsCounter = []
  const serverVersionByClient = []
  const latencyMs = []
  const lwwMergeStats = []
  const naiveApplyStats = []
  const connected = []

  for (let i = 0; i < clientCount; i += 1) {
    const sim = new SimSocket({
      url,
      name: `c${i}`,
      netSim: JSON.parse(JSON.stringify(netSim))
    })
    clients.push(sim)
    stateByClient.push(new Map())
    tsCounter.push(1 + i * 1_000_000)
    serverVersionByClient.push(0)
    lwwMergeStats.push({ accepted: 0, ignored: 0 })
    naiveApplyStats.push({ applied: 0, rollbackOverwrites: 0 })
    connected.push(false)

    sim.on('connect', () => {
      connected[i] = true
      const payload = { roomId, userName: `bench-${i}`, clientVersion: serverVersionByClient[i] }
      sim.emit('join-room', payload)
    })

    sim.on('room-cleared', () => {
      stateByClient[i].clear()
      serverVersionByClient[i] = 0
    })

    sim.on('sync-state', (payload) => {
      if (!payload || payload.roomId !== roomId) return
      const sv = typeof payload.serverVersion === 'number' && Number.isFinite(payload.serverVersion) ? Math.floor(payload.serverVersion) : 0
      serverVersionByClient[i] = Math.max(serverVersionByClient[i], sv)

      const objects = Array.isArray(payload.objects) ? payload.objects : []
      const tombstones = Array.isArray(payload.tombstones) ? payload.tombstones : []
      for (const item of objects.concat(tombstones)) {
        if (!item || !item.id) continue
        mergeLwwIntoState(stateByClient[i], item.id, item.data, item.timestamps, null)
      }
    })

    sim.on('sync-delta', (payload) => {
      if (!payload || payload.roomId !== roomId) return
      const deltas = Array.isArray(payload.deltas) ? payload.deltas : []
      for (const d of deltas) {
        if (!d || !d.id) continue
        mergeLwwIntoState(stateByClient[i], d.id, d.data, d.timestamps, null)
        if (typeof d.v === 'number' && Number.isFinite(d.v)) serverVersionByClient[i] = Math.max(serverVersionByClient[i], Math.floor(d.v))
      }
      if (typeof payload.toVersion === 'number' && Number.isFinite(payload.toVersion)) {
        serverVersionByClient[i] = Math.max(serverVersionByClient[i], Math.floor(payload.toVersion))
      }
    })

    sim.on('draw-event', (payload) => {
      if (!payload || !payload.id) return
      if (typeof payload.serverVersion === 'number' && Number.isFinite(payload.serverVersion)) {
        serverVersionByClient[i] = Math.max(serverVersionByClient[i], Math.floor(payload.serverVersion))
      }

      const bench = payload && payload.__bench && typeof payload.__bench === 'object' ? payload.__bench : null
      if (bench && typeof bench.sendAt === 'number') {
        latencyMs.push(Math.max(0, Date.now() - bench.sendAt))
      }

      if (mode === 'lww') {
        mergeLwwIntoState(stateByClient[i], payload.id, payload.data, payload.timestamps, lwwMergeStats[i])
      } else {
        applyNaivePatch(stateByClient[i], payload.id, payload.data, payload.timestamps, naiveApplyStats[i])
      }
    })
  }

  const waitConnectedStartAt = Date.now()
  while (Date.now() - waitConnectedStartAt < 6000) {
    if (connected.every((x) => x === true)) break
    await sleepMs(40)
  }

  for (const c of clients) {
    c.netSim.enabled = false
  }
  if (clients[0]) {
    clients[0].emit('clear-room', { roomId })
  }
  await sleepMs(250)

  const objectIds = []
  for (let k = 0; k < initialObjects; k += 1) {
    objectIds.push(`o-${k}`)
  }

  const initClient = 0
  for (const objectId of objectIds) {
    const t = tsCounter[initClient]++
    const data = makeObjectCreatePatch({ id: objectId, rng, worldSize })
    const timestamps = {}
    for (const key of Object.keys(data)) timestamps[key] = t

    mergeLwwIntoState(stateByClient[initClient], objectId, data, timestamps, null)
    clients[initClient].emit('draw-event', {
      roomId,
      id: objectId,
      data,
      timestamps,
      __bench: { opId: `init-${objectId}`, from: initClient, sendAt: Date.now() }
    })
  }

  await sleepMs(600)

  for (const c of clients) {
    c.netSim.enabled = true
  }

  const totalOps = clientCount * opsPerClient
  const startedAt = Date.now()
  const opLog = []
  let opSeq = 0

  const disconnectAtMs = clampNumber(process.env.BENCH_DISCONNECT_AT_MS || 2200, 0, 600000, 2200)
  const disconnectMs = clampNumber(process.env.BENCH_DISCONNECT_MS || 2400, 0, 600000, 2400)
  const disconnectClients = String(process.env.BENCH_DISCONNECT_CLIENTS || '1,2').split(',').map((x) => Number(x)).filter((x) => Number.isFinite(x))

  const scheduleDisconnect = async () => {
    if (disconnectMs <= 0 || disconnectClients.length === 0) return { did: false }
    await sleepMs(disconnectAtMs)
    for (const idx of disconnectClients) {
      const c = clients[idx]
      if (c) c.disconnect()
    }
    await sleepMs(disconnectMs)
    for (const idx of disconnectClients) {
      const c = clients[idx]
      if (c) c.connect()
    }
    return { did: true }
  }

  const disconnectPromise = scheduleDisconnect()

  for (let n = 0; n < totalOps; n += 1) {
    const clientIdx = Math.floor(rng() * clientCount)
    const objectId = objectIds[Math.floor(rng() * objectIds.length)]
    const localState = stateByClient[clientIdx]
    const localObj = localState.get(objectId) || { data: {}, timestamps: {} }
    const isDelete = rng() < 0.12
    const isCreate = !localObj.data || Object.keys(localObj.data).length === 0

    const t = tsCounter[clientIdx]++
    let data = null
    let timestamps = null
    let kind = ''

    if (isCreate) {
      kind = 'create'
      data = makeObjectCreatePatch({ id: objectId, rng, worldSize })
      timestamps = {}
      for (const key of Object.keys(data)) timestamps[key] = t
    } else if (isDelete) {
      kind = 'delete'
      data = { _deleted: true }
      timestamps = { _deleted: t }
    } else {
      kind = 'update'
      data = pickUpdatePatch({ current: localObj.data || {}, rng })
      timestamps = {}
      for (const key of Object.keys(data)) timestamps[key] = t
    }

    const opId = `${mode}-${seed}-${opSeq++}`
    const sendAt = Date.now()
    opLog.push({ opId, clientIdx, objectId, kind, sendAt })

    if (mode === 'lww') {
      mergeLwwIntoState(stateByClient[clientIdx], objectId, data, timestamps, null)
    } else {
      applyNaivePatch(stateByClient[clientIdx], objectId, data, timestamps, null)
    }

    clients[clientIdx].emit('draw-event', {
      roomId,
      id: objectId,
      data,
      timestamps,
      __bench: { opId, from: clientIdx, sendAt }
    })

    if (n % 30 === 0) await sleepMs(5)
  }

  await disconnectPromise

  await sleepMs(1500)

  for (const c of clients) {
    c.netSim.enabled = false
  }

  const beforeSyncHashes = stateByClient.map(stableStateHash)
  const beforeDistinct = Array.from(new Set(beforeSyncHashes))

  let reference = null
  if (mode === 'lww') {
    const observer = new SimSocket({ url, name: 'observer', netSim: { enabled: false, send: {}, receive: {} } })
    let got = null
    observer.on('connect', () => {
      observer.emit('join-room', { roomId, userName: 'observer', clientVersion: 0 })
      observer.emit('request-sync', { roomId })
    })
    observer.on('sync-state', (payload) => {
      if (payload && payload.roomId === roomId) got = payload
    })
    const t0 = Date.now()
    while (!got && Date.now() - t0 < 5000) {
      await sleepMs(50)
    }
    observer.close()
    if (got) {
      const refState = new Map()
      const objects = Array.isArray(got.objects) ? got.objects : []
      const tombstones = Array.isArray(got.tombstones) ? got.tombstones : []
      for (const item of objects.concat(tombstones)) {
        if (!item || !item.id) continue
        mergeLwwIntoState(refState, item.id, item.data, item.timestamps, null)
      }
      reference = { hash: stableStateHash(refState), serverVersion: got.serverVersion, serverEpoch: got.serverEpoch }
    }
  }

  let afterSyncMs = null
  if (mode === 'lww') {
    const syncStartAt = Date.now()
    for (const c of clients) {
      c.emit('request-sync', { roomId })
    }
    while (Date.now() - syncStartAt < 5000) {
      const hashes = stateByClient.map(stableStateHash)
      const distinct = Array.from(new Set(hashes))
      const ok =
        distinct.length === 1 &&
        (!reference || distinct[0] === reference.hash)
      if (ok) {
        afterSyncMs = Date.now() - syncStartAt
        break
      }
      await sleepMs(80)
    }
  }

  const afterHashes = stateByClient.map(stableStateHash)
  const afterDistinct = Array.from(new Set(afterHashes))

  const latSorted = latencyMs.slice().sort((a, b) => a - b)
  const p50 = percentile(latSorted, 0.5)
  const p95 = percentile(latSorted, 0.95)
  const p99 = percentile(latSorted, 0.99)

  const endedAt = Date.now()
  const durationMs = endedAt - startedAt

  const perClient = clients.map((c, i) => ({
    name: c.name,
    netStats: c.netStats,
    clientVersion: serverVersionByClient[i],
    lww: lwwMergeStats[i],
    naive: naiveApplyStats[i]
  }))

  for (const c of clients) c.close()

  return {
    mode,
    roomId,
    startedAt,
    endedAt,
    durationMs,
    config: {
      clientCount,
      initialObjects,
      opsPerClient,
      worldSize,
      netSim,
      disconnectAtMs,
      disconnectMs,
      disconnectClients
    },
    reference,
    convergence: {
      beforeDistinctHashes: beforeDistinct.length,
      afterDistinctHashes: afterDistinct.length,
      afterRequestSyncMs: afterSyncMs
    },
    latency: {
      samples: latencyMs.length,
      p50,
      p95,
      p99,
      min: latSorted.length ? latSorted[0] : 0,
      max: latSorted.length ? latSorted[latSorted.length - 1] : 0
    },
    consistency: {
      before: {
        distinct: beforeDistinct.length,
        equalToReference: reference ? beforeDistinct.length === 1 && beforeDistinct[0] === reference.hash : null
      },
      after: {
        distinct: afterDistinct.length,
        equalToReference: reference ? afterDistinct.length === 1 && afterDistinct[0] === reference.hash : null
      }
    },
    perClient,
    notes: {
      opCount: opLog.length,
      netSimEnabledDuringOps: true,
      timestampsUsedInPayload: true
    }
  }
}

function summarizeRun(run) {
  const lines = []
  const sum = (arr, pick) => arr.reduce((acc, x) => acc + (Number(pick(x)) || 0), 0)
  const totalRecv = sum(run.perClient, (x) => x.netStats && x.netStats.recvTotal)
  const totalRecvDropped = sum(run.perClient, (x) => x.netStats && x.netStats.recvDropped)
  const totalSend = sum(run.perClient, (x) => x.netStats && x.netStats.sendTotal)
  const totalSendDropped = sum(run.perClient, (x) => x.netStats && x.netStats.sendDropped)
  const totalRollback = sum(run.perClient, (x) => x.naive && x.naive.rollbackOverwrites)
  const totalAccepted = sum(run.perClient, (x) => x.lww && x.lww.accepted)
  const totalIgnored = sum(run.perClient, (x) => x.lww && x.lww.ignored)

  lines.push(`### ${run.mode}`)
  lines.push('')
  lines.push(`- roomId：${run.roomId}`)
  lines.push(`- 客户端数：${run.config.clientCount}（其中断线：${run.config.disconnectClients.join(',') || '无'}）`)
  lines.push(`- 初始对象：${run.config.initialObjects}；每客户端操作数：${run.config.opsPerClient}（总操作：${run.notes.opCount}）`)
  lines.push(`- 弱网：send(drop=${run.config.netSim.send.dropRate}, delay=${run.config.netSim.send.delayMs}ms, jitter=${run.config.netSim.send.jitterMs}ms)；recv(drop=${run.config.netSim.receive.dropRate}, delay=${run.config.netSim.receive.delayMs}ms, jitter=${run.config.netSim.receive.jitterMs}ms)`)
  lines.push('')
  lines.push(`- 延迟样本数：${run.latency.samples}；p50=${run.latency.p50}ms p95=${run.latency.p95}ms p99=${run.latency.p99}ms（min=${run.latency.min} max=${run.latency.max}）`)
  lines.push(`- 一致性（结束时哈希种类数）：beforeSync=${run.convergence.beforeDistinctHashes} afterSync=${run.convergence.afterDistinctHashes}`)
  lines.push(`- 网络统计（全体）：send=${totalSend} dropped=${totalSendDropped}；recv=${totalRecv} dropped=${totalRecvDropped}`)
  if (run.mode === 'lww') {
    lines.push(`- request-sync 收敛时间：${typeof run.convergence.afterRequestSyncMs === 'number' ? `${run.convergence.afterRequestSyncMs}ms` : '未在超时内收敛'}`)
    if (run.reference) {
      lines.push(`- 与服务端权威快照一致：结束前=${String(run.consistency.before.equalToReference)}；对齐后=${String(run.consistency.after.equalToReference)}`)
      lines.push(`- 参考 serverVersion=${run.reference.serverVersion} epoch=${run.reference.serverEpoch}`)
    }
    lines.push(`- LWW 合并统计（全体）：accepted=${totalAccepted} ignored=${totalIgnored}`)
  } else {
    lines.push(`- 朴素广播错乱统计（全体）：rollbackOverwrites=${totalRollback}`)
  }
  lines.push('')
  return lines.join('\n')
}

function writeReport(report) {
  const docDir = path.resolve(__dirname, '..', '..', '..', 'doc', 'test_reports')
  ensureDirSync(docDir)

  const stamp = nowStamp()
  const jsonPath = path.join(docDir, `quickboard_sync_benchmark_${stamp}.json`)
  const mdPath = path.join(docDir, `quickboard_sync_benchmark_${stamp}.md`)

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')

  const lines = []
  lines.push(`# QuickBoard 论文核心对比实验报告（朴素广播 vs LWW+补包）(${stamp})`)
  lines.push('')
  lines.push(`- 机器信息：${os.platform()} node=${process.version}`)
  lines.push('- 说明：该脚本会启动后端两次，分别跑 naive 与 lww 两组，并输出可引用报告（JSON + Markdown）。')
  lines.push('- 重要提醒：FPS/画面观感不是本实验指标；本实验只评估“弱网/断线”下的同步一致性与收敛行为。')
  lines.push('')
  lines.push('## 实验配置（总览）')
  lines.push('')
  lines.push(`- clients=${report.params.clientCount}, initialObjects=${report.params.initialObjects}, opsPerClient=${report.params.opsPerClient}, worldSize=${report.params.worldSize}`)
  lines.push(`- netsim(send): drop=${report.params.netSim.send.dropRate}, delay=${report.params.netSim.send.delayMs}ms, jitter=${report.params.netSim.send.jitterMs}ms`)
  lines.push(`- netsim(recv): drop=${report.params.netSim.receive.dropRate}, delay=${report.params.netSim.receive.delayMs}ms, jitter=${report.params.netSim.receive.jitterMs}ms`)
  lines.push(`- disconnect: at=${report.params.disconnectAtMs}ms for=${report.params.disconnectMs}ms clients=${report.params.disconnectClients.join(',') || 'none'}`)
  lines.push('')
  lines.push('## 结果摘要')
  lines.push('')
  for (const run of report.runs) {
    lines.push(summarizeRun(run))
  }
  lines.push('## 详细数据（按客户端）')
  lines.push('')
  for (const run of report.runs) {
    lines.push(`### ${run.mode}`)
    lines.push('')
    if (run.mode === 'naive') {
      lines.push('| client | sendTotal | sendDropped | recvTotal | recvDropped | rollbackOverwrites | clientVersion |')
      lines.push('|---|---:|---:|---:|---:|---:|---:|')
      for (const c of run.perClient) {
        lines.push(
          `| ${c.name} | ${c.netStats.sendTotal} | ${c.netStats.sendDropped} | ${c.netStats.recvTotal} | ${c.netStats.recvDropped} | ${c.naive.rollbackOverwrites} | ${c.clientVersion} |`
        )
      }
    } else {
      lines.push('| client | sendTotal | sendDropped | recvTotal | recvDropped | lwwAccepted | lwwIgnored | clientVersion |')
      lines.push('|---|---:|---:|---:|---:|---:|---:|---:|')
      for (const c of run.perClient) {
        lines.push(
          `| ${c.name} | ${c.netStats.sendTotal} | ${c.netStats.sendDropped} | ${c.netStats.recvTotal} | ${c.netStats.recvDropped} | ${c.lww.accepted} | ${c.lww.ignored} | ${c.clientVersion} |`
        )
      }
    }
    lines.push('')
  }
  lines.push('## 如何读这份报告（给外行）')
  lines.push('')
  lines.push('- “哈希种类数”：可以理解为“最终出现了多少种不同的画面版本”。越接近 1 越好。')
  lines.push('- “与服务端权威快照一致”：表示客户端最终是否对齐到同一个权威结果（只对 lww 组有意义）。')
  lines.push('- “request-sync 收敛时间”：你按一次“对齐”按钮后，大约多久全员一致（只对 lww 组有意义）。')
  lines.push('- “rollbackOverwrites”：朴素广播里常见的错乱现象：旧消息晚到把新结果覆盖（乱序导致回滚）。')
  lines.push('')
  lines.push('## 原始数据')
  lines.push('')
  lines.push(`- JSON：${path.basename(jsonPath)}`)
  lines.push('')

  fs.writeFileSync(mdPath, lines.join('\n'), 'utf8')

  return { jsonPath, mdPath }
}

async function main() {
  const startedAt = Date.now()
  const seed = clampNumber(process.env.BENCH_SEED || 42, 1, 1_000_000_000, 42)

  const clientCount = clampNumber(process.env.BENCH_CLIENTS || 6, 2, 20, 6)
  const initialObjects = clampNumber(process.env.BENCH_INITIAL_OBJECTS || 200, 10, 20000, 200)
  const opsPerClient = clampNumber(process.env.BENCH_OPS_PER_CLIENT || 200, 10, 20000, 200)
  const worldSize = clampNumber(process.env.BENCH_WORLD || 6000, 500, 200000, 6000)

  const netSim = {
    send: {
      dropRate: clampNumber(process.env.BENCH_SEND_DROP || 0, 0, 1, 0),
      delayMs: clampNumber(process.env.BENCH_SEND_DELAY || 90, 0, 60000, 90),
      jitterMs: clampNumber(process.env.BENCH_SEND_JITTER || 140, 0, 60000, 140)
    },
    receive: {
      dropRate: clampNumber(process.env.BENCH_RECV_DROP || 0.15, 0, 1, 0.15),
      delayMs: clampNumber(process.env.BENCH_RECV_DELAY || 90, 0, 60000, 90),
      jitterMs: clampNumber(process.env.BENCH_RECV_JITTER || 140, 0, 60000, 140)
    }
  }
  const disconnectAtMs = clampNumber(process.env.BENCH_DISCONNECT_AT_MS || 2200, 0, 600000, 2200)
  const disconnectMs = clampNumber(process.env.BENCH_DISCONNECT_MS || 2400, 0, 600000, 2400)
  const disconnectClients = String(process.env.BENCH_DISCONNECT_CLIENTS || '1,2').split(',').map((x) => Number(x)).filter((x) => Number.isFinite(x))

  const pickPort = (base) => base + Math.floor(Math.random() * 2000)
  const portNaive = pickPort(3200)
  const portLww = pickPort(5200)

  const runs = []

  let backend = null
  try {
    backend = await spawnBackend({ port: portNaive, syncMode: 'naive' })
    const run = await runOneMode({ mode: 'naive', port: portNaive, seed })
    runs.push(run)
  } finally {
    if (backend && backend.child) await stopBackend(backend.child)
  }

  backend = null
  try {
    backend = await spawnBackend({ port: portLww, syncMode: 'lww' })
    const run = await runOneMode({ mode: 'lww', port: portLww, seed })
    runs.push(run)
  } finally {
    if (backend && backend.child) await stopBackend(backend.child)
  }

  const finishedAt = Date.now()
  const report = {
    kind: 'quickboard-sync-benchmark',
    createdAt: new Date().toISOString(),
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    params: {
      seed,
      clientCount,
      initialObjects,
      opsPerClient,
      worldSize,
      netSim,
      disconnectAtMs,
      disconnectMs,
      disconnectClients
    },
    runs
  }

  const out = writeReport(report)
  console.log(`[Report] ${out.mdPath}`)
  process.exit(0)
}

main().catch((e) => {
  console.error('[Report] FAIL', e)
  process.exit(1)
})
