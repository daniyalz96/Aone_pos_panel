import { useRuntimeConfig } from '#imports'
import { useAuth } from '~/composables/useAuth'

export class ApiError extends Error {
  statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

export const useApi = () => {
  const config = useRuntimeConfig()
  const { token } = useAuth()

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
      throw new ApiError(message, statusCode)
    }
  }

  return { request }
}
