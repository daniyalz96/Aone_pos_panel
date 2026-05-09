<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'

type SalesTrendRow = {
  period: string
  invoice_count: number
  total_sales: number | string
  total_tax: number | string
}

type TopItemRow = {
  product_name: string
  gross_profit: number | string
  gross_revenue: number | string
}

type ProfitMarginRow = {
  month: string
  gross_profit: number | string
  margin_percent: number | string
}

type WeekBarPoint = { label: string; primary: number; secondary: number }

type DashboardSummary = {
  today_sales: number | string
  today_invoice_count: number
  yesterday_sales: number | string
  yesterday_invoice_count: number
  pending_payment_amount: number | string
  pending_payment_invoice_count: number
  low_stock_item_count: number
}

type StatCard = {
  title: string
  value: string
  delta: string
  icon: string
  positive: boolean
  to?: string
}

const { request } = useApi()
const { user, hydrateFromStorage } = useAuth()

const kpiSummary = ref<DashboardSummary | null>(null)
const kpiLoading = ref(false)
const kpiError = ref(false)

function fmtPkr(n: number) {
  return `PKR ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

function pctVsYesterday(today: number, yesterday: number) {
  if (!Number.isFinite(yesterday) || yesterday <= 0) {
    if (today > 0) return 'Up from zero yesterday'
    return 'No sales yesterday'
  }
  const pct = ((today - yesterday) / yesterday) * 100
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}% vs yesterday`
}

function countVsYesterday(today: number, yesterday: number) {
  const d = today - yesterday
  if (yesterday === 0 && today === 0) return 'No invoices yet'
  if (yesterday === 0) return `${today} invoice${today === 1 ? '' : 's'} today`
  const sign = d >= 0 ? '+' : ''
  return `${sign}${d} vs yesterday`
}

const quickStats = computed<StatCard[]>(() => {
  const loading = kpiLoading.value && !kpiSummary.value
  if (loading) {
    return [
      { title: 'Today Sales', value: '…', delta: 'Loading…', icon: 'i-lucide-wallet', positive: true },
      { title: 'Transactions', value: '…', delta: 'Loading…', icon: 'i-lucide-receipt-text', positive: true },
      { title: 'Pending Payments', value: '…', delta: 'Loading…', icon: 'i-lucide-circle-alert', positive: false },
      { title: 'Low Stock Items', value: '…', delta: 'Loading…', icon: 'i-lucide-box', positive: false, to: '/restock' }
    ]
  }

  if (kpiError.value || !kpiSummary.value) {
    return [
      { title: 'Today Sales', value: '—', delta: 'Could not load', icon: 'i-lucide-wallet', positive: false },
      { title: 'Transactions', value: '—', delta: 'Could not load', icon: 'i-lucide-receipt-text', positive: false },
      { title: 'Pending Payments', value: '—', delta: 'Could not load', icon: 'i-lucide-circle-alert', positive: false },
      { title: 'Low Stock Items', value: '—', delta: 'Could not load', icon: 'i-lucide-box', positive: false, to: '/restock' }
    ]
  }

  const s = kpiSummary.value
  const todaySales = Number(s.today_sales)
  const ySales = Number(s.yesterday_sales)
  const txToday = Number(s.today_invoice_count)
  const txYest = Number(s.yesterday_invoice_count)
  const pendingAmt = Number(s.pending_payment_amount)
  const pendingCnt = Number(s.pending_payment_invoice_count)
  const lowStock = Number(s.low_stock_item_count)

  const salesPctGood = todaySales >= ySales
  const txGood = txToday >= txYest

  return [
    {
      title: 'Today Sales',
      value: fmtPkr(todaySales),
      delta: pctVsYesterday(todaySales, ySales),
      icon: 'i-lucide-wallet',
      positive: salesPctGood
    },
    {
      title: 'Transactions',
      value: String(txToday),
      delta: countVsYesterday(txToday, txYest),
      icon: 'i-lucide-receipt-text',
      positive: txGood
    },
    {
      title: 'Pending Payments',
      value: fmtPkr(pendingAmt),
      delta:
        pendingCnt === 0
          ? 'All invoices paid'
          : `${pendingCnt} invoice${pendingCnt === 1 ? '' : 's'} outstanding`,
      icon: 'i-lucide-circle-alert',
      positive: pendingAmt === 0
    },
    {
      title: 'Low Stock Items',
      value: String(lowStock),
      delta: lowStock === 0 ? 'No restock alerts' : 'Restock recommended',
      icon: 'i-lucide-box',
      positive: lowStock === 0,
      to: '/restock'
    }
  ]
})

