import { createRouter, createWebHistory } from 'vue-router'

import BoardPage from '../pages/BoardPage.vue'
import LandingPage from '../pages/LandingPage.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', name: 'landing', component: LandingPage },
    { path: '/board', name: 'board', component: BoardPage },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

export default router
