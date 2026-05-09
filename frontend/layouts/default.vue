<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from '#imports'
import { useAppNavigation } from '~/composables/useAppNavigation'
import { useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'

const route = useRoute()
const { links } = useAppNavigation() // role-filtered (e.g. Ledger for admin/manager only)
const { request } = useApi()
const { user, clearAuth } = useAuth()
const unreadAlerts = ref(0)

const loadUnreadAlerts = async () => {
  try {
    const notifications = await request<Array<{ acknowledged: boolean }>>('/notifications?limit=100')
    unreadAlerts.value = notifications.filter((item) => !item.acknowledged).length
  } catch {
    unreadAlerts.value = 0
  }
}

onMounted(async () => {
  await loadUnreadAlerts()
})
</script>

<template>
  <div
    class="flex h-svh flex-col overflow-hidden bg-gradient-to-br from-slate-50 via-white to-emerald-50/40 dark:from-slate-950 dark:via-slate-900 dark:to-emerald-950/20"
  >
    <div class="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1">
      <aside
        class="hidden h-full min-h-0 w-64 shrink-0 overflow-y-auto border-r border-slate-200/70 bg-white/90 p-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 lg:block"
      >
        <div class="flex items-center gap-3">
          <div class="rounded-xl bg-emerald-100 p-2 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            <UIcon name="i-lucide-store" class="size-6" />
          </div>
          <div>
            <p class="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Aone POS</p>
            <p class="text-lg font-semibold text-slate-900 dark:text-slate-100">Retail Control Center</p>
          </div>
        </div>

        <nav class="mt-8 space-y-2">
          <NuxtLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition"
            :class="route.path === link.to ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'"
          >
            <UIcon :name="link.icon" class="size-4" />
            <span>{{ link.label }}</span>
          </NuxtLink>
        </nav>

        <UCard class="mt-8 bg-slate-900 text-white">
          <p class="text-sm font-semibold">Today Overview</p>
          <p class="mt-3 text-2xl font-bold">PKR 126,420</p>
          <p class="mt-1 text-xs text-slate-300">32 transactions in current shift</p>
        </UCard>
      </aside>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header
          class="shrink-0 border-b border-slate-200/70 bg-white/90 px-5 py-4 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 sm:px-8"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Welcome back, {{ user?.email ?? 'User' }}</h1>
              <p class="text-sm text-slate-500 dark:text-slate-400">Run billing quickly and monitor business health in one place.</p>
            </div>
            <div class="flex items-center gap-3">
              <UiThemeToggle />
              <UButton color="neutral" variant="soft" icon="i-lucide-bell">
                Alerts <UBadge class="ml-2" color="error" variant="soft">{{ unreadAlerts }}</UBadge>
              </UButton>
              <UButton color="neutral" variant="outline" icon="i-lucide-log-out" @click="clearAuth">Logout</UButton>
              <UAvatar alt="Store manager" />
            </div>
          </div>
        </header>

        <main class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-4 sm:py-5 lg:px-5 lg:py-6">
          <slot />
        </main>
      </div>
    </div>
  </div>
</template>
