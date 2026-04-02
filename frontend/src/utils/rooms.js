const RECENT_ROOMS_KEY = 'qb:recentRooms'

export const generateRoomId = () => {
  const ts = Date.now().toString(36).slice(-4)
  const rnd = Math.random().toString(36).slice(2, 8)
  return `room-${ts}${rnd}`
}

export const normalizeRoomIdInput = (raw) => {
  const s = String(raw || '').trim()
  if (!s) return ''

  if (s.includes('://')) {
    try {
      const url = new URL(s)
      const params = url.searchParams
      const room = params.get('room') || params.get('roomId') || params.get('r')
      return room && room.trim() ? room.trim() : ''
    } catch {
      return ''
    }
  }

  return s
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

