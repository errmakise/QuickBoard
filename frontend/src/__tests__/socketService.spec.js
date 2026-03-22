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
})
