const clampNumber = (v, min, max, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export const applyVptToPoint = (vpt, x, y) => {
  const m = Array.isArray(vpt) && vpt.length >= 6 ? vpt : [1, 0, 0, 1, 0, 0]
  const a = clampNumber(m[0], -1e9, 1e9, 1)
  const b = clampNumber(m[1], -1e9, 1e9, 0)
  const c = clampNumber(m[2], -1e9, 1e9, 0)
  const d = clampNumber(m[3], -1e9, 1e9, 1)
  const e = clampNumber(m[4], -1e9, 1e9, 0)
  const f = clampNumber(m[5], -1e9, 1e9, 0)
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

export const sceneRectToViewportRect = (vpt, rect) => {
  const left = clampNumber(rect && rect.left, -1e9, 1e9, 0)
  const top = clampNumber(rect && rect.top, -1e9, 1e9, 0)
  const width = clampNumber(rect && rect.width, 0, 1e9, 0)
  const height = clampNumber(rect && rect.height, 0, 1e9, 0)

  const p1 = applyVptToPoint(vpt, left, top)
  const p2 = applyVptToPoint(vpt, left + width, top)
  const p3 = applyVptToPoint(vpt, left, top + height)
  const p4 = applyVptToPoint(vpt, left + width, top + height)

  const xs = [p1.x, p2.x, p3.x, p4.x]
  const ys = [p1.y, p2.y, p3.y, p4.y]
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)

  return { left: minX, top: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) }
}

