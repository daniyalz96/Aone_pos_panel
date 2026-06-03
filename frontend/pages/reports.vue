<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'

const ALL_BRANCH = '__all__'
const ALL_PAY = '__all__'
const PICK_PRODUCT = '__pick__'
const BRANCH_SHIFT = '__shift__'

/** Dropdown portal must stack above the manual modal backdrop (z-50) */
const manualModalSelectUi = { content: 'z-[300]' }

/** Nuxt UI Select may bind the whole `{ label, value }` item instead of the UUID string */
function resolveProductId(raw: unknown): string {
  if (raw == null || raw === PICK_PRODUCT) return ''
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null && 'value' in raw) {
    const v = (raw as { value: unknown }).value
    if (typeof v === 'string') return v
  }
  return ''
}

type Branch = { id: string; name: string }
type SaleInvoiceRow = {
  id: string
  invoice_number: string
  created_at: string
  total_amount: string | number
  tax_total: string | number
  payment_status: string
  invoice_status: string
  customer_name: string | null
  cashier_name: string | null
  branch_name: string | null
  revenue_ex_tax: string | number
  cogs: string | number
  gross_profit: string | number
}

type ReceiptPayload = {
  header: {
    invoiceNumber: string
    customerName: string | null
    branchName: string | null
    cashierName: string | null
    createdAt: string
  }
  totals: {
    subtotal: number
    discountTotal: number
    taxTotal: number
    totalAmount: number
    paymentStatus: string
    invoiceStatus: string
  }
  items: Array<{
    productName: string
    qty: number
    unitPrice: number
    lineTotal: number
  }>
  payments: Array<{ method: string; amount: number }>
}

const router = useRouter()
const { request } = useApi()
const { user } = useAuth()

const canReturnSale = () => {
  const u = user.value
  if (!u) return false
  if ((u.permissions ?? []).includes('refund_approve')) return true
  return (u.roles ?? []).some((r) => r === 'admin' || r === 'manager')
}

const errorMessage = ref('')
const loading = ref(false)
const branches = ref<Branch[]>([])

const manualProductLeadingItems = [{ label: 'Select product', value: PICK_PRODUCT, name: '', sku: '' }]

const filters = reactive({
  from: '',
  to: '',
  branchId: ALL_BRANCH,
  paymentStatus: ALL_PAY,
  search: ''
})

type PlGroupBy = 'category' | 'department' | 'day' | 'month' | 'item'
type PlSummaryRow = {
  group_key: string
  group_label: string
  invoice_count: number
  qty_sold: string | number
  total_sales: string | number
  discount: string | number
  revenue_ex_tax: string | number
  cogs: string | number
  gross_profit: string | number
  margin_percent: string | number
}
type PlSummaryTotals = PlSummaryRow & { margin_percent: string | number }

const INVOICE_PAGE_SIZE = 25

const salesSummary = ref<Record<string, unknown>>({})
const saleInvoices = ref<SaleInvoiceRow[]>([])
const invoicePage = ref(1)
const invoiceTotal = ref(0)
const invoicesLoading = ref(false)

const plGroupBy = ref<PlGroupBy>('category')
const plSummary = ref<{ rows: PlSummaryRow[]; totals: PlSummaryTotals | null }>({ rows: [], totals: null })
const plLoading = ref(false)

const manualOpen = ref(false)
const manualSubmitting = ref(false)
const manualForm = reactive({
  customerName: '',
  taxInclusive: false,
  branchId: BRANCH_SHIFT,
  payNow: false,
  paymentMethod: 'cash' as 'cash' | 'card' | 'qr' | 'wallet' | 'bank',
  lines: [] as Array<{ productId: string; qty: number }>
})