const DEMO_HOURLY = [
  { label: '09:00', amount: 12_600 },
  { label: '10:00', amount: 19_200 },
  { label: '11:00', amount: 15_400 },
  { label: '12:00', amount: 26_800 },
  { label: '13:00', amount: 30_200 },
  { label: '14:00', amount: 24_100 }
]

const DEMO_WEEK: WeekBarPoint[] = [
  { label: 'Sat', primary: 72_400, secondary: 8_200 },
  { label: 'Sun', primary: 68_100, secondary: 7_800 },
  { label: 'Mon', primary: 91_200, secondary: 10_400 },
  { label: 'Tue', primary: 84_000, secondary: 9_600 },
  { label: 'Wed', primary: 96_500, secondary: 11_100 },
  { label: 'Thu', primary: 88_300, secondary: 10_000 },
  { label: 'Fri', primary: 102_000, secondary: 11_800 }
]

const DEMO_PROFIT_LEADERS = [
  { label: 'Basmati 5kg', value: 18_400 },
  { label: 'Cooking oil 1L', value: 14_200 },
  { label: 'Whole milk 1L', value: 11_800 },
  { label: 'Sugar 2kg', value: 9_600 },
  { label: 'Tea 950g', value: 8_100 },
  { label: 'Laundry soap', value: 6_900 }
]

const DEMO_MONTHLY_PROFIT = [
  { label: 'Dec', value: 42_000 },
  { label: 'Jan', value: 51_000 },
  { label: 'Feb', value: 47_500 },
  { label: 'Mar', value: 58_200 },
  { label: 'Apr', value: 62_100 },
  { label: 'May', value: 55_400 }
]

/** Demo pie slices: monthly invoice totals (PKR) — shown when analytics unavailable */
const DEMO_MONTHLY_SALES_PIE = [
  { name: 'Dec', y: 380_000 },
  { name: 'Jan', y: 442_000 },
  { name: 'Feb', y: 395_500 },
  { name: 'Mar', y: 468_200 },
  { name: 'Apr', y: 512_100 },
  { name: 'May', y: 489_400 }
]

const canViewAnalytics = computed(() => {
  const roles = user.value?.roles ?? []
  return roles.some((r) => r === 'admin' || r === 'manager')
})

const analyticsLoading = ref(false)
const analyticsLive = ref(false)

const hourlySeries = ref<{ label: string; amount: number }[]>([...DEMO_HOURLY])
const weeklySeries = ref<WeekBarPoint[]>([...DEMO_WEEK])
const profitLeaderSeries = ref<{ label: string; value: number }[]>([...DEMO_PROFIT_LEADERS])
const monthlyProfitSeries = ref<{ label: string; value: number }[]>([...DEMO_MONTHLY_PROFIT])
const monthlySalesPieSeries = ref<{ name: string; y: number }[]>([...DEMO_MONTHLY_SALES_PIE])

const maxHourlyAmount = computed(() => Math.max(1, ...hourlySeries.value.map((h) => h.amount)))

function hourlyBarHeight(amount: number) {
  const h = Math.round((amount / maxHourlyAmount.value) * 108)
  return `${Math.max(6, h)}px`
}

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function qsRange(from: Date, to: Date) {
  const f = encodeURIComponent(from.toISOString())
  const t = encodeURIComponent(to.toISOString())
  return `from=${f}&to=${t}`
}

