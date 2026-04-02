import { describe, it, expect, vi, beforeEach } from 'vitest'

let listeners
let socket

vi.mock('socket.io-client', () => {
  return {
    io: vi.fn(() => socket)
  }
})

const getListener = (event) => {
  const list = listeners.get(event) || []
  return list[list.length - 1]
}

describe('SocketService', () => {
  beforeEach(async () => {
    listeners = new Map()
    socket = {
      id: 'socket-1',
      connected: false,
      on: vi.fn((event, cb) => {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(cb)
      }),
      off: vi.fn(),
      emit: vi.fn(),
      connect: vi.fn(() => {
        socket.connected = true
      }),
      disconnect: vi.fn(() => {
        socket.connected = false
      })
    }

    vi.resetModules()
    try {
      window?.localStorage?.removeItem('QB_NETSIM')
    } catch {
      // ignore
    }
  })

  it('allows registering listeners before connect', async () => {
    const { default: socketService } = await import('../services/socket.js')

    const syncCb = vi.fn()
    socketService.on('sync-state', syncCb)
    socketService.setUserName('Alice')
    socketService.connect('room-1')

    const connectCallOrder = socket.connect.mock.invocationCallOrder[0]
    const onSyncCallOrder = socket.on.mock.invocationCallOrder.find((_, idx) => socket.on.mock.calls[idx][0] === 'sync-state')
    expect(onSyncCallOrder).toBeLessThan(connectCallOrder)

    const connectHandler = getListener('connect')
    expect(typeof connectHandler).toBe('function')
    connectHandler()

    expect(socket.emit).toHaveBeenCalledWith('join-room', { roomId: 'room-1', userName: 'Alice' })
  })

  it('includes clientVersion when set', async () => {
    const { default: socketService } = await import('../services/socket.js')

    socketService.setUserName('Alice')
    socketService.setClientVersion(12)
    socketService.connect('room-1')

    const connectHandler = getListener('connect')
    expect(typeof connectHandler).toBe('function')
    connectHandler()

    expect(socket.emit).toHaveBeenCalledWith('join-room', { roomId: 'room-1', userName: 'Alice', clientVersion: 12 })
  })

  it('drops outbound events when netSim send dropRate=1', async () => {
    const { default: socketService } = await import('../services/socket.js')

    socketService.initNetworkSimulation()
    socketService.setNetworkSimulation({
      enabled: true,
      send: { dropRate: 1, delayMs: 0, jitterMs: 0 },
      receive: { dropRate: 0, delayMs: 0, jitterMs: 0 }
    })

    socketService.connect('room-1')
    const connectHandler = getListener('connect')
    connectHandler()

    socket.emit.mockClear()
    socketService.emit('draw-event', { roomId: 'room-1', id: 'o1' })
    expect(socket.emit).not.toHaveBeenCalled()
  })

  it('delays outbound events when netSim send delay configured', async () => {
    vi.useFakeTimers()
    const { default: socketService } = await import('../services/socket.js')

    socketService.initNetworkSimulation()
    socketService.setNetworkSimulation({
      enabled: true,
      send: { dropRate: 0, delayMs: 120, jitterMs: 0 },
      receive: { dropRate: 0, delayMs: 0, jitterMs: 0 }
    })

    socketService.connect('room-1')
    const connectHandler = getListener('connect')
    connectHandler()

    socket.emit.mockClear()
    socketService.emit('cursor-move', { roomId: 'room-1', x: 1, y: 2 })
    expect(socket.emit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(119)
    expect(socket.emit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(socket.emit).toHaveBeenCalledWith('cursor-move', { roomId: 'room-1', x: 1, y: 2 })
    vi.useRealTimers()
  })

  it('drops inbound events when netSim receive dropRate=1', async () => {
    const { default: socketService } = await import('../services/socket.js')

    socketService.initNetworkSimulation()
    socketService.setNetworkSimulation({
      enabled: true,
      send: { dropRate: 0, delayMs: 0, jitterMs: 0 },
      receive: { dropRate: 1, delayMs: 0, jitterMs: 0 }
    })

    const syncCb = vi.fn()
    socketService.on('sync-state', syncCb)
    socketService.connect('room-1')

    const inbound = getListener('sync-state')
    inbound({ roomId: 'room-1', objects: [] })

    expect(syncCb).not.toHaveBeenCalled()
  })
})
