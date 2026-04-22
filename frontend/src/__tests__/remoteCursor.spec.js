import { describe, it, expect } from 'vitest'
import { applyDeadzone, expSmoothing, shouldAcceptMonotonicSeq } from '../utils/remoteCursor'

describe('remoteCursor utils', () => {
  it('shouldAcceptMonotonicSeq accepts when seq missing and rejects non-monotonic', () => {
    expect(shouldAcceptMonotonicSeq(undefined, undefined)).toBe(true)
    expect(shouldAcceptMonotonicSeq(10, 9)).toBe(false)
    expect(shouldAcceptMonotonicSeq(10, 10)).toBe(false)
    expect(shouldAcceptMonotonicSeq(10, 11)).toBe(true)
  })

  it('expSmoothing moves toward target without overshoot', () => {
    let x = 0
    for (let i = 0; i < 20; i += 1) {
      x = expSmoothing(x, 100, 16, 80)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(100)
    }
    expect(x).toBeGreaterThan(50)
  })

  it('applyDeadzone snaps tiny jitter to target', () => {
    const current = 10
    expect(applyDeadzone(current, 10.2, 0.5)).toBe(10.2)
    expect(applyDeadzone(current, 10.49, 0.5)).toBe(10.49)
    expect(applyDeadzone(current, 10.499, 0.5)).toBe(10.499)
    expect(applyDeadzone(current, 10.4999, 0.5)).toBe(10.4999)
  })

  it('applyDeadzone keeps current when delta exceeds deadzone', () => {
    expect(applyDeadzone(10, 11, 0.5)).toBe(10)
    expect(applyDeadzone(10, 9, 0.5)).toBe(10)
  })
})

