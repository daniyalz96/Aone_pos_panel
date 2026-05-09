import { computed } from 'vue'
import { navigateTo, useState } from '#imports'

type AuthUser = {
  id: string
  email: string
  roles: string[]
  permissions: string[]
}

export const useAuth = () => {
  const token = useState<string | null>('auth:token', () => null)
  const user = useState<AuthUser | null>('auth:user', () => null)

  const isAuthenticated = computed(() => Boolean(token.value))

  const setAuth = (nextToken: string, nextUser: AuthUser | null) => {
    token.value = nextToken
    user.value = nextUser
    if (process.client) {
      localStorage.setItem('pos_token', nextToken)
      if (nextUser) {
        localStorage.setItem('pos_user', JSON.stringify(nextUser))
      } else {
        localStorage.removeItem('pos_user')
      }
    }
  }

  const hydrateFromStorage = () => {
    if (!process.client) return
    if (token.value) return
    const persistedToken = localStorage.getItem('pos_token')
    const persistedUser = localStorage.getItem('pos_user')
    if (persistedToken) {
      token.value = persistedToken
    }
    if (persistedUser) {
      try {
        user.value = JSON.parse(persistedUser) as AuthUser
      } catch {
        user.value = null
      }
    }
  }

  const clearAuth = async () => {
    token.value = null
    user.value = null
    if (process.client) {
      localStorage.removeItem('pos_token')
      localStorage.removeItem('pos_user')
    }
    await navigateTo('/login')
  }

  return {
    token,
    user,
    isAuthenticated,
    setAuth,
    clearAuth,
    hydrateFromStorage
  }
}
