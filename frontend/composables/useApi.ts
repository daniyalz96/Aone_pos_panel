import { useRuntimeConfig } from '#imports'
import { useAuth } from '~/composables/useAuth'

export class ApiError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

function isSessionExpired401(statusCode: number, message: string) {
  if (statusCode !== 401) return false
  // Backend `requireAuth`: expired/invalid JWT or inactive user. Not login failures ("Invalid credentials").
  return message === 'Invalid token' || message === 'Invalid user'
}

export const useApi = () => {
  const config = useRuntimeConfig()
  const { token, clearAuth } = useAuth()

  const request = async <T>(path: string, options: Parameters<typeof $fetch<T>>[1] = {}) => {
    try {
      return await $fetch<T>(path, {
        baseURL: config.public.apiBase,
        ...options,
        headers: {
          ...(options.headers || {}),
          ...(token.value ? { Authorization: `Bearer ${token.value}` } : {})
        }
      })
    } catch (error: unknown) {
      const err = error as {
        statusCode?: number
        status?: number
        data?: { message?: string; errors?: unknown }
        message?: string
      }
      const statusCode = Number(err.statusCode ?? err.status ?? 500)
      const data = err.data
      let message = 'API request failed'
      if (data && typeof data === 'object' && data.message) {
        message = String(data.message)
      } else if (typeof err.message === 'string' && err.message) {
        message = err.message
      }

      if (import.meta.client && isSessionExpired401(statusCode, message)) {
        await clearAuth()
        throw new ApiError('Session expired', statusCode)
      }

      throw new ApiError(message, statusCode)
    }
  }

  return { request }
}
