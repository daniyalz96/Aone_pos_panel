<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from '#imports'
import { useAppNavigation } from '~/composables/useAppNavigation'
import { useTodayOverview } from '~/composables/useTodayOverview'

const props = withDefaults(
  defineProps<{
    /** When true, nav links emit navigate (e.g. close mobile drawer). */
    closeOnNavigate?: boolean
  }>(),
  { closeOnNavigate: false }
)

const emit = defineEmits<{ navigate: [] }>()

const route = useRoute()
const { links } = useAppNavigation()
const { kpis, loading, error, refreshTodayOverview } = useTodayOverview()

function fmtPkr(n: number) {
  return `Rs ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

const todaySalesLabel = computed(() => {
  if (loading.value && !kpis.value) return '…'
  if (error.value || !kpis.value) return '—'
  return fmtPkr(Number(kpis.value.today_sales))
})

const todayTransactionsLabel = computed(() => {
  if (loading.value && !kpis.value) return 'Loading…'
  if (error.value || !kpis.value) return 'Could not load'
  const count = Number(kpis.value.today_invoice_count)
  return `${count} transaction${count === 1 ? '' : 's'} today`
})

function onNavClick() {
  if (props.closeOnNavigate) emit('navigate')
}

onMounted(() => {
  void refreshTodayOverview()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-3">
      <div class="rounded-xl bg-emerald-100 p-2 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
        <UIcon name="i-lucide-store" class="size-6" />
      </div>
      <div class="min-w-0">
        <p class="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Aone POS</p>
        <p class="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">Retail Control Center</p>
      </div>
    </div>

    <nav class="mt-8 flex-1 space-y-1 overflow-y-auto overscroll-contain pr-1">
      <NuxtLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition"
        :class="
          route.path === link.to
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
        "
        @click="onNavClick"
      >
        <UIcon :name="link.icon" class="size-4 shrink-0" />
        <span>{{ link.label }}</span>
      </NuxtLink>
    </nav>

    <UCard class="mt-6 shrink-0 bg-slate-900 text-white">
      <div class="flex items-center justify-between gap-2">
        <p class="text-sm font-semibold">Today Overview</p>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          class="text-slate-300"
          aria-label="Refresh today overview"
          @click="refreshTodayOverview()"
        />
      </div>
      <p class="mt-3 text-xs font-medium text-slate-300">Today sales</p>
      <p class="text-2xl font-bold">{{ todaySalesLabel }}</p>
      <p class="mt-3 text-xs font-medium text-slate-300">Transactions</p>
      <p class="text-sm text-slate-200">{{ todayTransactionsLabel }}</p>
    </UCard>
  </div>
</template>
