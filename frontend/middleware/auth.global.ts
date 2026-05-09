import { navigateTo } from '#imports'
import { useAuth } from '~/composables/useAuth'

export default defineNuxtRouteMiddleware((to) => {
  const { isAuthenticated, hydrateFromStorage } = useAuth()

  // LocalStorage is only available on client, so skip redirects on SSR pass.
  if (process.server) return

  hydrateFromStorage()

  if (to.path === '/login' && isAuthenticated.value) {
    return navigateTo('/dashboard')
  }

  if (to.path !== '/login' && !isAuthenticated.value) {
    return navigateTo('/login')
  }
})
