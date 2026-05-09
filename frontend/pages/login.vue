<script setup lang="ts">
import { definePageMeta, navigateTo, ref } from '#imports'
import { useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'

definePageMeta({ layout: 'auth' })

const email = ref('')
const password = ref('')
const isSubmitting = ref(false)
const errorMessage = ref('')

const { request } = useApi()
const { setAuth } = useAuth()

const signIn = async () => {
  errorMessage.value = ''
  isSubmitting.value = true
  try {
    const loginRes = await request<{ accessToken: string }>('/auth/login', {
      method: 'POST',
      body: {
        email: email.value.trim(),
        password: password.value
      }
    })
    // Save token first so subsequent authenticated requests include Bearer auth.
    setAuth(loginRes.accessToken, null)
    const me = await request<{
      id: string
      email: string
      roles: string[]
      permissions: string[]
    }>('/auth/me')
    setAuth(loginRes.accessToken, me)
    await navigateTo('/dashboard')
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Unable to login'
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <div class="relative z-10 grid w-full max-w-5xl overflow-hidden rounded-3xl border border-slate-200/60 bg-white/95 shadow-2xl dark:border-white/10 dark:bg-slate-900/90 lg:grid-cols-2">
    <div class="hidden bg-gradient-to-br from-emerald-600 to-emerald-800 p-10 text-white lg:block">
      <p class="rounded-full bg-white/15 px-3 py-1 text-xs uppercase tracking-[0.2em] text-white/90 w-fit">Aone POS</p>
      <h2 class="mt-6 text-3xl font-bold leading-tight">Run your store faster with a smart cashier experience.</h2>
      <p class="mt-4 text-sm text-white/90">
        One dashboard for billing, inventory, payments, and shift closing with real-time visibility.
      </p>
      <ul class="mt-8 space-y-3 text-sm text-white/90">
        <li class="flex items-center gap-2"><UIcon name="i-lucide-check-circle2" /> Fast billing flow</li>
        <li class="flex items-center gap-2"><UIcon name="i-lucide-check-circle2" /> Live stock and payment tracking</li>
        <li class="flex items-center gap-2"><UIcon name="i-lucide-check-circle2" /> Easy day close and reporting</li>
      </ul>
    </div>

    <div class="p-6 sm:p-10">
      <div class="mx-auto max-w-sm">
        <h1 class="text-2xl font-semibold text-slate-900 dark:text-slate-100">Sign in</h1>
        <p class="mt-2 text-sm text-slate-500 dark:text-slate-400">Welcome back. Enter your account details to continue.</p>

        <form class="mt-8 space-y-4" @submit.prevent="signIn">
          <div>
            <label class="mb-1 block text-sm text-slate-600 dark:text-slate-300">Email</label>
            <UInput v-model="email" type="email" placeholder="manager@aonepos.com" icon="i-lucide-mail" />
          </div>
          <div>
            <label class="mb-1 block text-sm text-slate-600 dark:text-slate-300">Password</label>
            <UInput v-model="password" type="password" placeholder="••••••••" icon="i-lucide-lock-keyhole" />
          </div>
          <UAlert
            v-if="errorMessage"
            color="error"
            variant="soft"
            :description="errorMessage"
            icon="i-lucide-triangle-alert"
          />
          <UButton block type="submit" size="lg" icon="i-lucide-log-in" :loading="isSubmitting">
            Continue to Dashboard
          </UButton>
        </form>
      </div>
    </div>
  </div>
</template>
