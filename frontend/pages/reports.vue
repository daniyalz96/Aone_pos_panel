<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useApi } from '~/composables/useApi'

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
type ProductRow = { id: string; name: string; sku: string; sale_price: number | string }
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

const { request } = useApi()
const errorMessage = ref('')
const loading = ref(false)
const branches = ref<Branch[]>([])
const products = ref<ProductRow[]>([])

const filters = reactive({
  from: '',
  to: '',
  branchId: ALL_BRANCH,
  paymentStatus: ALL_PAY,
  search: ''
})

const salesSummary = ref<Record<string, unknown>>({})
const taxSlabs = ref<Array<Record<string, unknown>>>([])
const paymentMethods = ref<Array<Record<string, unknown>>>([])
const profitMargin = ref<Array<Record<string, unknown>>>([])
const saleInvoices = ref<SaleInvoiceRow[]>([])

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
  params.set('limit', '100')
  params.set('offset', '0')
  return `?${params.toString()}`
}

const formatMoney = (n: unknown) =>
  `PKR ${Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const loadReports = async () => {
  loading.value = true
  errorMessage.value = ''
  try {
    const q = queryStringBase()
    const qs = querySaleInvoices()
    const [sales, tax, methods, profit, saleList] = await Promise.all([
      request<Record<string, unknown>>(`/reports/sales-summary${q}`),
      request<Array<Record<string, unknown>>>(`/reports/tax-slabs${q}`),
      request<Array<Record<string, unknown>>>(`/reports/payment-methods${q}`),
      request<Array<Record<string, unknown>>>(`/reports/profit-margin${q}`),
      request<{ rows: SaleInvoiceRow[] }>(`/reports/sale-invoices${qs}`)
    ])
    salesSummary.value = sales
    taxSlabs.value = tax
    paymentMethods.value = methods
    profitMargin.value = profit
    saleInvoices.value = saleList.rows ?? []
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load reports'
  } finally {
    loading.value = false
  }
}

const openManual = async () => {
  if (!manualForm.lines.length) {
    manualForm.lines = [{ productId: PICK_PRODUCT, qty: 1 }]
  }
  manualOpen.value = true
  if (!products.value.length) {
    try {
      products.value = await request<ProductRow[]>('/products?isActive=true&limit=500')
    } catch {
      errorMessage.value = 'Could not load products for manual sale'
    }
  }
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

const productItems = () => [
  { label: 'Select product', value: PICK_PRODUCT },
  ...products.value.map((p) => ({
    label: `${p.name} (${p.sku})`,
    value: p.id
  }))
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
        <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">Summary KPIs, filters, invoice list, manual sale, and print.</p>
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
        <UInput v-model="filters.from" type="date" />
        <UInput v-model="filters.to" type="date" />
        <USelect v-model="filters.branchId" :items="branchSelectItems()" placeholder="Branch" class="min-w-0" />
        <USelect v-model="filters.paymentStatus" :items="paymentFilterItems" placeholder="Payment" class="min-w-0" />
        <UInput v-model="filters.search" placeholder="Search invoice # or customer" class="min-w-0" />
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
      <div class="overflow-x-auto">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              <th class="px-3 py-2 font-medium">Invoice</th>
              <th class="px-3 py-2 font-medium">Date</th>
              <th class="px-3 py-2 font-medium">Customer</th>
              <th class="px-3 py-2 font-medium">Branch</th>
              <th class="px-3 py-2 font-medium">Cashier</th>
              <th class="px-3 py-2 text-right font-medium">Total</th>
              <th class="px-3 py-2 text-right font-medium">Profit</th>
              <th class="px-3 py-2 font-medium">Pay</th>
              <th class="px-3 py-2 font-medium w-28" />
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="9" class="px-3 py-8 text-center text-slate-500">Loading…</td>
            </tr>
            <template v-else>
              <tr v-for="row in saleInvoices" :key="row.id" class="border-b border-slate-100 dark:border-slate-800">
                <td class="px-3 py-2 font-mono text-xs">{{ row.invoice_number }}</td>
                <td class="px-3 py-2 whitespace-nowrap">{{ new Date(row.created_at).toLocaleString() }}</td>
                <td class="max-w-[140px] truncate px-3 py-2" :title="row.customer_name ?? ''">{{ row.customer_name ?? '—' }}</td>
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
                  <UButton size="xs" variant="soft" icon="i-lucide-printer" @click="printSaleInvoice(row.id)">Print</UButton>
                </td>
              </tr>
              <tr v-if="!saleInvoices.length">
                <td colspan="9" class="px-3 py-8 text-center text-slate-500">No invoices in this range.</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </UCard>

    <div class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Tax slabs</h2>
        <div class="space-y-2 text-sm">
          <div v-for="slab in taxSlabs" :key="String(slab.tax_rate)" class="rounded-lg bg-slate-100 p-3 dark:bg-slate-800">
            <p class="font-medium">Tax {{ slab.tax_rate }}%</p>
            <p>Taxable: {{ formatMoney(slab.taxable_value) }}</p>
            <p>Tax: {{ formatMoney(slab.tax_value) }}</p>
          </div>
          <p v-if="!taxSlabs.length" class="text-slate-500">No tax data.</p>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Payment methods</h2>
        <div class="space-y-2 text-sm">
          <div v-for="method in paymentMethods" :key="String(method.method)" class="rounded-lg bg-slate-100 p-3 dark:bg-slate-800">
            <p class="font-medium">{{ method.method }}</p>
            <p>Count: {{ method.count }}</p>
            <p>Total: {{ formatMoney(method.total_amount) }}</p>
          </div>
          <p v-if="!paymentMethods.length" class="text-slate-500">No payment data.</p>
        </div>
      </UCard>
    </div>

    <UCard>
      <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Profit margin by month</h2>
      <div class="overflow-auto">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th class="px-3 py-2">Month</th>
              <th class="px-3 py-2">Revenue ex tax</th>
              <th class="px-3 py-2">COGS</th>
              <th class="px-3 py-2">Gross profit</th>
              <th class="px-3 py-2">Margin %</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in profitMargin" :key="String(row.month)" class="border-b border-slate-100 dark:border-slate-800">
              <td class="px-3 py-2">{{ row.month }}</td>
              <td class="px-3 py-2">{{ formatMoney(row.revenue_ex_tax) }}</td>
              <td class="px-3 py-2">{{ formatMoney(row.cogs) }}</td>
              <td class="px-3 py-2">{{ formatMoney(row.gross_profit) }}</td>
              <td class="px-3 py-2">{{ row.margin_percent }}%</td>
            </tr>
            <tr v-if="!profitMargin.length">
              <td colspan="5" class="px-3 py-4 text-slate-500">No margin data.</td>
            </tr>
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
            <UInput v-model="manualForm.customerName" placeholder="Customer name (optional)" />
            <div class="flex items-center gap-2">
              <input id="taxInc" v-model="manualForm.taxInclusive" type="checkbox" class="rounded border-slate-300" />
              <label for="taxInc" class="text-sm text-slate-700 dark:text-slate-300">Tax-inclusive pricing</label>
            </div>
            <USelect v-model="manualForm.branchId" :items="manualBranchItems()" placeholder="Branch" :ui="manualModalSelectUi" />

            <div class="space-y-2">
              <div
                v-for="(line, idx) in manualForm.lines"
                :key="idx"
                class="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-700"
              >
                <div class="min-w-[200px] flex-1">
                  <USelect v-model="line.productId" :items="productItems()" placeholder="Product" :ui="manualModalSelectUi" />
                </div>
                <UInput v-model.number="line.qty" type="number" min="0.01" step="0.01" class="w-24" />
                <UButton v-if="manualForm.lines.length > 1" size="xs" color="error" variant="ghost" icon="i-lucide-trash" @click="removeManualLine(idx)" />
              </div>
              <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="addManualLine">Add line</UButton>
            </div>

            <div class="flex items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
              <input id="payNow" v-model="manualForm.payNow" type="checkbox" class="rounded border-slate-300" />
              <label for="payNow" class="text-sm">Record full payment now</label>
            </div>
            <USelect
              v-if="manualForm.payNow"
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
