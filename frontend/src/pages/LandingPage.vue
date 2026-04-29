<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { addRecentRoom, generateRoomId, normalizeRoomIdInput, readRecentRooms, removeRecentRoom } from '../utils/rooms'

const router = useRouter()
const route = useRoute()

const joinInput = ref('')
const errorText = ref('')
const recentRooms = ref([])
const rootEl = ref(null)

const isJoinShaking = ref(false)
const isNavigating = ref(false)
const navFx = ref({ on: false, x: 0, y: 0 })

let mouseRaf = 0
let detachMouse = null

const refreshRecent = () => {
  recentRooms.value = readRecentRooms()
}

const beginNavFx = (x, y) => {
  navFx.value = { on: true, x, y }
}

const endNavFx = () => {
  navFx.value = { ...navFx.value, on: false }
}

const goBoard = async (roomId, { fx } = {}) => {
  const id = String(roomId || '').trim()
  if (!id) return
  addRecentRoom(id)

  if (isNavigating.value) return
  isNavigating.value = true

  try {
    if (fx && typeof fx.x === 'number' && typeof fx.y === 'number') {
      beginNavFx(fx.x, fx.y)
      await new Promise((r) => setTimeout(r, 180))
    }

    const next = () => router.push({ name: 'board', query: { room: id } })
    if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function') {
      await document.startViewTransition(() => next()).finished
    } else {
      await next()
    }
  } finally {
    isNavigating.value = false
    endNavFx()
  }
}

const createRoom = async (e) => {
  errorText.value = ''
  const roomId = generateRoomId()

  const fx = e && e.clientX != null && e.clientY != null ? { x: e.clientX, y: e.clientY } : null
  await goBoard(roomId, { fx })
}

const joinRoom = async (e) => {
  errorText.value = ''
  const id = normalizeRoomIdInput(joinInput.value)
  if (!id) {
    errorText.value = '请输入房间号，或粘贴邀请链接。'
    isJoinShaking.value = true
    setTimeout(() => {
      isJoinShaking.value = false
    }, 460)
    return
  }
  const fx = e && e.clientX != null && e.clientY != null ? { x: e.clientX, y: e.clientY } : null
  await goBoard(id, { fx })
}

const openRecent = async (roomId, e) => {
  const fx = e && e.clientX != null && e.clientY != null ? { x: e.clientX, y: e.clientY } : null
  await goBoard(roomId, { fx })
}

const removeRecent = (roomId) => {
  removeRecentRoom(roomId)
  refreshRecent()
}

onMounted(async () => {
  refreshRecent()

  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const host = rootEl.value
  const handleMove = (e) => {
    if (!host || prefersReduced) return
    if (mouseRaf) return
    mouseRaf = window.requestAnimationFrame(() => {
      mouseRaf = 0
      const r = host.getBoundingClientRect()
      const x = Math.max(0, Math.min(r.width, e.clientX - r.left))
      const y = Math.max(0, Math.min(r.height, e.clientY - r.top))
      host.style.setProperty('--mx', `${x}px`)
      host.style.setProperty('--my', `${y}px`)
    })
  }

  if (host) {
    host.addEventListener('mousemove', handleMove)
    detachMouse = () => host.removeEventListener('mousemove', handleMove)
  }

  const q = route.query || {}
  const room = (q.room || q.roomId || q.r)
  const id = typeof room === 'string' ? room.trim() : ''
  if (id) {
    await router.replace({ name: 'board', query: { ...q, room: id } })
  }
})

onUnmounted(() => {
  if (typeof detachMouse === 'function') {
    detachMouse()
    detachMouse = null
  }
  if (mouseRaf) {
    window.cancelAnimationFrame(mouseRaf)
    mouseRaf = 0
  }
})
</script>

