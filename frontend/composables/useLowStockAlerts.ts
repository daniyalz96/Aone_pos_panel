import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { LOW_STOCK_THRESHOLD } from '~/constants/inventory'

export type LowStockItem = {
  product_id: string
  name: string
  sku: string
  qty_on_hand: number | string
  low_stock_threshold?: number | string
}

const lowStockCount = ref(0)
const lowStockItems = ref<LowStockItem[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

let pollId: ReturnType<typeof setInterval> | null = null
const POLL_MS = 30_000

export function useLowStockAlerts() {
  const { request } = useApi()

  const hasLowStock = computed(() => lowStockCount.value > 0)

  async function refreshLowStockAlerts() {
    loading.value = true
    error.value = null
    try {
      const res = await request<{ items: LowStockItem[]; total: number }>(
        `/inventory/low-stock?threshold=${LOW_STOCK_THRESHOLD}&limit=5&offset=0&withTotal=true`
      )
      lowStockItems.value = res.items ?? []
      lowStockCount.value = res.total ?? 0
    } catch (e: unknown) {
      error.value = (e as { message?: string }).message ?? 'Failed to load low stock alerts'
    } finally {
      loading.value = false
    }
  }

  function startLowStockPolling() {
    if (pollId) return
    void refreshLowStockAlerts()
    pollId = setInterval(() => void refreshLowStockAlerts(), POLL_MS)
  }

  function stopLowStockPolling() {
    if (pollId) {
      clearInterval(pollId)
      pollId = null
    }
  }

  return {
    lowStockCount,
    lowStockItems,
    hasLowStock,
    loading,
    error,
    refreshLowStockAlerts,
    startLowStockPolling,
    stopLowStockPolling
  }
}

let singleton: ReturnType<typeof useLowStockAlerts> | null = null

export function useLowStockAlertsShared() {
  if (!singleton) {
    singleton = useLowStockAlerts()
  }
  return singleton
}

export function useLowStockAlertsBoot() {
  const alerts = useLowStockAlertsShared()

  function onVisibilityChange() {
    if (document.visibilityState === 'visible') {
      void alerts.refreshLowStockAlerts()
    }
  }

  onMounted(() => {
    alerts.startLowStockPolling()
    document.addEventListener('visibilitychange', onVisibilityChange)
  })

  onUnmounted(() => {
    alerts.stopLowStockPolling()
    document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  return alerts
}
