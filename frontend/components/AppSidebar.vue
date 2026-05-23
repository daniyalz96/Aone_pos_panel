<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from '#imports'
import { useAppNavigation } from '~/composables/useAppNavigation'
import { useTodayOverview } from '~/composables/useTodayOverview'

const props = withDefaults(
  defineProps<{
    /** Mobile drawer: always show labels and overview. */
    alwaysExpanded?: boolean
    /** When true, nav links emit navigate (e.g. close mobile drawer). */
    closeOnNavigate?: boolean
  }>(),
  { alwaysExpanded: false, closeOnNavigate: false }
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

const expandLabel = computed(() => (props.alwaysExpanded ? '' : 'sidebar-expand-label'))

function onNavClick() {
  if (props.closeOnNavigate) emit('navigate')
}

onMounted(() => {
  void refreshTodayOverview()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div
      class="flex w-full items-center gap-3"
      :class="alwaysExpanded ? '' : 'justify-center group-hover/sidebar:justify-start'"
    >
      <div class="shrink-0 rounded-xl bg-emerald-100 p-2 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
        <UIcon name="i-lucide-store" class="size-6" />
      </div>
      <div class="min-w-0 overflow-hidden" :class="expandLabel">
        <p class="whitespace-nowrap text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">Aone POS</p>
        <p class="truncate text-lg font-semibold text-slate-900 dark:text-slate-100">Retail Control Center</p>
      </div>
    </div>

    <nav class="mt-6 flex-1 space-y-1 overflow-y-auto overscroll-contain lg:mt-8">
      <NuxtLink
        v-for="link in links"
        :key="link.to"
        :to="link.to"
        :title="link.label"
        class="flex w-full items-center rounded-xl py-2.5 text-sm font-medium transition"
        :class="[
          alwaysExpanded ? 'gap-3 px-3' : 'justify-center gap-0 px-2 group-hover/sidebar:justify-start group-hover/sidebar:gap-3 group-hover/sidebar:px-3',
          route.path === link.to
            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
        ]"
        @click="onNavClick"
      >
        <UIcon :name="link.icon" class="size-5 shrink-0" />
        <span class="truncate whitespace-nowrap" :class="expandLabel">{{ link.label }}</span>
      </NuxtLink>
    </nav>

    <UCard
      class="mt-4 shrink-0 bg-slate-900 text-white lg:mt-6"
      :class="alwaysExpanded ? '' : 'sidebar-expand-panel pointer-events-none opacity-0 group-hover/sidebar:pointer-events-auto group-hover/sidebar:opacity-100'"
    >
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

<style scoped>
.sidebar-expand-label {
  max-width: 0;
  opacity: 0;
  transition:
    max-width 0.2s ease,
    opacity 0.2s ease;
}

.group\/sidebar:hover .sidebar-expand-label {
  max-width: 12rem;
  opacity: 1;
}

.sidebar-expand-panel {
  max-height: 0;
  margin-top: 0 !important;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
  border-width: 0;
  transition:
    max-height 0.25s ease,
    opacity 0.2s ease,
    margin 0.2s ease;
}

.group\/sidebar:hover .sidebar-expand-panel {
  max-height: 16rem;
  margin-top: 1.5rem !important;
  padding: 1rem;
  border-width: 1px;
}
</style>
