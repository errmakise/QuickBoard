import { describe, it, expect } from 'vitest'
import { applyVptToPoint, sceneRectToViewportRect } from '../utils/ocrCrop'

describe('ocrCrop utils', () => {
  it('applyVptToPoint applies affine transform', () => {
    const vpt = [2, 0, 0, 2, 50, 30]
    const p = applyVptToPoint(vpt, 10, 5)
    expect(p.x).toBe(70)
    expect(p.y).toBe(40)
  })

  it('sceneRectToViewportRect maps rect using vpt', () => {
    const vpt = [2, 0, 0, 2, 50, 30]
    const r = sceneRectToViewportRect(vpt, { left: 10, top: 5, width: 20, height: 10 })
    expect(r.left).toBe(70)
    expect(r.top).toBe(40)
    expect(r.width).toBe(40)
    expect(r.height).toBe(20)
  })
})

