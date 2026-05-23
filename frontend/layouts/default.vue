<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from '#imports'
import { useAuth } from '~/composables/useAuth'
import { useTodayOverview } from '~/composables/useTodayOverview'

const route = useRoute()
const { user, clearAuth } = useAuth()
const { refreshTodayOverview } = useTodayOverview()
const mobileNavOpen = ref(false)

const isPosRoute = computed(() => route.path === '/pos' || route.path.startsWith('/pos/'))

const OVERVIEW_POLL_MS = 20_000
let overviewPollId: ReturnType<typeof setInterval> | null = null

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void refreshTodayOverview()
  }
}

onMounted(() => {
  void refreshTodayOverview()
  overviewPollId = setInterval(() => void refreshTodayOverview(), OVERVIEW_POLL_MS)
  document.addEventListener('visibilitychange', onVisibilityChange)
})

onUnmounted(() => {
  if (overviewPollId) clearInterval(overviewPollId)
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

watch(
  () => route.path,
  () => {
    mobileNavOpen.value = false
    void refreshTodayOverview()
  }
)

watch(mobileNavOpen, (open) => {
  if (open) void refreshTodayOverview()
})
</script>

<template>
  <div
    class="flex h-svh flex-col overflow-hidden bg-gradient-to-br from-slate-50 via-white to-emerald-50/40 dark:from-slate-950 dark:via-slate-900 dark:to-emerald-950/20"
  >
    <div
      class="mx-auto flex min-h-0 w-full flex-1"
      :class="isPosRoute ? 'max-w-none' : 'max-w-[1800px]'"
    >
      <aside
        class="group/sidebar relative z-30 hidden h-full min-h-0 w-[4.25rem] shrink-0 overflow-hidden border-r border-slate-200/70 bg-white/90 backdrop-blur transition-[width] duration-200 ease-out hover:w-64 hover:overflow-y-auto dark:border-slate-800 dark:bg-slate-900/80 lg:block"
      >
        <div class="flex h-full w-full min-w-0 flex-col p-3 lg:p-4">
          <AppSidebar />
        </div>
      </aside>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header
          class="shrink-0 border-b border-slate-200/70 bg-white/90 px-3 py-3 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80 sm:px-5 sm:py-4 lg:px-8"
        >
          <div class="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
            <div class="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
              <UButton
                class="shrink-0 lg:hidden"
                color="neutral"
                variant="outline"
                icon="i-lucide-menu"
                aria-label="Open navigation menu"
                @click="mobileNavOpen = true"
              />
              <div class="min-w-0">
                <h1 class="truncate text-base font-semibold text-slate-900 dark:text-slate-100 sm:text-lg">
                  Welcome back, {{ user?.email ?? 'User' }}
                </h1>
                <p class="hidden text-sm text-slate-500 dark:text-slate-400 sm:block">
                  Run billing quickly and monitor business health in one place.
                </p>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1.5 sm:gap-3">
              <UiThemeToggle />
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-log-out"
                aria-label="Logout"
                @click="clearAuth"
              >
                <span class="hidden sm:inline">Logout</span>
              </UButton>
              <UAvatar alt="Store manager" class="hidden sm:flex" />
            </div>
          </div>
        </header>

        <main
          class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
          :class="isPosRoute ? 'px-2 py-3 sm:px-3 sm:py-4' : 'px-3 py-4 sm:px-4 sm:py-5 lg:px-5 lg:py-6'"
        >
          <slot />
        </main>
      </div>
    </div>

    <USlideover
      v-model:open="mobileNavOpen"
      side="left"
      title="Navigation"
      :ui="{ content: 'w-[min(100vw-2rem,18rem)] max-w-full p-4' }"
    >
      <template #body>
        <AppSidebar always-expanded close-on-navigate @navigate="mobileNavOpen = false" />
      </template>
    </USlideover>
  </div>
</template>