<template>
  <div ref="rootEl" class="relative h-full w-full overflow-hidden bg-[#F8F9FB] text-slate-900" style="--mx:50%;--my:45%;">
    <div class="pointer-events-none absolute inset-0 qb-home-grid" />
    <div class="pointer-events-none absolute inset-0">
      <div class="absolute inset-0 qb-home-glow" />
    </div>

    <div v-if="navFx.on" class="pointer-events-none fixed inset-0 z-[60]">
      <div class="absolute inset-0 qb-board-fx" :style="{ '--fx-x': navFx.x + 'px', '--fx-y': navFx.y + 'px' }" />
    </div>

    <header class="relative z-10 h-14">
      <div class="mx-auto flex h-full w-full max-w-6xl items-center justify-between px-4">
        <div class="inline-flex items-center gap-2 text-sm font-semibold tracking-tight text-slate-900">
          <span class="h-7 w-7 rounded-xl border border-black/10 bg-white/70 shadow-sm" />
          QuickBoard
        </div>
      </div>
    </header>

    <main class="relative z-10 w-full px-4">
      <div class="mx-auto flex min-h-[calc(100vh-56px)] w-full max-w-6xl items-center py-10 sm:py-14">
        <div class="mx-auto w-full max-w-2xl text-center">
          <h1 class="text-4xl sm:text-6xl font-semibold tracking-tight leading-[1.02]">
            协作白板，把想法画出来，
            <span class="qb-home-slogan">一起更快</span>
          </h1>
          <p class="mt-4 text-sm sm:text-base text-slate-600">创建一个房间，分享链接，立即开始一起画。</p>

          <div class="mt-8">
            <button class="qb-cta h-12 w-full rounded-2xl text-base" :disabled="isNavigating" @click="createRoom">
              {{ isNavigating ? '进入中…' : '创建房间' }}
            </button>

            <div class="mt-4 rounded-2xl border border-black/10 bg-white/70 px-4 py-3 shadow-sm" :class="{ 'animate-qb-shake': isJoinShaking }">
              <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                <input
                  v-model="joinInput"
                  class="qb-input flex-1"
                  placeholder="粘贴房间链接或输入 roomId"
                  @keydown.enter="joinRoom"
                />
                <button class="qb-btn qb-btn-primary h-10 px-4" @click="joinRoom">加入</button>
              </div>
              <div v-if="errorText" class="mt-2 text-left text-xs text-red-600">{{ errorText }}</div>
            </div>

            <div v-if="recentRooms.length" class="mt-5">
              <div class="flex items-center justify-between">
                <div class="text-xs font-semibold text-slate-700">最近房间</div>
                <button class="text-xs text-slate-500 hover:text-slate-700 transition" @click="refreshRecent">刷新</button>
              </div>
              <div class="mt-3 flex flex-wrap justify-center gap-2">
                <div
                  v-for="r in recentRooms.slice(0, 6)"
                  :key="r.roomId"
                  class="group inline-flex items-center gap-2 rounded-full border border-black/10 bg-white/70 px-3 py-1.5 text-sm text-slate-800 shadow-sm"
                >
                  <svg
                    class="h-4 w-4 text-slate-900"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <path
                      d="M4 7.5C4 6.11929 5.11929 5 6.5 5H17.5C18.8807 5 20 6.11929 20 7.5V18.5C20 19.8807 18.8807 21 17.5 21H6.5C5.11929 21 4 19.8807 4 18.5V7.5Z"
                      stroke="currentColor"
                      stroke-width="1.5"
                    />
                    <path d="M10 8.5H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    <path d="M10 12H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                    <path d="M10 15.5H14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
                  </svg>
                  <button class="max-w-[220px] truncate" :title="r.roomId" @click="(e) => openRecent(r.roomId, e)">
                    {{ r.roomId }}
                  </button>
                  <button class="text-slate-400 hover:text-slate-600 transition" @click="removeRecent(r.roomId)">×</button>
                </div>
              </div>
              <div class="mt-2 text-center text-[11px] text-slate-400">最近房间保存在浏览器本地存储中。</div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
