<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { addRecentRoom, generateRoomId, normalizeRoomIdInput, readRecentRooms, removeRecentRoom } from '../utils/rooms'

const router = useRouter()
const route = useRoute()

const joinInput = ref('')
const errorText = ref('')
const recentRooms = ref([])
const rootEl = ref(null)

const isJoinShaking = ref(false)
let mouseRaf = 0
let detachMouseMove = null

const shortcutHint = computed(() => {
  return '极简上手：创建房间 → 复制链接 → 开始一起涂鸦'
})

const refreshRecent = () => {
  recentRooms.value = readRecentRooms()
}

const goBoard = async (roomId) => {
  const id = String(roomId || '').trim()
  if (!id) return
  addRecentRoom(id)
  await router.push({ name: 'board', query: { room: id } })
}

const createRoom = async () => {
  errorText.value = ''
  const roomId = generateRoomId()
  await goBoard(roomId)
}

const joinRoom = async () => {
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
  await goBoard(id)
}

const openRecent = async (roomId) => {
  await goBoard(roomId)
}

const removeRecent = (roomId) => {
  removeRecentRoom(roomId)
  refreshRecent()
}

onMounted(async () => {
  refreshRecent()

  const host = rootEl.value
  const handleMove = (e) => {
    if (!host) return
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

  const handleLeave = () => {
    host.style.setProperty('--mx', `50%`)
    host.style.setProperty('--my', `10%`)
  }

  if (host) {
    host.addEventListener('mousemove', handleMove)
    host.addEventListener('mouseleave', handleLeave)
    detachMouseMove = () => {
      host.removeEventListener('mousemove', handleMove)
      host.removeEventListener('mouseleave', handleLeave)
    }
  }

  const q = route.query || {}
  const room = (q.room || q.roomId || q.r)
  const id = typeof room === 'string' ? room.trim() : ''
  if (id) {
    await router.replace({ name: 'board', query: { ...q, room: id } })
  }
})

onUnmounted(() => {
  if (typeof detachMouseMove === 'function') {
    detachMouseMove()
    detachMouseMove = null
  }
  if (mouseRaf) {
    window.cancelAnimationFrame(mouseRaf)
    mouseRaf = 0
  }
})
</script>

<template>
  <div ref="rootEl" class="relative h-full w-full overflow-auto" style="--mx:50%;--my:10%;">
    <div class="pointer-events-none absolute inset-0">
      <div
        class="absolute inset-0"
        style="background: radial-gradient(520px circle at var(--mx) var(--my), rgba(59,130,246,0.18), transparent 62%), radial-gradient(520px circle at calc(var(--mx) - 240px) calc(var(--my) + 140px), rgba(168,85,247,0.14), transparent 62%);"
      />
    </div>

    <div class="pointer-events-none absolute inset-0">
      <div class="absolute top-16 left-1/2 h-28 w-[min(760px,92vw)] -translate-x-1/2 rounded-full bg-blue-200/30 blur-3xl animate-qb-float" />
      <div class="absolute top-28 left-1/2 h-28 w-[min(760px,92vw)] -translate-x-1/2 rounded-full bg-purple-200/25 blur-3xl animate-qb-float" style="animation-delay:-2.4s" />
    </div>

    <div class="mx-auto w-full max-w-5xl px-4 py-10">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="relative h-11 w-11 rounded-2xl border border-gray-200/80 bg-white/70 shadow-sm backdrop-blur flex items-center justify-center">
            <span class="text-lg">✏️</span>
            <div class="pointer-events-none absolute -inset-1 rounded-[18px] bg-gradient-to-b from-blue-200/35 to-purple-200/25 blur" />
          </div>
          <div>
            <div class="text-base font-semibold tracking-tight">QuickBoard</div>
            <div class="text-xs text-gray-500">极简 · 轻量高效 · 趣味驱动</div>
          </div>
        </div>
      </div>

      <div class="mt-10 grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-6">
        <div class="qb-card p-6">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-sm font-medium text-gray-900">开始协作</div>
              <div class="mt-1 text-sm text-gray-600">打开即用，无需注册。房间就是链接。</div>
            </div>
            <div class="hidden sm:flex items-center gap-2">
              <span class="rounded-full border border-gray-200 bg-white/70 px-2.5 py-1 text-[11px] text-gray-600">多人协作</span>
              <span class="rounded-full border border-gray-200 bg-white/70 px-2.5 py-1 text-[11px] text-gray-600">公式识别</span>
              <span class="rounded-full border border-gray-200 bg-white/70 px-2.5 py-1 text-[11px] text-gray-600">撤销重做</span>
            </div>
          </div>

          <div class="mt-4 flex flex-col gap-2">
            <button
              @click="createRoom"
              class="qb-btn qb-btn-primary h-11"
            >
              <span class="text-base">✨</span>
              创建新房间
            </button>

            <div
              class="rounded-2xl border border-gray-200/80 bg-white/70 p-4 shadow-sm"
              :class="{ 'animate-qb-shake': isJoinShaking }"
            >
              <div class="text-xs text-gray-500">加入房间</div>
              <div class="mt-2 flex gap-2">
                <input
                  v-model="joinInput"
                  class="qb-input flex-1"
                  placeholder="输入房间号（如 K7M2-9QF4），或粘贴邀请链接"
                  @keydown.enter="joinRoom"
                />
                <button
                  @click="joinRoom"
                  class="qb-btn h-10 px-4"
                >
                  进入
                </button>
              </div>
              <div v-if="errorText" class="mt-2 text-xs text-red-600">{{ errorText }}</div>
            </div>
          </div>

          <div class="mt-4 text-xs text-gray-500">{{ shortcutHint }}</div>
          <div class="mt-2 text-xs text-gray-500">小贴士：在白板里按 <span class="font-mono">?</span> 查看快捷键。</div>
        </div>

        <div class="qb-card p-6">
          <div class="flex items-center justify-between">
            <div class="text-sm font-medium text-gray-900">最近房间</div>
          </div>
          <div class="mt-1 text-sm text-gray-600">一键回到你刚才的协作现场。</div>

          <div v-if="!recentRooms.length" class="mt-6 text-sm text-gray-500">
            还没有记录。创建一个房间开始吧。
          </div>

          <div v-else class="mt-4 flex flex-col gap-2">
            <div
              v-for="r in recentRooms"
              :key="r.roomId"
              class="group rounded-2xl border border-gray-200/80 bg-white/70 px-4 py-3 flex items-center justify-between gap-3 shadow-sm transition hover:shadow-md"
            >
              <button
                class="flex-1 text-left"
                @click="openRecent(r.roomId)"
                :title="r.roomId"
              >
                <div class="flex items-center gap-2">
                  <div class="text-sm font-medium text-gray-900 truncate">{{ r.roomId }}</div>
                  <span class="text-[11px] text-gray-400 opacity-0 group-hover:opacity-100 transition">↩</span>
                </div>
                <div class="text-xs text-gray-500">上次进入：{{ r.lastJoinedAt ? new Date(r.lastJoinedAt).toLocaleString() : '未知' }}</div>
              </button>

              <button
                class="h-9 px-3 rounded-xl text-xs text-gray-500 hover:text-gray-700 hover:bg-white transition"
                @click="removeRecent(r.roomId)"
                title="从列表移除"
              >
                移除
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="mt-8 text-xs text-gray-500">
        兼容旧链接：<span class="font-mono">/?room=xxx</span> 也会自动跳转到白板。
      </div>
    </div>
  </div>
</template>
