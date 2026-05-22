import { computed, ref } from 'vue'
import { useApi } from '~/composables/useApi'

export type TodayOverviewKpis = {
  today_sales: number | string
  today_invoice_count: number
  yesterday_sales?: number | string
  yesterday_invoice_count?: number
  today_gross_profit?: number | string
  today_expenses_total?: number | string
  today_net_sales_minus_expenses?: number | string
  [key: string]: unknown
}

const kpis = ref<TodayOverviewKpis | null>(null)
const loading = ref(false)
const error = ref(false)
let inflight: Promise<void> | null = null

/** Shared today KPIs for sidebar, dashboard, and live refresh after sales/returns. */
export function useTodayOverview() {
  const { request } = useApi()

  async function refreshTodayOverview() {
    if (!import.meta.client) return
    if (inflight) return inflight

    loading.value = true
    error.value = false
    inflight = (async () => {
      try {
        kpis.value = await request<TodayOverviewKpis>('/home/kpis')
      } catch {
        error.value = true
      } finally {
        loading.value = false
        inflight = null
      }
    })()
    return inflight
  }

  const todaySales = computed(() => Number(kpis.value?.today_sales ?? 0))
  const todayInvoiceCount = computed(() => Number(kpis.value?.today_invoice_count ?? 0))

  return {
    kpis,
    loading,
    error,
    todaySales,
    todayInvoiceCount,
    refreshTodayOverview,
  }
}