function fmtHourPeriod(period: string) {
  const match = /\b(\d{2}):\d{2}\b/.exec(period)
  if (match) return `${match[1]}:00`
  return period.length > 5 ? period.slice(-5) : period
}

function monthPeriodToPieLabel(period: string): string {
  const parts = period.split(/[-/:]/).map((p) => p.trim())
  const y = Number(parts[0])
  const m = parts.length >= 2 ? Number(parts[1]) : Number.NaN
  if (!Number.isFinite(m) || m < 1 || m > 12) return period
  const label =
    Number.isFinite(y) && parts[0]?.length === 4
      ? new Date(y, m - 1, 1).toLocaleString(undefined, { month: 'short', year: '2-digit' })
      : new Date(2000, m - 1, 1).toLocaleString(undefined, { month: 'short' })
  return label
}

function monthlySalesRowsToPie(rows: SalesTrendRow[]): { name: string; y: number }[] {
  const sorted = [...rows].sort((a, b) => a.period.localeCompare(b.period))
  const lastSix = sorted.slice(-6)
  return lastSix.map((r) => ({
    name: monthPeriodToPieLabel(r.period.trim()),
    y: Number(r.total_sales)
  }))
}

function padLastDays(rows: SalesTrendRow[], dayCount = 7): WeekBarPoint[] {
  const map = new Map<string, SalesTrendRow>()
  for (const r of rows) {
    const key = r.period.slice(0, 10)
    map.set(key, r)
  }
  const out: WeekBarPoint[] = []
  const today = new Date()
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const row = map.get(key)
    out.push({
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      primary: row ? Number(row.total_sales) : 0,
      secondary: row ? Number(row.total_tax) : 0
    })
  }
  return out
}

