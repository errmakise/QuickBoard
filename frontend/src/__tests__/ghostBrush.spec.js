import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createGhostBrushSender, downsamplePointsKeepTail, normalizeGhostBrushPayload } from '../utils/ghostBrush'

describe('ghostBrush utils', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  it('downsamplePointsKeepTail keeps last point and limits length', () => {
    const points = Array.from({ length: 101 }, (_, i) => [i, i * 2])
    const out = downsamplePointsKeepTail(points, 10)
    expect(out.length).toBeLessThanOrEqual(10)
    expect(out[out.length - 1]).toEqual([100, 200])
  })

  it('normalizeGhostBrushPayload supports both single point and batched points', () => {
    const single = normalizeGhostBrushPayload({ userId: 'u1', x: 1, y: 2, isEnd: false })
    expect(single.userId).toBe('u1')
    expect(single.isEnd).toBe(false)
    expect(single.points).toEqual([{ x: 1, y: 2 }])

    const batch = normalizeGhostBrushPayload({ userId: 'u1', points: [[3, 4], [5, 6]], isEnd: false })
    expect(batch.points).toEqual([{ x: 3, y: 4 }, { x: 5, y: 6 }])
  })

  it('createGhostBrushSender batches points and emits fewer messages', () => {
    const calls = []
    const sender = createGhostBrushSender({
      emit: (event, payload) => calls.push({ event, payload }),
      roomId: 'room-1',
      flushIntervalMs: 50,
      maxPendingPoints: 500,
      maxPointsPerMessage: 500
    })

    sender.enqueuePoint(1, 1)
    sender.enqueuePoint(2, 2)
    sender.enqueuePoint(3, 3)

    expect(calls.length).toBe(0)

    vi.advanceTimersByTime(49)
    expect(calls.length).toBe(0)

    vi.advanceTimersByTime(1)
    expect(calls.length).toBe(1)
    expect(calls[0].event).toBe('drawing-process')
    expect(calls[0].payload.points.length).toBe(3)
  })

  it('endStroke flushes pending points before emitting isEnd', () => {
    const calls = []
    const sender = createGhostBrushSender({
      emit: (event, payload) => calls.push({ event, payload }),
      roomId: 'room-1',
      flushIntervalMs: 100,
      maxPendingPoints: 500,
      maxPointsPerMessage: 500
    })

    sender.enqueuePoint(1, 1)
    sender.enqueuePoint(2, 2)
    sender.endStroke()

    expect(calls.length).toBe(2)
    expect(calls[0].payload.isEnd).toBe(false)
    expect(calls[0].payload.points.length).toBe(2)
    expect(calls[1].payload.isEnd).toBe(true)
  })

  it('limits points when pending grows too large (downsample)', () => {
    const calls = []
    const sender = createGhostBrushSender({
      emit: (event, payload) => calls.push({ event, payload }),
      roomId: 'room-1',
      flushIntervalMs: 50,
      maxPendingPoints: 10,
      maxPointsPerMessage: 500
    })

    for (let i = 0; i < 200; i += 1) sender.enqueuePoint(i, i)
    vi.advanceTimersByTime(50)

    expect(calls.length).toBe(1)
    expect(calls[0].payload.points.length).toBeLessThanOrEqual(10)
    expect(calls[0].payload.points[calls[0].payload.points.length - 1]).toEqual([199, 199])
  })
})

