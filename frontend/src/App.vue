<script setup>
import Whiteboard from './components/Whiteboard.vue';
</script>

<template>
  <!-- 全屏容器 -->
  <div class="h-screen w-screen bg-gray-50 overflow-hidden">
    <!-- 引入白板组件 -->
    <Whiteboard />
  </div>
</template>

<style scoped>
/* 无需额外样式 */
</style>
