const RECENT_ROOMS_KEY = 'qb:recentRooms'

export const generateRoomId = () => {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
  const bytes = new Uint8Array(10)
  try {
    crypto.getRandomValues(bytes)
  } catch {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }

  let s = ''
  for (let i = 0; i < 8; i += 1) {
    const b = bytes[i] || 0
    s += alphabet[b % alphabet.length]
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`
}

export const normalizeRoomIdInput = (raw) => {
  const s = String(raw || '').trim()
  if (!s) return ''

  const re = /[?&#](room|roomId|r)=([^&#]+)/i
  const m = s.match(re)
  if (m && m[2]) {
    try {
      const v = decodeURIComponent(m[2])
      return String(v || '').trim()
    } catch {
      return String(m[2] || '').trim()
    }
  }

  try {
    const url = s.includes('://') ? new URL(s) : new URL(s, window.location.origin)
    const params = url.searchParams
    const room = params.get('room') || params.get('roomId') || params.get('r')
    if (room && room.trim()) return room.trim()
  } catch {
    void 0
  }

  const id = s.replace(/\s+/g, '')
  if (!id) return ''
  if (id.length > 80) return ''
  return id
}

export const readRecentRooms = () => {
  try {
    const raw = localStorage.getItem(RECENT_ROOMS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((x) => x && typeof x.roomId === 'string' && x.roomId.trim())
      .map((x) => ({ roomId: x.roomId.trim(), lastJoinedAt: Number(x.lastJoinedAt) || 0 }))
      .sort((a, b) => b.lastJoinedAt - a.lastJoinedAt)
  } catch {
    return []
  }
}

export const writeRecentRooms = (rooms) => {
  try {
    localStorage.setItem(RECENT_ROOMS_KEY, JSON.stringify(rooms))
  } catch {
    void 0
  }
}

export const addRecentRoom = (roomId) => {
  const id = String(roomId || '').trim()
  if (!id) return

  const now = Date.now()
  const current = readRecentRooms()
  const next = [{ roomId: id, lastJoinedAt: now }, ...current.filter((x) => x.roomId !== id)].slice(0, 10)
  writeRecentRooms(next)
}

export const removeRecentRoom = (roomId) => {
  const id = String(roomId || '').trim()
  if (!id) return
  const current = readRecentRooms()
  const next = current.filter((x) => x.roomId !== id)
  writeRecentRooms(next)
}