async function loadAnalytics() {
  if (!import.meta.client) return

  hydrateFromStorage()

  if (!canViewAnalytics.value) {
    analyticsLive.value = false
    hourlySeries.value = [...DEMO_HOURLY]
    weeklySeries.value = [...DEMO_WEEK]
    profitLeaderSeries.value = [...DEMO_PROFIT_LEADERS]
    monthlyProfitSeries.value = [...DEMO_MONTHLY_PROFIT]
    monthlySalesPieSeries.value = [...DEMO_MONTHLY_SALES_PIE]
    return
  }

  analyticsLoading.value = true

  try {
    const now = new Date()
    const todayStart = startOfDay(now)
    const weekStart = new Date(now)
    weekStart.setDate(weekStart.getDate() - 7)
    weekStart.setHours(0, 0, 0, 0)
    const thirtyBack = new Date(now.getTime() - 30 * 86400000)
    thirtyBack.setHours(0, 0, 0, 0)
    const sixMonthsBack = new Date(now)
    sixMonthsBack.setMonth(sixMonthsBack.getMonth() - 6)

    const rangeToday = qsRange(todayStart, now)
    const rangeWeek = qsRange(weekStart, now)
    const monthRange = qsRange(sixMonthsBack, now)

    const [hourlyRes, weekRes, topRes, marginRes, monthPieRes] = await Promise.allSettled([
      request<SalesTrendRow[]>(`/reports/analytics/sales-trend?bucket=hour&${rangeToday}`),
      request<SalesTrendRow[]>(`/reports/analytics/sales-trend?bucket=day&${rangeWeek}`),
      request<TopItemRow[]>(`/reports/analytics/top-items?limit=8&${qsRange(thirtyBack, now)}`),
      request<ProfitMarginRow[]>(`/reports/profit-margin?${monthRange}`),
      request<SalesTrendRow[]>(`/reports/analytics/sales-trend?bucket=month&${monthRange}`)
    ])

    let anyLive = false

    if (hourlyRes.status === 'fulfilled') {
      const hourlyRows = hourlyRes.value
      hourlySeries.value =
        hourlyRows.length > 0
          ? [...hourlyRows]
              .sort((a, b) => a.period.localeCompare(b.period))
              .map((r) => ({
                label: fmtHourPeriod(r.period),
                amount: Number(r.total_sales)
              }))
          : [{ label: '—', amount: 0 }]
      anyLive = true
    } else {
      hourlySeries.value = [...DEMO_HOURLY]
    }

    if (weekRes.status === 'fulfilled') {
      weeklySeries.value = padLastDays(weekRes.value, 7)
      anyLive = true
    } else {
      weeklySeries.value = [...DEMO_WEEK]
    }

    if (topRes.status === 'fulfilled') {
      anyLive = true
      const topItems = topRes.value
      profitLeaderSeries.value = [...topItems]
        .map((r) => ({
          label: String(r.product_name),
          value: Number(r.gross_profit)
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
      if (!profitLeaderSeries.value.length) {
        profitLeaderSeries.value = [...DEMO_PROFIT_LEADERS]
      }
    } else {
      profitLeaderSeries.value = [...DEMO_PROFIT_LEADERS]
    }

    if (marginRes.status === 'fulfilled') {
      anyLive = true
      const marginRows = marginRes.value
      const months = [...marginRows].sort((a, b) => a.month.localeCompare(b.month))
      const lastSix = months.slice(-6)
      if (lastSix.length > 0) {
        monthlyProfitSeries.value = lastSix.map((m) => {
          const parts = m.month.split('-')
          const monthNum = parts.length >= 2 ? Number(parts[1]) : Number.NaN
          const label = Number.isFinite(monthNum)
            ? new Date(2000, monthNum - 1, 1).toLocaleString(undefined, { month: 'short' })
            : m.month
          return { label, value: Number(m.gross_profit) }
        })
      } else {
        monthlyProfitSeries.value = [...DEMO_MONTHLY_PROFIT]
      }
    } else {
      monthlyProfitSeries.value = [...DEMO_MONTHLY_PROFIT]
    }

    if (monthPieRes.status === 'fulfilled') {
      const pieFromSales = monthlySalesRowsToPie(monthPieRes.value)
      monthlySalesPieSeries.value = pieFromSales.length ? pieFromSales : [...DEMO_MONTHLY_SALES_PIE]
      anyLive = true
    } else {
      monthlySalesPieSeries.value = [...DEMO_MONTHLY_SALES_PIE]
    }

    analyticsLive.value = anyLive
  } catch {
    analyticsLive.value = false
    hourlySeries.value = [...DEMO_HOURLY]
    weeklySeries.value = [...DEMO_WEEK]
    profitLeaderSeries.value = [...DEMO_PROFIT_LEADERS]
    monthlyProfitSeries.value = [...DEMO_MONTHLY_PROFIT]
    monthlySalesPieSeries.value = [...DEMO_MONTHLY_SALES_PIE]
  } finally {
    analyticsLoading.value = false
  }
}

async function loadDashboardKpis() {
  if (!import.meta.client) return
  hydrateFromStorage()
  kpiLoading.value = true
  kpiError.value = false
  try {
    kpiSummary.value = await request<DashboardSummary>('/home/kpis')
  } catch {
    kpiError.value = true
    kpiSummary.value = null
  } finally {
    kpiLoading.value = false
  }
}

onMounted(() => {
  loadAnalytics()
  loadDashboardKpis()
})

watch(canViewAnalytics, (ok) => {
  if (ok) loadAnalytics()
})
</script>

<template>
  <section class="space-y-6">
    <div class="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <UiMetricCard
        v-for="stat in quickStats"
        :key="stat.title"
        :title="stat.title"
        :value="stat.value"
        :delta="stat.delta"
        :icon="stat.icon"
        :positive="stat.positive"
        :to="stat.to"
      />
    </div>

    <div class="grid gap-6 xl:grid-cols-3">
      <UCard class="xl:col-span-2">
        <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Sales by hour (today)</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              {{ analyticsLive ? 'Posted invoices in the current day' : 'Sample trend for layout preview' }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <UBadge v-if="analyticsLoading" color="neutral" variant="soft">Loading…</UBadge>
            <UBadge v-else-if="analyticsLive" color="primary" variant="soft">Live</UBadge>
            <UBadge v-else color="neutral" variant="subtle">Demo</UBadge>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <div v-for="point in hourlySeries" :key="point.label" class="space-y-2">
            <div class="flex h-36 items-end rounded-lg bg-slate-100 p-2 dark:bg-slate-800">
              <div
                class="w-full rounded-md bg-emerald-500/80 transition-[height] duration-300 dark:bg-emerald-400/75"
                :style="{ height: hourlyBarHeight(point.amount) }"
              />
            </div>
            <p class="text-center text-xs text-slate-500 dark:text-slate-400">{{ point.label }}</p>
          </div>
        </div>
      </UCard>

      <!--
      <UCard>
        <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Cashier Activity</h2>
        <div class="mt-4 space-y-3">
          <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
            <p class="text-sm font-medium text-slate-800 dark:text-slate-100">Ali Raza</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">42 sales • PKR 38,200</p>
          </div>
          <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
            <p class="text-sm font-medium text-slate-800 dark:text-slate-100">Sana Iqbal</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">37 sales • PKR 34,500</p>
          </div>
          <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
            <p class="text-sm font-medium text-slate-800 dark:text-slate-100">Aamir Khan</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">31 sales • PKR 29,840</p>
          </div>
        </div>
      </UCard>
      -->

      <UCard>
        <div class="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Monthly sales</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              Posted invoice totals by month · last {{ monthlySalesPieSeries.length }} buckets
              <span v-if="analyticsLive">(live)</span>
              <span v-else>(demo)</span>
            </p>
          </div>
          <div class="flex items-center gap-2">
            <UBadge v-if="analyticsLoading" color="neutral" variant="soft">Loading…</UBadge>
            <UBadge v-else-if="analyticsLive" color="primary" variant="soft">Live</UBadge>
            <UBadge v-else color="neutral" variant="subtle">Demo</UBadge>
          </div>
        </div>
        <ClientOnly>
          <DashboardMonthlySalesPie :series="monthlySalesPieSeries" title="" />
          <template #fallback>
            <div class="flex min-h-[280px] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              Loading chart…
            </div>
          </template>
        </ClientOnly>
      </UCard>
    </div>

    <div class="grid gap-6 xl:grid-cols-3">
      <UCard class="xl:col-span-2">
        <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">7-day sales &amp; tax</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              Paired bars: total sales (emerald) vs tax collected (amber)
            </p>
          </div>
          <UBadge v-if="analyticsLive" color="primary" variant="soft">Live</UBadge>
          <UBadge v-else color="neutral" variant="subtle">Demo</UBadge>
        </div>
        <DashboardGroupedMetricBars
          :points="weeklySeries"
          primary-legend="Sales (PKR)"
          secondary-legend="Tax (PKR)"
          :peak-px="128"
        />
      </UCard>

      <UCard>
        <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Top profit SKUs</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">Gross profit · last 30 days</p>
          </div>
          <UBadge v-if="analyticsLive" color="primary" variant="soft">Live</UBadge>
          <UBadge v-else color="neutral" variant="subtle">Demo</UBadge>
        </div>
        <DashboardHorizontalRankedBars :items="profitLeaderSeries" value-prefix="PKR " />
      </UCard>
    </div>

    <UCard>
      <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Monthly gross profit</h2>
          <p class="text-xs text-slate-500 dark:text-slate-400">From posted invoice lines minus product cost · recent months</p>
        </div>
        <UBadge v-if="analyticsLive" color="primary" variant="soft">Live</UBadge>
        <UBadge v-else color="neutral" variant="subtle">Demo</UBadge>
      </div>
      <DashboardMiniTrendBars :points="monthlyProfitSeries" :peak-px="112" />
      <div v-if="canViewAnalytics" class="mt-4 flex justify-end border-t border-slate-100 pt-3 dark:border-slate-800">
        <NuxtLink class="text-xs font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300" to="/reports">
          Open detailed reports →
        </NuxtLink>
      </div>
    </UCard>
  </section>
</template>
