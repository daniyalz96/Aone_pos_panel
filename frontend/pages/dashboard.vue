<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'
import { useTodayOverview } from '~/composables/useTodayOverview'

type SalesTrendRow = {
  period: string
  invoice_count: number
  total_sales: number | string
  total_tax: number | string
  gross_profit?: number | string
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

type WeekSalesProfitPoint = { label: string; sales: number; profit: number; expenses: number }
type MonthlyProfitPoint = { label: string; sales: number; profit: number; expenses: number }
type TopProfitProductPoint = { productName: string; profit: number }

type WeeklyExpenseRow = { period: string; expenses: number }
type MonthlyExpenseRow = { month: string; expenses: number }

type DashboardSummary = {
  today_sales: number | string
  today_invoice_count: number
  yesterday_sales: number | string
  yesterday_invoice_count: number
  month_sales?: number | string
  month_invoice_count?: number
  last_month_sales?: number | string
  year_sales?: number | string
  year_invoice_count?: number
  last_year_sales?: number | string
  today_gross_profit?: number | string
  yesterday_gross_profit?: number | string
  month_gross_profit?: number | string
  last_month_gross_profit?: number | string
  year_gross_profit?: number | string
  last_year_gross_profit?: number | string
  low_stock_item_count: number
  today_expenses_total?: number | string
  today_expenses_personal?: number | string
  today_expenses_business?: number | string
  today_expenses_charity?: number | string
  yesterday_expenses_total?: number | string
  month_expenses_total?: number | string
  last_month_expenses_total?: number | string
  year_expenses_total?: number | string
  last_year_expenses_total?: number | string
  today_net_sales_minus_expenses?: number | string
}

type KpiMetricId =
  | 'today_sales'
  | 'month_sales'
  | 'year_sales'
  | 'today_profit'
  | 'month_profit'
  | 'year_profit'
  | 'today_expenses'
  | 'month_expenses'
  | 'year_expenses'
  | 'low_stock'

type KpiKind = 'sales' | 'profit' | 'expenses' | 'low_stock'
type KpiPeriod = 'today' | 'month' | 'year'

const KPI_PERIOD_STORAGE_KEY = 'aone-dashboard-kpi-period'
const KPI_LEGACY_STORAGE_KEY = 'aone-dashboard-kpi-slots'
const FIXED_KPI_KINDS: KpiKind[] = ['sales', 'profit', 'expenses', 'low_stock']

const kpiPeriodChips: Array<{ label: string; value: KpiPeriod }> = [
  { label: 'Today', value: 'today' },
  { label: 'Monthly', value: 'month' },
  { label: 'Yearly', value: 'year' }
]

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
const { kpis: kpiSummary, loading: kpiLoading, error: kpiError, refreshTodayOverview } = useTodayOverview()

function fmtPkr(n: number) {
  return `Rs ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

function isKpiPeriod(v: unknown): v is KpiPeriod {
  return v === 'today' || v === 'month' || v === 'year'
}

function metricIdFor(kind: KpiKind, period: KpiPeriod): KpiMetricId {
  if (kind === 'low_stock') return 'low_stock'
  return `${period}_${kind}` as KpiMetricId
}

function metricIdToConfig(id: KpiMetricId): { kind: KpiKind; period: KpiPeriod } {
  if (id === 'low_stock') return { kind: 'low_stock', period: 'today' }
  if (id.startsWith('today_')) return { period: 'today', kind: id.slice(6) as KpiKind }
  if (id.startsWith('month_')) return { period: 'month', kind: id.slice(6) as KpiKind }
  if (id.startsWith('year_')) return { period: 'year', kind: id.slice(5) as KpiKind }
  return { kind: 'sales', period: 'today' }
}

function loadKpiPeriod(): KpiPeriod {
  if (!import.meta.client) return 'today'
  try {
    const saved = localStorage.getItem(KPI_PERIOD_STORAGE_KEY)
    if (isKpiPeriod(saved)) return saved

    const legacy = localStorage.getItem(KPI_LEGACY_STORAGE_KEY)
    if (legacy) {
      const parsed = JSON.parse(legacy) as unknown
      if (Array.isArray(parsed) && parsed.length > 0) {
        const first = parsed[0]
        if (isKpiPeriod(first)) return first
        if (typeof first === 'object' && first !== null && isKpiPeriod((first as { period?: unknown }).period)) {
          return (first as { period: KpiPeriod }).period
        }
        if (typeof first === 'string' && first.includes('_')) {
          const period = first.split('_')[0]
          if (isKpiPeriod(period)) return period
        }
      }
    }
  } catch {
    /* ignore */
  }
  return 'today'
}

const kpiPeriod = ref<KpiPeriod>(loadKpiPeriod())

watch(kpiPeriod, (period) => {
  if (import.meta.client) localStorage.setItem(KPI_PERIOD_STORAGE_KEY, period)
})

function kpiMetricTitle(metricId: KpiMetricId): string {
  const kindLabel: Record<KpiKind, string> = {
    sales: 'Sales',
    profit: 'Profit',
    expenses: 'Expenses',
    low_stock: 'Low stock items'
  }
  const periodLabel: Record<KpiPeriod, string> = {
    today: 'Today',
    month: 'Monthly',
    year: 'Yearly'
  }
  const config = metricIdToConfig(metricId)
  if (config.kind === 'low_stock') return kindLabel.low_stock
  return `${periodLabel[config.period]} ${kindLabel[config.kind]}`
}

function pctVsPrior(today: number, prior: number, priorLabel: string) {
  if (!Number.isFinite(prior) || prior <= 0) {
    if (today > 0) return `Up from zero ${priorLabel}`
    return `No data ${priorLabel}`
  }
  const pct = ((today - prior) / prior) * 100
  const sign = pct >= 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}% vs ${priorLabel}`
}

function buildKpiCard(metricId: KpiMetricId): StatCard {
  const title = kpiMetricTitle(metricId)
  const loading = kpiLoading.value && !kpiSummary.value

  if (loading) {
    return { title, value: '…', delta: 'Loading…', icon: 'i-lucide-loader', positive: true }
  }

  if (kpiError.value || !kpiSummary.value) {
    return { title, value: '—', delta: 'Could not load', icon: 'i-lucide-alert-circle', positive: false }
  }

  const s = kpiSummary.value

  switch (metricId) {
    case 'today_sales': {
      const today = Number(s.today_sales)
      const prior = Number(s.yesterday_sales)
      return {
        title,
        value: fmtPkr(today),
        delta: pctVsPrior(today, prior, 'yesterday'),
        icon: 'i-lucide-wallet',
        positive: today >= prior,
        to: '/reports'
      }
    }
    case 'month_sales': {
      const cur = Number(s.month_sales ?? 0)
      const prior = Number(s.last_month_sales ?? 0)
      return {
        title,
        value: fmtPkr(cur),
        delta: pctVsPrior(cur, prior, 'last month'),
        icon: 'i-lucide-calendar-range',
        positive: cur >= prior,
        to: '/reports'
      }
    }
    case 'year_sales': {
      const cur = Number(s.year_sales ?? 0)
      const prior = Number(s.last_year_sales ?? 0)
      return {
        title,
        value: fmtPkr(cur),
        delta: pctVsPrior(cur, prior, 'last year'),
        icon: 'i-lucide-calendar-days',
        positive: cur >= prior,
        to: '/reports'
      }
    }
    case 'today_profit': {
      const today = Number(s.today_gross_profit ?? 0)
      const prior = Number(s.yesterday_gross_profit ?? 0)
      return {
        title,
        value: fmtPkr(today),
        delta: pctVsPrior(today, prior, 'yesterday'),
        icon: 'i-lucide-trending-up',
        positive: today >= prior,
        to: '/reports'
      }
    }
    case 'month_profit': {
      const cur = Number(s.month_gross_profit ?? 0)
      const prior = Number(s.last_month_gross_profit ?? 0)
      return {
        title,
        value: fmtPkr(cur),
        delta: pctVsPrior(cur, prior, 'last month'),
        icon: 'i-lucide-line-chart',
        positive: cur >= prior,
        to: '/reports'
      }
    }
    case 'year_profit': {
      const cur = Number(s.year_gross_profit ?? 0)
      const prior = Number(s.last_year_gross_profit ?? 0)
      return {
        title,
        value: fmtPkr(cur),
        delta: pctVsPrior(cur, prior, 'last year'),
        icon: 'i-lucide-chart-no-axes-combined',
        positive: cur >= prior,
        to: '/reports'
      }
    }
    case 'today_expenses': {
      const today = Number(s.today_expenses_total ?? 0)
      const prior = Number(s.yesterday_expenses_total ?? 0)
      const sales = Number(s.today_sales)
      return {
        title,
        value: fmtPkr(today),
        delta: `Net ${fmtPkr(Number(s.today_net_sales_minus_expenses ?? sales - today))}`,
        icon: 'i-lucide-receipt',
        positive: today <= prior,
        to: '/expenses'
      }
    }
    case 'month_expenses': {
      const cur = Number(s.month_expenses_total ?? 0)
      const prior = Number(s.last_month_expenses_total ?? 0)
      return {
        title,
        value: fmtPkr(cur),
        delta: pctVsPrior(cur, prior, 'last month'),
        icon: 'i-lucide-receipt',
        positive: cur <= prior,
        to: '/expenses'
      }
    }
    case 'year_expenses': {
      const cur = Number(s.year_expenses_total ?? 0)
      const prior = Number(s.last_year_expenses_total ?? 0)
      return {
        title,
        value: fmtPkr(cur),
        delta: pctVsPrior(cur, prior, 'last year'),
        icon: 'i-lucide-receipt',
        positive: cur <= prior,
        to: '/expenses'
      }
    }
    case 'low_stock': {
      const lowStock = Number(s.low_stock_item_count)
      return {
        title,
        value: String(lowStock),
        delta: lowStock === 0 ? 'No restock alerts' : 'Restock recommended',
        icon: 'i-lucide-box',
        positive: lowStock === 0,
        to: '/inventory'
      }
    }
    default:
      return { title, value: '—', delta: '', icon: 'i-lucide-minus', positive: false }
  }
}

type KpiCardView = StatCard & { metricId: KpiMetricId }

const kpiCards = computed<KpiCardView[]>(() =>
  FIXED_KPI_KINDS.map((kind) => {
    const metricId = metricIdFor(kind, kpiPeriod.value)
    return {
      metricId,
      ...buildKpiCard(metricId)
    }
  })
)

const expenseTypeCards = computed(() => {
  const s = kpiSummary.value
  if (!s) return []
  return [
    { label: 'Personal', value: Number(s.today_expenses_personal ?? 0), icon: 'i-lucide-shopping-basket' },
    { label: 'Business', value: Number(s.today_expenses_business ?? 0), icon: 'i-lucide-building-2' },
    { label: 'Charity', value: Number(s.today_expenses_charity ?? 0), icon: 'i-lucide-heart-handshake' }
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

const DEMO_WEEK_SALES_PROFIT: WeekSalesProfitPoint[] = [
  { label: 'Sat', sales: 72_400, profit: 18_200, expenses: 4_200 },
  { label: 'Sun', sales: 68_100, profit: 16_800, expenses: 3_800 },
  { label: 'Mon', sales: 91_200, profit: 24_400, expenses: 5_100 },
  { label: 'Tue', sales: 84_000, profit: 21_600, expenses: 4_600 },
  { label: 'Wed', sales: 96_500, profit: 26_100, expenses: 5_400 },
  { label: 'Thu', sales: 88_300, profit: 22_000, expenses: 4_900 },
  { label: 'Fri', sales: 102_000, profit: 28_800, expenses: 6_200 }
]

const DEMO_TOP_PROFIT_PRODUCTS: TopProfitProductPoint[] = [
  { productName: 'Basmati 5kg', profit: 18_400 },
  { productName: 'Cooking oil 1L', profit: 14_200 },
  { productName: 'Whole milk 1L', profit: 11_800 },
  { productName: 'Sugar 2kg', profit: 9_600 },
  { productName: 'Tea 950g', profit: 8_100 },
  { productName: 'Laundry soap', profit: 6_900 }
]

const DEMO_MONTHLY_PROFIT: MonthlyProfitPoint[] = [
  { label: 'Dec', sales: 380_000, profit: 42_000, expenses: 18_500 },
  { label: 'Jan', sales: 442_000, profit: 51_000, expenses: 21_200 },
  { label: 'Feb', sales: 395_500, profit: 47_500, expenses: 19_800 },
  { label: 'Mar', sales: 468_200, profit: 58_200, expenses: 22_400 },
  { label: 'Apr', sales: 512_100, profit: 62_100, expenses: 24_100 },
  { label: 'May', sales: 489_400, profit: 55_400, expenses: 23_600 }
]

/** Demo pie slices: monthly invoice totals (Rs) — shown when analytics unavailable */
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

const hourlySeries = ref<{ label: string; amount: number }[]>([])
const weeklySalesProfitSeries = ref<WeekSalesProfitPoint[]>([])
const topProfitProducts = ref<TopProfitProductPoint[]>([])
const monthlyProfitSeries = ref<MonthlyProfitPoint[]>([])
const monthlySalesPieSeries = ref<{ name: string; y: number }[]>([])

function startOfDay(d: Date) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parsePeriodKey(period: string): string {
  const s = String(period).trim()
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s)
  if (iso) return iso[1]
  const d = new Date(s)
  if (!Number.isNaN(d.getTime())) return localDateKey(d)
  return s.slice(0, 10)
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

function padLastMonthsSalesProfit(
  marginRows: ProfitMarginRow[],
  salesByMonth: Map<string, number>,
  expenseByMonth: Map<string, number>,
  monthCount = 6
): MonthlyProfitPoint[] {
  const marginMap = new Map<string, ProfitMarginRow>()
  for (const r of marginRows) {
    const key = String(r.month).trim().slice(0, 7)
    if (key.length >= 7) marginMap.set(key, r)
  }
  const out: MonthlyProfitPoint[] = []
  const now = new Date()
  for (let i = monthCount - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const monthKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const m = marginMap.get(monthKey)
    out.push({
      label: d.toLocaleString(undefined, { month: 'short' }),
      sales: salesByMonth.get(monthKey) ?? 0,
      profit: m ? Number(m.gross_profit) : 0,
      expenses: expenseByMonth.get(monthKey) ?? 0
    })
  }
  return out
}

function padLastDaysSalesProfit(
  rows: SalesTrendRow[],
  expenseByDay: Map<string, number>,
  dayCount = 7
): WeekSalesProfitPoint[] {
  const map = new Map<string, SalesTrendRow>()
  for (const r of rows) {
    map.set(parsePeriodKey(r.period), r)
  }
  const out: WeekSalesProfitPoint[] = []
  const today = new Date()
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setHours(12, 0, 0, 0)
    d.setDate(d.getDate() - i)
    const key = localDateKey(d)
    const row = map.get(key)
    out.push({
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
      sales: row ? Number(row.total_sales) : 0,
      profit: row ? Number(row.gross_profit ?? 0) : 0,
      expenses: expenseByDay.get(key) ?? 0
    })
  }
  return out
}

function expenseRowsToDayMap(rows: WeeklyExpenseRow[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of rows) {
    map.set(parsePeriodKey(r.period), Number(r.expenses) || 0)
  }
  return map
}

function expenseRowsToMonthMap(rows: MonthlyExpenseRow[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of rows) {
    map.set(String(r.month), Number(r.expenses) || 0)
  }
  return map
}

function salesTrendToMonthMap(rows: SalesTrendRow[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const r of rows) {
    const key = String(r.period).trim().slice(0, 7)
    if (key.length >= 7) map.set(key, Number(r.total_sales) || 0)
  }
  return map
}

function applyDemoAnalytics() {
  hourlySeries.value = [...DEMO_HOURLY]
  weeklySalesProfitSeries.value = [...DEMO_WEEK_SALES_PROFIT]
  topProfitProducts.value = [...DEMO_TOP_PROFIT_PRODUCTS]
  monthlyProfitSeries.value = [...DEMO_MONTHLY_PROFIT]
  monthlySalesPieSeries.value = [...DEMO_MONTHLY_SALES_PIE]
}

function clearAnalytics() {
  hourlySeries.value = [{ label: '—', amount: 0 }]
  weeklySalesProfitSeries.value = padLastDaysSalesProfit([], new Map(), 7)
  topProfitProducts.value = []
  monthlyProfitSeries.value = padLastMonthsSalesProfit([], new Map(), new Map(), 6)
  monthlySalesPieSeries.value = []
}

async function loadAnalytics() {
  if (!import.meta.client) return

  hydrateFromStorage()

  if (!canViewAnalytics.value) {
    analyticsLive.value = false
    applyDemoAnalytics()
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

    const [hourlyRes, weekRes, weekExpRes, topRes, marginRes, monthExpRes, monthPieRes] =
      await Promise.allSettled([
      request<SalesTrendRow[]>(`/reports/analytics/sales-trend?bucket=hour&${rangeToday}`),
      request<SalesTrendRow[]>(`/reports/analytics/sales-trend?bucket=day&${rangeWeek}`),
      request<WeeklyExpenseRow[]>(`/expenses/analytics/weekly?${rangeWeek}`),
      request<TopItemRow[]>(`/reports/analytics/top-items?limit=8&${qsRange(thirtyBack, now)}`),
      request<ProfitMarginRow[]>(`/reports/profit-margin?${monthRange}`),
      request<MonthlyExpenseRow[]>(`/expenses/analytics/monthly?${monthRange}`),
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
      hourlySeries.value = [{ label: '—', amount: 0 }]
    }

    if (weekRes.status === 'fulfilled' || weekExpRes.status === 'fulfilled') {
      const expenseByDay =
        weekExpRes.status === 'fulfilled'
          ? expenseRowsToDayMap(weekExpRes.value)
          : new Map<string, number>()
      const salesRows = weekRes.status === 'fulfilled' ? weekRes.value : []
      weeklySalesProfitSeries.value = padLastDaysSalesProfit(salesRows, expenseByDay, 7)
      anyLive = true
    } else {
      weeklySalesProfitSeries.value = padLastDaysSalesProfit([], new Map(), 7)
    }

    if (topRes.status === 'fulfilled') {
      anyLive = true
      const topItems = topRes.value
      topProfitProducts.value = [...topItems]
        .map((r) => ({
          productName: String(r.product_name ?? '').trim() || 'Unknown product',
          profit: Number(r.gross_profit)
        }))
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 6)
    } else {
      topProfitProducts.value = []
    }

    const salesByMonth =
      monthPieRes.status === 'fulfilled' ? salesTrendToMonthMap(monthPieRes.value) : new Map<string, number>()
    const expenseByMonth =
      monthExpRes.status === 'fulfilled' ? expenseRowsToMonthMap(monthExpRes.value) : new Map<string, number>()

    if (marginRes.status === 'fulfilled') {
      anyLive = true
      monthlyProfitSeries.value = padLastMonthsSalesProfit(
        marginRes.value,
        salesByMonth,
        expenseByMonth,
        6
      )
    } else if (salesByMonth.size > 0) {
      anyLive = true
      monthlyProfitSeries.value = padLastMonthsSalesProfit([], salesByMonth, expenseByMonth, 6)
    } else {
      monthlyProfitSeries.value = padLastMonthsSalesProfit([], salesByMonth, expenseByMonth, 6)
    }

    if (monthPieRes.status === 'fulfilled') {
      monthlySalesPieSeries.value = monthlySalesRowsToPie(monthPieRes.value)
      anyLive = true
    } else {
      monthlySalesPieSeries.value = []
    }

    analyticsLive.value = anyLive
  } catch {
    analyticsLive.value = false
    clearAnalytics()
  } finally {
    analyticsLoading.value = false
  }
}

async function loadDashboardKpis() {
  if (!import.meta.client) return
  hydrateFromStorage()
  await refreshTodayOverview()
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
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-for="chip in kpiPeriodChips"
          :key="chip.value"
          type="button"
          class="rounded-full px-4 py-1.5 text-sm font-medium transition-colors"
          :class="
            kpiPeriod === chip.value
              ? 'bg-primary text-white shadow-sm'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
          "
          @click="kpiPeriod = chip.value"
        >
          {{ chip.label }}
        </button>
      </div>

      <div class="grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <UiMetricCard
          v-for="(card, index) in kpiCards"
          :key="`${index}-${card.metricId}`"
          :title="card.title"
          :value="card.value"
          :delta="card.delta"
          :icon="card.icon"
          :positive="card.positive"
          :to="card.to"
        />
      </div>
    </div>

    <div v-if="expenseTypeCards.length" class="grid gap-3 sm:grid-cols-3">
      <UCard v-for="card in expenseTypeCards" :key="card.label">
        <div class="flex items-center gap-3">
          <div class="rounded-lg bg-amber-50 p-2 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            <UIcon :name="card.icon" class="size-5" />
          </div>
          <div>
            <p class="text-xs text-slate-500">Today · {{ card.label }}</p>
            <p class="text-lg font-semibold text-slate-900 dark:text-slate-100">{{ fmtPkr(card.value) }}</p>
          </div>
        </div>
      </UCard>
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
        <ClientOnly>
          <DashboardHourlySalesChart :points="hourlySeries" />
          <template #fallback>
            <div class="flex min-h-[300px] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              Loading chart…
            </div>
          </template>
        </ClientOnly>
      </UCard>

      <!--
      <UCard>
        <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Cashier Activity</h2>
        <div class="mt-4 space-y-3">
          <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
            <p class="text-sm font-medium text-slate-800 dark:text-slate-100">Ali Raza</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">42 sales • Rs 38,200</p>
          </div>
          <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
            <p class="text-sm font-medium text-slate-800 dark:text-slate-100">Sana Iqbal</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">37 sales • Rs 34,500</p>
          </div>
          <div class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
            <p class="text-sm font-medium text-slate-800 dark:text-slate-100">Aamir Khan</p>
            <p class="text-xs text-slate-500 dark:text-slate-400">31 sales • Rs 29,840</p>
          </div>
        </div>
      </UCard>
      -->

      <UCard>
        <div class="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Monthly sales</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              Posted invoice totals by month
              <span v-if="analyticsLive"> · live data</span>
              <span v-else-if="!canViewAnalytics"> · sample preview</span>
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
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">7-day sales &amp; profit</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">
              Sales, gross profit, and recorded expenses · last 7 days
            </p>
          </div>
          <div class="flex items-center gap-2">
            <UBadge v-if="analyticsLoading" color="neutral" variant="soft">Loading…</UBadge>
            <UBadge v-else-if="analyticsLive" color="primary" variant="soft">Live</UBadge>
            <UBadge v-else color="neutral" variant="subtle">Demo</UBadge>
          </div>
        </div>
        <ClientOnly>
          <DashboardWeeklySalesProfitChart :points="weeklySalesProfitSeries" />
          <template #fallback>
            <div class="flex min-h-[320px] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              Loading chart…
            </div>
          </template>
        </ClientOnly>
      </UCard>

      <UCard>
        <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Top profit products</h2>
            <p class="text-xs text-slate-500 dark:text-slate-400">Gross profit by product name · last 30 days</p>
          </div>
          <div class="flex items-center gap-2">
            <UBadge v-if="analyticsLoading" color="neutral" variant="soft">Loading…</UBadge>
            <UBadge v-else-if="analyticsLive" color="primary" variant="soft">Live</UBadge>
            <UBadge v-else color="neutral" variant="subtle">Demo</UBadge>
          </div>
        </div>
        <ClientOnly>
          <DashboardTopProfitProductsChart :products="topProfitProducts" />
          <template #fallback>
            <div class="flex min-h-[260px] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
              Loading chart…
            </div>
          </template>
        </ClientOnly>
      </UCard>
    </div>

    <UCard>
      <div class="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Monthly sales &amp; gross profit</h2>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            Total sales, gross profit, and expenses · recent months
          </p>
        </div>
        <div class="flex items-center gap-2">
          <UBadge v-if="analyticsLoading" color="neutral" variant="soft">Loading…</UBadge>
          <UBadge v-else-if="analyticsLive" color="primary" variant="soft">Live</UBadge>
          <UBadge v-else color="neutral" variant="subtle">Demo</UBadge>
        </div>
      </div>
      <ClientOnly>
        <DashboardMonthlyProfitChart :points="monthlyProfitSeries" />
        <template #fallback>
          <div class="flex min-h-[280px] items-center justify-center text-sm text-slate-500 dark:text-slate-400">
            Loading chart…
          </div>
        </template>
      </ClientOnly>
      <div v-if="canViewAnalytics" class="mt-4 flex justify-end border-t border-slate-100 pt-3 dark:border-slate-800">
        <NuxtLink class="text-xs font-medium text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300" to="/reports">
          Open detailed reports →
        </NuxtLink>
      </div>
    </UCard>
  </section>
</template>
