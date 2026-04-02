<script setup>
import { RouterView } from 'vue-router'
</script>

<template>
  <div class="relative h-screen w-screen overflow-hidden bg-gray-50 text-gray-900">
    <div class="pointer-events-none absolute inset-0">
      <div class="absolute inset-0 qb-grid opacity-70" />
      <div class="absolute inset-0 qb-noise opacity-[0.18]" />

      <div class="absolute -top-28 left-1/2 h-80 w-[min(920px,92vw)] -translate-x-1/2 rounded-full bg-blue-200/45 blur-3xl animate-qb-blob" />
      <div class="absolute -bottom-28 left-1/2 h-80 w-[min(920px,92vw)] -translate-x-1/2 rounded-full bg-purple-200/35 blur-3xl animate-qb-blob" style="animation-delay:-2.5s" />
    </div>

    <div class="relative h-full w-full">
      <RouterView />
    </div>
  </div>
</template>
