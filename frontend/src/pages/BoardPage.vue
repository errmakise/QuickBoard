<script setup>
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Whiteboard from '../components/Whiteboard.vue'
import { addRecentRoom } from '../utils/rooms'

const route = useRoute()
const router = useRouter()

const roomId = computed(() => {
  const q = route.query || {}
  const raw = q.room || q.roomId || q.r
  return typeof raw === 'string' ? raw.trim() : ''
})

const ensureRoom = async () => {
  if (!roomId.value) {
    await router.replace({ name: 'landing' })
    return
  }
  addRecentRoom(roomId.value)

  if (typeof window !== 'undefined') {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }
}

watch(roomId, async () => {
  await ensureRoom()
})

onMounted(async () => {
  await ensureRoom()
})
</script>

<template>
  <div class="h-full w-full overflow-hidden">
    <Whiteboard />
  </div>
</template>