const queryStringBase = () => {
  const params = new URLSearchParams()
  if (filters.from) params.set('from', new Date(filters.from).toISOString())
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59.999Z`).toISOString())
  if (filters.branchId && filters.branchId !== ALL_BRANCH) params.set('branchId', filters.branchId)
  return params.toString() ? `?${params.toString()}` : ''
}

const querySaleInvoices = () => {
  const params = new URLSearchParams()
  if (filters.from) params.set('from', new Date(filters.from).toISOString())
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59.999Z`).toISOString())
  if (filters.branchId && filters.branchId !== ALL_BRANCH) params.set('branchId', filters.branchId)
  if (filters.paymentStatus && filters.paymentStatus !== ALL_PAY) params.set('paymentStatus', filters.paymentStatus)
  if (filters.search.trim()) params.set('query', filters.search.trim())
  params.set('limit', String(INVOICE_PAGE_SIZE))
  params.set('offset', String((invoicePage.value - 1) * INVOICE_PAGE_SIZE))
  return `?${params.toString()}`
}

const queryPlSummary = () => {
  const params = new URLSearchParams(queryStringBase().replace(/^\?/, ''))
  params.set('groupBy', plGroupBy.value)
  return `?${params.toString()}`
}

const invoicePageCount = computed(() => Math.max(1, Math.ceil(invoiceTotal.value / INVOICE_PAGE_SIZE)))
const invoiceRangeStart = computed(() =>
  invoiceTotal.value === 0 ? 0 : (invoicePage.value - 1) * INVOICE_PAGE_SIZE + 1
)
const invoiceRangeEnd = computed(() => Math.min(invoicePage.value * INVOICE_PAGE_SIZE, invoiceTotal.value))

const plGroupByOptions = [
  { label: 'Category', value: 'category' as PlGroupBy },
  { label: 'Department', value: 'department' as PlGroupBy },
  { label: 'Day', value: 'day' as PlGroupBy },
  { label: 'Month', value: 'month' as PlGroupBy },
  { label: 'Item', value: 'item' as PlGroupBy }
]

const plGroupColumnLabel = computed(() => {
  const labels: Record<PlGroupBy, string> = {
    category: 'Category',
    department: 'Department',
    day: 'Day',
    month: 'Month',
    item: 'Product'
  }
  return labels[plGroupBy.value]
})

function plRowLabel(row: PlSummaryRow): string {
  if (plGroupBy.value === 'month') return formatMonth(row.group_label)
  if (plGroupBy.value === 'day') return formatDate(row.group_label)
  return String(row.group_label ?? '—')
}

