export const clampNumber = (v, min, max, fallback) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

export const shouldAcceptMonotonicSeq = (lastSeq, nextSeq) => {
  const s = Number(nextSeq)
  if (!Number.isFinite(s)) return true
  const n = Math.floor(s)
  if (n <= 0) return true
  const last = Number(lastSeq)
  if (!Number.isFinite(last)) return true
  return n > Math.floor(last)
}

export const expSmoothing = (current, target, dtMs, tauMs) => {
  const dt = clampNumber(dtMs, 0, 250, 0)
  const tau = clampNumber(tauMs, 1, 1000, 80)
  if (dt <= 0) return current
  const alpha = 1 - Math.exp(-dt / tau)
  return current + (target - current) * alpha
}

export const applyDeadzone = (current, target, deadzonePx) => {
  const dz = clampNumber(deadzonePx, 0, 100, 0)
  if (dz <= 0) return current
  return Math.abs(target - current) < dz ? target : current
}