const formatMoney = (n: unknown) =>
  `Rs ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function invoiceReturnStatusLabel(status: string): string {
  const s = status?.toLowerCase() ?? ''
  if (s === 'partially_returned') return 'Partially returned'
  if (s === 'returned') return 'Fully returned'
  if (s === 'voided') return 'Voided'
  if (s === 'posted') return 'Posted'
  return status ? status.replace(/_/g, ' ') : 'Posted'
}

function invoiceReturnStatusColor(status: string): 'neutral' | 'warning' | 'success' | 'error' {
  const s = status?.toLowerCase() ?? ''
  if (s === 'returned') return 'success'
  if (s === 'partially_returned') return 'warning'
  if (s === 'voided') return 'error'
  return 'neutral'
}

const loadSaleInvoices = async () => {
  invoicesLoading.value = true
  try {
    const saleList = await request<{ rows: SaleInvoiceRow[]; total: number }>(`/reports/sale-invoices${querySaleInvoices()}`)
    saleInvoices.value = saleList.rows ?? []
    invoiceTotal.value = saleList.total ?? 0
    const maxPage = Math.max(1, Math.ceil(invoiceTotal.value / INVOICE_PAGE_SIZE) || 1)
    if (invoicePage.value > maxPage) {
      invoicePage.value = maxPage
      if (invoiceTotal.value > 0) {
        const retry = await request<{ rows: SaleInvoiceRow[]; total: number }>(`/reports/sale-invoices${querySaleInvoices()}`)
        saleInvoices.value = retry.rows ?? []
        invoiceTotal.value = retry.total ?? 0
      }
    }
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load sale invoices'
  } finally {
    invoicesLoading.value = false
  }
}

const loadPlSummary = async () => {
  plLoading.value = true
  try {
    const data = await request<{ rows: PlSummaryRow[]; totals: PlSummaryTotals }>(`/reports/profit-loss-summary${queryPlSummary()}`)
    plSummary.value = { rows: data.rows ?? [], totals: data.totals ?? null }
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load profit & loss summary'
    plSummary.value = { rows: [], totals: null }
  } finally {
    plLoading.value = false
  }
}

const loadReports = async () => {
  loading.value = true
  errorMessage.value = ''
  invoicePage.value = 1
  try {
    const q = queryStringBase()
    const [sales] = await Promise.all([
      request<Record<string, unknown>>(`/reports/sales-summary${q}`),
      loadPlSummary(),
      loadSaleInvoices()
    ])
    salesSummary.value = sales
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load reports'
  } finally {
    loading.value = false
  }
}

const setInvoicePage = async (page: number) => {
  const next = Math.min(Math.max(1, page), invoicePageCount.value)
  if (next === invoicePage.value) return
  invoicePage.value = next
  await loadSaleInvoices()
}

const onPlGroupByChange = async () => {
  await loadPlSummary()
}

const openManual = async () => {
  if (!manualForm.lines.length) {
    manualForm.lines = [{ productId: PICK_PRODUCT, qty: 1 }]
  }
  manualOpen.value = true
}

const closeManual = () => {
  manualOpen.value = false
}

const addManualLine = () => {
  manualForm.lines.push({ productId: '', qty: 1 })
}

const removeManualLine = (index: number) => {
  manualForm.lines.splice(index, 1)
  if (!manualForm.lines.length) manualForm.lines.push({ productId: PICK_PRODUCT, qty: 1 })
}

const submitManual = async () => {
  const lines = manualForm.lines
    .map((l) => {
      const productId = resolveProductId(l.productId)
      if (!productId || productId === PICK_PRODUCT) return null
      return {
        productId,
        qty: Number(l.qty) || 0,
        discountType: 'amount' as const,
        discountValue: 0
      }
    })
    .filter((l): l is NonNullable<typeof l> => l !== null)
  if (!lines.length || lines.some((l) => l.qty <= 0)) {
    errorMessage.value = 'Add at least one product with a valid quantity'
    return
  }

  manualSubmitting.value = true
  errorMessage.value = ''
  try {
    const body: Record<string, unknown> = {
      customerName: manualForm.customerName.trim() || undefined,
      taxInclusive: manualForm.taxInclusive,
      lines
    }
    if (manualForm.branchId && manualForm.branchId !== BRANCH_SHIFT) {
      body.branchId = manualForm.branchId
    }
    if (manualForm.payNow) {
      body.recordPayment = { method: manualForm.paymentMethod }
    }

    const res = await request<{ invoice: { id: string; invoice_number: string } }>('/orders/manual-sale', {
      method: 'POST',
      body
    })

    manualOpen.value = false
    manualForm.customerName = ''
    manualForm.taxInclusive = false
    manualForm.branchId = BRANCH_SHIFT
    manualForm.payNow = false
    manualForm.lines = [{ productId: PICK_PRODUCT, qty: 1 }]

    await loadReports()
    if (res.invoice?.id) await printSaleInvoice(res.invoice.id)
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Manual sale failed'
  } finally {
    manualSubmitting.value = false
  }
}

const printSaleInvoice = async (invoiceId: string) => {
  try {
    const data = await request<ReceiptPayload>(`/receipts/${invoiceId}`)
    const h = data.header
    const t = data.totals
    const rowsHtml = data.items
      .map(
        (row) => `
      <tr>
        <td>${row.productName}</td>
        <td>${row.qty}</td>
        <td>${formatMoney(row.unitPrice)}</td>
        <td>${formatMoney(row.lineTotal)}</td>
      </tr>
    `
      )
      .join('')
    const payHtml =
      data.payments?.length > 0
        ? `<p class="meta">Payments: ${data.payments.map((p) => `${p.method} ${formatMoney(p.amount)}`).join(', ')}</p>`
        : ''

    const popup = window.open('', '_blank', 'width=900,height=700')
    if (!popup) {
      errorMessage.value = 'Popup blocked. Allow popups to print.'
      return
    }

    const printedAt = new Date().toLocaleString()
    popup.document.write(`
      <!doctype html>
      <html><head><title>Sale ${h.invoiceNumber}</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
        h1, h2, p { margin: 0; }
        .meta { margin-top: 5px; color: #475569; font-size: 13px; }
        table { width: 100%; border-collapse: collapse; margin-top: 18px; }
        th, td { border-bottom: 1px solid #e2e8f0; padding: 10px 6px; text-align: left; font-size: 14px; }
        th { background: #f8fafc; }
        .totals { width: 360px; margin-left: auto; margin-top: 18px; }
        .row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 14px; }
        .grand { font-weight: 700; border-top: 1px solid #cbd5e1; margin-top: 6px; padding-top: 8px; }
        .footer { margin-top: 22px; text-align: center; color: #64748b; font-size: 12px; }
      </style></head>
      <body>
        <h1>Aone POS</h1>
        <p class="meta">Invoice: ${h.invoiceNumber}</p>
        <p class="meta">Printed: ${printedAt}</p>
        <p class="meta">${h.branchName ? `Branch: ${h.branchName}` : ''}</p>
        <p class="meta">Customer: ${h.customerName ?? 'Walk-in'}</p>
        <p class="meta">Cashier: ${h.cashierName ?? '—'}</p>
        <p class="meta">Date: ${new Date(h.createdAt).toLocaleString()}</p>
        ${payHtml}
        <h2 style="margin-top: 16px;">Sale invoice</h2>
        <table>
          <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="totals">
          <div class="row"><span>Subtotal</span><span>${formatMoney(t.subtotal)}</span></div>
          <div class="row"><span>Discount</span><span>- ${formatMoney(t.discountTotal)}</span></div>
          <div class="row"><span>Tax</span><span>${formatMoney(t.taxTotal)}</span></div>
          <div class="row"><span>Status</span><span>${t.paymentStatus} · ${t.invoiceStatus}</span></div>
          <div class="row grand"><span>Total</span><span>${formatMoney(t.totalAmount)}</span></div>
        </div>
        <p class="footer">Aone POS — thank you.</p>
      </body></html>
    `)
    popup.document.close()
    popup.focus()
    popup.print()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Could not load receipt for print'
  }
}

function openSaleReturn(invoiceId: string) {
  void router.push({ path: '/sales-returns', query: { invoiceId } })
}

const plFilterLabel = () => {
  const parts: string[] = []
  if (filters.from) parts.push(`From ${formatDate(filters.from)}`)
  if (filters.to) parts.push(`To ${formatDate(filters.to)}`)
  if (filters.branchId && filters.branchId !== ALL_BRANCH) {
    const b = branches.value.find((x) => x.id === filters.branchId)
    if (b) parts.push(`Branch: ${b.name}`)
  }
  return parts.length ? parts.join(' · ') : 'All dates and branches'
}

const printPlSummary = () => {
  const rows = plSummary.value.rows
  const totals = plSummary.value.totals
  if (!rows.length && !totals) {
    errorMessage.value = 'No profit & loss data to print'
    return
  }

  const groupLabel = plGroupColumnLabel.value
  const viewLabel = plGroupByOptions.find((o) => o.value === plGroupBy.value)?.label ?? plGroupBy.value
  const rowsHtml = rows
    .map(
      (row) => `
      <tr>
        <td>${plRowLabel(row)}</td>
        <td class="num">${row.invoice_count}</td>
        <td class="num">${Number(row.qty_sold).toLocaleString()}</td>
        <td class="num">${formatMoney(row.total_sales)}</td>
        <td class="num">${formatMoney(row.discount)}</td>
        <td class="num">${formatMoney(row.revenue_ex_tax)}</td>
        <td class="num">${formatMoney(row.cogs)}</td>
        <td class="num">${formatMoney(row.gross_profit)}</td>
        <td class="num">${row.margin_percent}%</td>
      </tr>
    `
    )
    .join('')

  const totalsHtml = totals
    ? `
      <tr class="totals-row">
        <td><strong>Total</strong></td>
        <td class="num"><strong>${totals.invoice_count}</strong></td>
        <td class="num"><strong>${Number(totals.qty_sold).toLocaleString()}</strong></td>
        <td class="num"><strong>${formatMoney(totals.total_sales)}</strong></td>
        <td class="num"><strong>${formatMoney(totals.discount)}</strong></td>
        <td class="num"><strong>${formatMoney(totals.revenue_ex_tax)}</strong></td>
        <td class="num"><strong>${formatMoney(totals.cogs)}</strong></td>
        <td class="num"><strong>${formatMoney(totals.gross_profit)}</strong></td>
        <td class="num"><strong>${totals.margin_percent}%</strong></td>
      </tr>
    `
    : ''

  const popup = window.open('', '_blank', 'width=960,height=720')
  if (!popup) {
    errorMessage.value = 'Popup blocked. Allow popups to print.'
    return
  }

  const printedAt = new Date().toLocaleString()
  popup.document.write(`
    <!doctype html>
    <html><head><title>Profit &amp; Loss — ${viewLabel}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
      h1, p { margin: 0; }
      .meta { margin-top: 6px; color: #475569; font-size: 13px; }
      table { width: 100%; border-collapse: collapse; margin-top: 18px; }
      th, td { border-bottom: 1px solid #e2e8f0; padding: 8px 6px; text-align: left; font-size: 13px; }
      th { background: #f8fafc; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .totals-row td { border-top: 2px solid #cbd5e1; padding-top: 10px; }
      .footer { margin-top: 22px; text-align: center; color: #64748b; font-size: 12px; }
    </style></head>
    <body>
      <h1>Aone POS — Profit &amp; Loss</h1>
      <p class="meta">View: ${viewLabel}</p>
      <p class="meta">${plFilterLabel()}</p>
      <p class="meta">Printed: ${printedAt}</p>
      <table>
        <thead>
          <tr>
            <th>${groupLabel}</th>
            <th class="num">Invoices</th>
            <th class="num">Qty sold</th>
            <th class="num">Total sale value</th>
            <th class="num">Discount</th>
            <th class="num">Revenue (ex tax)</th>
            <th class="num">COGS</th>
            <th class="num">Gross profit</th>
            <th class="num">Margin %</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}${totalsHtml}</tbody>
      </table>
      <p class="footer">Aone POS — internal report.</p>
    </body></html>
  `)
  popup.document.close()
  popup.focus()
  popup.print()
}

const branchSelectItems = () => [
  { label: 'All branches', value: ALL_BRANCH },
  ...branches.value.map((b) => ({ label: b.name, value: b.id }))
]

const manualBranchItems = () => [
  { label: 'Use open shift / default', value: BRANCH_SHIFT },
  ...branches.value.map((b) => ({ label: b.name, value: b.id }))
]

const paymentFilterItems = [
  { label: 'All statuses', value: ALL_PAY },
  { label: 'Pending', value: 'pending' },
  { label: 'Partial', value: 'partial' },
  { label: 'Paid', value: 'paid' }
]

onMounted(async () => {
  try {
    branches.value = await request<Branch[]>('/branches')
  } catch {
    branches.value = []
  }
  await loadReports()
})
</script>

<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-50">Reports &amp; sales invoices</h1>
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">Summary KPIs, profit &amp; loss by view, paginated invoices, manual sale, and print.</p>
      </div>
      <UButton icon="i-lucide-plus" color="primary" @click="openManual">Manual sale invoice</UButton>
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="soft"
      :description="errorMessage"
      icon="i-lucide-triangle-alert"
    />

    <UCard>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <UiLabeledField label="From" html-for="rpt-from">
          <UInput id="rpt-from" v-model="filters.from" type="date" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="To" html-for="rpt-to">
          <UInput id="rpt-to" v-model="filters.to" type="date" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Branch">
          <UiSearchableSelect v-model="filters.branchId" :items="branchSelectItems()" placeholder="Search branch…" class="min-w-0 w-full" />
        </UiLabeledField>
        <UiLabeledField label="Payment status">
          <UiSearchableSelect v-model="filters.paymentStatus" :items="paymentFilterItems" placeholder="Search payment…" class="min-w-0 w-full" />
        </UiLabeledField>
        <UiLabeledField label="Search" html-for="rpt-search">
          <UInput id="rpt-search" v-model="filters.search" placeholder="Invoice # or customer" class="w-full" />
        </UiLabeledField>
        <UButton icon="i-lucide-search" :loading="loading" class="shrink-0" @click="loadReports">Apply filters</UButton>
      </div>
    </UCard>

    <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <UCard>
        <p class="text-sm text-slate-500">Invoices</p>
        <p class="text-2xl font-semibold">{{ salesSummary.invoices ?? 0 }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-slate-500">Total sales</p>
        <p class="text-2xl font-semibold">{{ formatMoney(salesSummary.total_sales) }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-slate-500">Tax total</p>
        <p class="text-2xl font-semibold">{{ formatMoney(salesSummary.tax_total) }}</p>
      </UCard>
      <UCard>
        <p class="text-sm text-slate-500">Total gross profit</p>
        <p class="text-2xl font-semibold text-emerald-700 dark:text-emerald-300">{{ formatMoney(salesSummary.total_profit) }}</p>
      </UCard>
    </div>

    <UCard>
      <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Sale invoices</h2>
      <div class="table-scroll">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th class="px-3 py-2 font-medium">Invoice</th>
              <th class="px-3 py-2 font-medium">Date</th>
              <th class="px-3 py-2 font-medium">Return status</th>
              <th class="px-3 py-2 font-medium">Branch</th>
              <th class="px-3 py-2 font-medium">Cashier</th>
              <th class="px-3 py-2 text-right font-medium">Total</th>
              <th class="px-3 py-2 text-right font-medium">Profit</th>
              <th class="px-3 py-2 font-medium">Pay</th>
              <th class="px-3 py-2 font-medium w-40" />
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading || invoicesLoading">
              <td colspan="9" class="px-3 py-8 text-center text-slate-500">Loading…</td>
            </tr>
            <template v-else>
              <tr v-for="row in saleInvoices" :key="row.id" class="border-b border-slate-100 dark:border-slate-800">
                <td class="px-3 py-2 font-mono text-xs">{{ row.invoice_number }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ formatDateTime(row.created_at) }}</td>
                <td class="px-3 py-2">
                  <UBadge variant="soft" :color="invoiceReturnStatusColor(row.invoice_status)">
                    {{ invoiceReturnStatusLabel(row.invoice_status) }}
                  </UBadge>
                </td>
                <td class="px-3 py-2">{{ row.branch_name ?? '—' }}</td>
                <td class="px-3 py-2">{{ row.cashier_name ?? '—' }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(row.total_amount) }}</td>
                <td class="px-3 py-2 text-right font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                  {{ formatMoney(row.gross_profit) }}
                </td>
                <td class="px-3 py-2">
                  <UBadge variant="soft" color="neutral">{{ row.payment_status }}</UBadge>
                </td>
                <td class="px-3 py-2">
                  <div class="flex flex-wrap gap-1">
                    <UButton size="xs" variant="soft" icon="i-lucide-printer" @click="printSaleInvoice(row.id)">
                      Print
                    </UButton>
                    <UButton
                      v-if="canReturnSale() && row.invoice_status !== 'voided' && row.invoice_status !== 'returned'"
                      size="xs"
                      variant="soft"
                      color="warning"
                      icon="i-lucide-undo-2"
                      @click="openSaleReturn(row.id)"
                    >
                      Return
                    </UButton>
                  </div>
                </td>
              </tr>
              <tr v-if="!saleInvoices.length">
                <td colspan="9" class="px-3 py-8 text-center text-slate-500">No invoices in this range.</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div
        v-if="invoiceTotal > 0"
        class="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-400"
      >
        <span>Showing {{ invoiceRangeStart }}–{{ invoiceRangeEnd }} of {{ invoiceTotal }}</span>
        <div class="flex items-center gap-2">
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-chevron-left"
            :disabled="invoicePage <= 1 || loading || invoicesLoading"
            @click="setInvoicePage(invoicePage - 1)"
          />
          <span class="tabular-nums">Page {{ invoicePage }} / {{ invoicePageCount }}</span>
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-chevron-right"
            :disabled="invoicePage >= invoicePageCount || loading || invoicesLoading"
            @click="setInvoicePage(invoicePage + 1)"
          />
        </div>
      </div>
    </UCard>

    <UCard>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Profit &amp; loss summary</h2>
        <div class="flex flex-wrap items-center gap-2">
          <UiLabeledField label="View by" class="min-w-[180px]">
            <UiSearchableSelect
              v-model="plGroupBy"
              :items="plGroupByOptions"
              placeholder="Group by…"
              class="min-w-0 w-full"
              @update:model-value="onPlGroupByChange"
            />
          </UiLabeledField>
          <UButton
            size="sm"
            variant="soft"
            icon="i-lucide-printer"
            :disabled="plLoading || !plSummary.rows.length"
            @click="printPlSummary"
          >
            Print summary
          </UButton>
        </div>
      </div>
      <div class="table-scroll">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th class="px-3 py-2 font-medium">{{ plGroupColumnLabel }}</th>
              <th class="px-3 py-2 text-right font-medium">Invoices</th>
              <th class="px-3 py-2 text-right font-medium">Qty sold</th>
              <th class="px-3 py-2 text-right font-medium">Total sale value</th>
              <th class="px-3 py-2 text-right font-medium">Discount</th>
              <th class="px-3 py-2 text-right font-medium">Revenue (ex tax)</th>
              <th class="px-3 py-2 text-right font-medium">COGS</th>
              <th class="px-3 py-2 text-right font-medium">Gross profit</th>
              <th class="px-3 py-2 text-right font-medium">Margin %</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="plLoading">
              <td colspan="9" class="px-3 py-8 text-center text-slate-500">Loading…</td>
            </tr>
            <template v-else>
              <tr
                v-for="row in plSummary.rows"
                :key="row.group_key"
                class="border-b border-slate-100 dark:border-slate-800"
              >
                <td class="px-3 py-2">{{ plRowLabel(row) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ row.invoice_count }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ Number(row.qty_sold).toLocaleString() }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(row.total_sales) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(row.discount) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(row.revenue_ex_tax) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(row.cogs) }}</td>
                <td class="px-3 py-2 text-right font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                  {{ formatMoney(row.gross_profit) }}
                </td>
                <td class="px-3 py-2 text-right tabular-nums">{{ row.margin_percent }}%</td>
              </tr>
              <tr
                v-if="plSummary.totals"
                class="border-t-2 border-slate-200 bg-slate-50 font-semibold dark:border-slate-700 dark:bg-slate-900/60"
              >
                <td class="px-3 py-2">Total</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ plSummary.totals.invoice_count }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ Number(plSummary.totals.qty_sold).toLocaleString() }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(plSummary.totals.total_sales) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(plSummary.totals.discount) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(plSummary.totals.revenue_ex_tax) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(plSummary.totals.cogs) }}</td>
                <td class="px-3 py-2 text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                  {{ formatMoney(plSummary.totals.gross_profit) }}
                </td>
                <td class="px-3 py-2 text-right tabular-nums">{{ plSummary.totals.margin_percent }}%</td>
              </tr>
              <tr v-if="!plSummary.rows.length">
                <td colspan="9" class="px-3 py-4 text-slate-500">No profit &amp; loss data for this range.</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </UCard>

    <Teleport to="body">
      <div
        v-if="manualOpen"
        class="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 p-4 sm:items-center"
        @click.self="closeManual"
      >
        <div
          class="relative z-[101] max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-50">Manual sale invoice</h2>
            <UButton variant="ghost" color="neutral" icon="i-lucide-x" @click="closeManual" />
          </div>
          <p class="mt-1 text-sm text-slate-500">Creates a posted invoice (stock deducted). Admin/manager only.</p>

          <div class="mt-4 space-y-3">
            <UiLabeledField label="Customer name" html-for="manual-customer">
              <UInput id="manual-customer" v-model="manualForm.customerName" class="w-full" />
            </UiLabeledField>
            <UiLabeledField label="Tax-inclusive pricing">
              <input id="taxInc" v-model="manualForm.taxInclusive" type="checkbox" class="rounded border-slate-300" />
            </UiLabeledField>
            <UiLabeledField label="Branch">
              <UiSearchableSelect v-model="manualForm.branchId" :items="manualBranchItems()" placeholder="Search branch…" :ui="manualModalSelectUi" />
            </UiLabeledField>

            <div class="space-y-2">
              <div
                v-for="(line, idx) in manualForm.lines"
                :key="idx"
                class="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700"
              >
                <UiLabeledField label="Product" class="min-w-[200px] flex-1">
                  <UiProductSearchSelect
                    v-model="line.productId"
                    :leading-items="manualProductLeadingItems"
                    placeholder="Search product…"
                    :ui="manualModalSelectUi"
                  />
                </UiLabeledField>
                <UiLabeledField label="Qty" :html-for="`manual-qty-${idx}`">
                  <UInput :id="`manual-qty-${idx}`" v-model.number="line.qty" type="number" min="0.01" step="0.01" class="w-24" />
                </UiLabeledField>
                <UButton v-if="manualForm.lines.length > 1" size="xs" color="error" variant="ghost" icon="i-lucide-trash" @click="removeManualLine(idx)" />
              </div>
              <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="addManualLine">Add line</UButton>
            </div>

            <UiLabeledField label="Record full payment now" class="border-t border-slate-200 pt-3 dark:border-slate-700">
              <input id="payNow" v-model="manualForm.payNow" type="checkbox" class="rounded border-slate-300" />
            </UiLabeledField>
            <UiLabeledField v-if="manualForm.payNow" label="Payment method">
              <UiSearchableSelect
                v-model="manualForm.paymentMethod"
                :ui="manualModalSelectUi"
                :items="[
                  { label: 'Cash', value: 'cash' },
                  { label: 'Card', value: 'card' },
                  { label: 'QR', value: 'qr' },
                  { label: 'Wallet', value: 'wallet' },
                  { label: 'Bank', value: 'bank' }
                ]"
              />
            </UiLabeledField>

            <div class="flex justify-end gap-2 pt-2">
              <UButton variant="soft" color="neutral" @click="closeManual">Cancel</UButton>
              <UButton :loading="manualSubmitting" @click="submitManual">Post invoice</UButton>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
