<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { clearPosSession, readPosSession, writePosSession } from '~/composables/usePosSession'
import { useTodayOverview } from '~/composables/useTodayOverview'
import { LOW_STOCK_THRESHOLD } from '~/constants/inventory'

type Product = {
  id: string
  name: string
  sku: string
  barcode: string | null
  sale_price: number
  category_id: string | null
  category_name: string | null
  image_url?: string | null
  qty_on_hand?: number | string | null
}

type ProductResult = {
  product_id: string
  display_name: string
  sku: string
  sale_price: number
  category_id: string | null
  category: string
  image_url?: string | null
  /** On-hand stock from inventory_balances (same for base product and variants). */
  qty_on_hand: number
}

type Category = {
  id: string
  name: string
}

type CategoryOption = {
  id: string
  name: string
}

type ProductsPage = {
  items: Product[]
  total: number
}

type OrderItem = {
  id: string
  product_name: string
  qty: number
  unit_price: number
  discount_type?: 'amount' | 'percent'
  discount_amount?: number
  line_total: number
}

type ReceiptPayload = {
  header: {
    invoiceId: string
    invoiceNumber: string
    customerName: string | null
    branchName: string | null
    cashierName: string | null
    createdAt: string
    qrData: string
  }
  totals: {
    subtotal: number
    discountTotal: number
    taxTotal: number
    roundOff: number
    totalAmount: number
    returnTotal: number
    paymentStatus: string
    invoiceStatus: string
  }
  items: Array<{
    productName: string
    qty: number
    unitPrice: number
    discountAmount: number
    taxRate: number
    taxAmount: number
    lineTotal: number
  }>
  payments: Array<{
    id: string
    method: string
    amount: number
    reference: string | null
    status: string
    createdAt: string
  }>
  returns: Array<{
    id: string
    totalAmount: number
    reason: string | null
    refundMethod: string | null
    createdAt: string
  }>
}

const { request } = useApi()
const { refreshTodayOverview } = useTodayOverview()
const DEFAULT_PRODUCT_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%23e2e8f0'/%3E%3Cpath d='M30 38h60v44H30z' fill='%2394a3b8'/%3E%3Ccircle cx='50' cy='56' r='7' fill='%23e2e8f0'/%3E%3Cpath d='M38 78l14-12 8 7 11-10 11 15z' fill='%23cbd5e1'/%3E%3C/svg%3E"

const paymentMethods = [
  { label: 'Cash', value: 'cash' },
  { label: 'Card', value: 'card' },
  { label: 'QR', value: 'qr' },
  { label: 'Wallet', value: 'wallet' },
  { label: 'Bank', value: 'bank' }
]

const ALL_CATEGORIES_ID = '__all__'

const search = ref('')
const selectedCategoryId = ref(ALL_CATEGORIES_ID)
const categories = ref<CategoryOption[]>([{ id: ALL_CATEGORIES_ID, name: 'All' }])
const categoryProducts = ref<ProductResult[] | null>(null)
const productCategoryMap = ref<Record<string, string>>({})
const productCategoryIdMap = ref<Record<string, string | null>>({})
const productImageMap = ref<Record<string, string | null>>({})
const productQtyMap = ref<Record<string, number>>({})
const baseProducts = ref<ProductResult[]>([])
const searchResults = ref<ProductResult[]>([])

const orderId = ref<string | null>(null)
const orderStatus = ref<'draft' | 'held' | 'posted'>('draft')
const cart = ref<OrderItem[]>([])
const invoiceId = ref<string | null>(null)
const postedInvoiceTotal = ref<number | null>(null)
const receiptPayload = ref<ReceiptPayload | null>(null)

const isLoadingProducts = ref(false)
const isWorking = ref(false)
const isCollectingPayment = ref(false)
const errorMessage = ref('')

const SHOW_LAST_RECEIPT_KEY = 'pos-show-last-receipt'
const showLastReceipt = ref(true)

const isAddModalOpen = ref(false)
const selectedProduct = ref<ProductResult | null>(null)
const addItemForm = reactive({
  qty: 1,
  discountType: 'amount' as 'amount' | 'percent',
  discountValue: 0
})

const paymentMethod = ref<'cash' | 'card' | 'qr' | 'wallet' | 'bank'>('cash')
const tenderedAmount = ref(0)

/** Amount due for collection — always invoice/cart total, not user-editable. */
const paymentAmountDue = computed(() => {
  if (postedInvoiceTotal.value != null) return postedInvoiceTotal.value
  return total.value
})

/** Reset tendered when cart/invoice total changes — cashier enters cash manually. */
function resetTenderedAmount() {
  if (paymentMethod.value === 'cash') {
    tenderedAmount.value = 0
  }
}

function onTenderedInput(event: Event) {
  const raw = (event.target as HTMLInputElement).value.replace(/,/g, '').trim()
  if (raw === '') {
    tenderedAmount.value = 0
    return
  }
  const n = Number(raw)
  tenderedAmount.value = Number.isFinite(n) ? n : 0
}

function persistPosSession() {
  if (!import.meta.client) return
  if (!orderId.value) {
    clearPosSession()
    return
  }
  writePosSession({
    orderId: orderId.value,
    orderStatus: orderStatus.value,
    invoiceId: invoiceId.value,
    postedInvoiceTotal: postedInvoiceTotal.value,
    paymentMethod: paymentMethod.value,
    paymentAmount: paymentAmountDue.value,
    tenderedAmount: tenderedAmount.value,
    selectedCategoryId: selectedCategoryId.value
  })
}

const activeProducts = computed(() => {
  const searching = search.value.trim().length >= 2
  let source = searching
    ? searchResults.value
    : selectedCategoryId.value !== ALL_CATEGORIES_ID && categoryProducts.value
      ? categoryProducts.value
      : baseProducts.value

  if (selectedCategoryId.value !== ALL_CATEGORIES_ID) {
    source = source.filter((product) => product.category_id === selectedCategoryId.value)
  }
  return source
})

const subtotal = computed(() => Number(cart.value.reduce((sum, item) => sum + item.qty * item.unit_price, 0).toFixed(2)))
const discountTotal = computed(() => Number(cart.value.reduce((sum, item) => sum + Number(item.discount_amount ?? 0), 0).toFixed(2)))
const total = computed(() => Number(cart.value.reduce((sum, item) => sum + item.line_total, 0).toFixed(2)))
const tax = computed(() => Number((total.value - (subtotal.value - discountTotal.value)).toFixed(2)))

const cashChangeDue = computed(() => {
  if (paymentMethod.value !== 'cash') return 0
  const tendered = Number(tenderedAmount.value) || 0
  const pay = paymentAmountDue.value
  return Math.max(0, Number((tendered - pay).toFixed(2)))
})

const cashTenderedShort = computed(() => {
  if (paymentMethod.value !== 'cash') return 0
  const tendered = Number(tenderedAmount.value) || 0
  const pay = paymentAmountDue.value
  return Math.max(0, Number((pay - tendered).toFixed(2)))
})

const canCollect = computed(() => {
  if (!invoiceId.value || paymentAmountDue.value <= 0) return false
  if (paymentMethod.value === 'cash') {
    const tendered = Number(tenderedAmount.value) || 0
    return tendered > 0 && tendered >= paymentAmountDue.value
  }
  return true
})
const showReceiptPanel = computed(() => showLastReceipt.value && receiptPayload.value !== null)

const formatCurrency = (amount: number) => `Rs ${amount.toLocaleString()}`
const formatReceiptDate = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function openPrintWindow(html: string, title: string) {
  const popup = window.open('', '_blank', 'width=900,height=700')
  if (!popup) {
    errorMessage.value = 'Popup blocked. Please allow popups and try again.'
    return false
  }
  popup.document.write(html)
  popup.document.close()
  popup.focus()
  popup.print()
  return true
}
const clearError = () => {
  errorMessage.value = ''
}

const parseStockQty = (raw: unknown, productId: string): number => {
  if (raw !== undefined && raw !== null && raw !== '') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0
  }
  const fromMap = productQtyMap.value[productId]
  return typeof fromMap === 'number' && Number.isFinite(fromMap) ? fromMap : 0
}

const formatStockQty = (qty: number) => {
  if (!Number.isFinite(qty)) return '0'
  const rounded = Math.round(qty * 1000) / 1000
  if (Number.isInteger(rounded)) return String(rounded)
  return rounded.toLocaleString(undefined, { maximumFractionDigits: 3 })
}

const stockQtyClass = (qty: number) => {
  if (qty < 0) return 'text-red-600 dark:text-red-400'
  if (qty === 0) return 'text-red-600 dark:text-red-400'
  if (qty <= LOW_STOCK_THRESHOLD) return 'text-amber-600 dark:text-amber-400'
  return 'text-slate-800 dark:text-slate-100'
}

function mapApiProduct(product: Product): ProductResult {
  return {
    product_id: product.id,
    display_name: product.name,
    sku: product.sku,
    sale_price: Number(product.sale_price),
    category_id: product.category_id ?? null,
    category: product.category_name ?? 'Uncategorized',
    image_url: product.image_url ?? null,
    qty_on_hand: parseStockQty(product.qty_on_hand, product.id)
  }
}

function syncProductLookupMaps(products: ProductResult[]) {
  productCategoryMap.value = products.reduce<Record<string, string>>((acc, product) => {
    acc[product.product_id] = product.category
    return acc
  }, {})
  productCategoryIdMap.value = products.reduce<Record<string, string | null>>((acc, product) => {
    acc[product.product_id] = product.category_id
    return acc
  }, {})
  productImageMap.value = products.reduce<Record<string, string | null>>((acc, product) => {
    acc[product.product_id] = product.image_url ?? null
    return acc
  }, {})
  productQtyMap.value = products.reduce<Record<string, number>>((acc, product) => {
    acc[product.product_id] = product.qty_on_hand
    return acc
  }, {})
}

async function fetchProductsPage(params: URLSearchParams): Promise<ProductsPage> {
  const qs = params.toString()
  const data = await request<ProductsPage | Product[]>(`/products?${qs}`)
  if (Array.isArray(data)) {
    return { items: data, total: data.length }
  }
  return data
}

async function fetchAllActiveProducts(filters?: { categoryId?: string }): Promise<Product[]> {
  const limit = 500
  let offset = 0
  const all: Product[] = []
  let total = 0

  do {
    const params = new URLSearchParams({
      isActive: 'true',
      limit: String(limit),
      offset: String(offset),
      withTotal: 'true',
      sort: 'name_asc'
    })
    if (filters?.categoryId) params.set('categoryId', filters.categoryId)

    const page = await fetchProductsPage(params)
    all.push(...page.items)
    total = page.total
    offset += limit
    if (!page.items.length) break
  } while (all.length < total)

  return all
}

const mapProductRow = (row: {
  product_id: string
  display_name: string
  sku: string
  sale_price: number
  category_id?: string | null
  category_name?: string | null
  image_url?: string | null
  qty_on_hand?: unknown
}) => ({
  product_id: row.product_id,
  display_name: row.display_name,
  sku: row.sku,
  sale_price: Number(row.sale_price),
  category_id: row.category_id ?? productCategoryIdMap.value[row.product_id] ?? null,
  category: row.category_name ?? productCategoryMap.value[row.product_id] ?? 'Uncategorized',
  image_url: row.image_url ?? productImageMap.value[row.product_id] ?? null,
  qty_on_hand: parseStockQty(row.qty_on_hand, row.product_id)
})

const loadProducts = async () => {
  isLoadingProducts.value = true
  clearError()
  try {
    const products = await fetchAllActiveProducts()
    baseProducts.value = products.map(mapApiProduct)
    syncProductLookupMaps(baseProducts.value)
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load products'
  } finally {
    isLoadingProducts.value = false
  }
}

const loadCategoryProducts = async (categoryId: string) => {
  isLoadingProducts.value = true
  clearError()
  try {
    const products = await fetchAllActiveProducts({ categoryId })
    categoryProducts.value = products.map(mapApiProduct)
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load category products'
    categoryProducts.value = []
  } finally {
    isLoadingProducts.value = false
  }
}

const loadCategories = async () => {
  try {
    const rows = await request<Category[]>('/products/categories')
    categories.value = [{ id: ALL_CATEGORIES_ID, name: 'All' }, ...rows.map((category) => ({ id: category.id, name: category.name }))]
  } catch {
    const seen = new Map<string, string>()
    for (const product of baseProducts.value) {
      if (product.category_id && !seen.has(product.category_id)) {
        seen.set(product.category_id, product.category)
      }
    }
    categories.value = [
      { id: ALL_CATEGORIES_ID, name: 'All' },
      ...[...seen.entries()].map(([id, name]) => ({ id, name }))
    ]
  }
}

watch(selectedCategoryId, async (categoryId) => {
  if (categoryId === ALL_CATEGORIES_ID) {
    categoryProducts.value = null
    return
  }
  await loadCategoryProducts(categoryId)
})

const ensureOrder = async () => {
  if (orderId.value) return orderId.value
  const created = await request<{ id: string; status: 'draft' | 'held' | 'posted' }>('/orders', {
    method: 'POST',
    body: { status: 'draft', taxInclusive: false }
  })
  orderId.value = created.id
  orderStatus.value = created.status
  return created.id
}

const refreshOrder = async () => {
  if (!orderId.value) return
  const data = await request<{ order: { status: 'draft' | 'held' | 'posted' }; items: OrderItem[] }>(`/orders/${orderId.value}`)
  orderStatus.value = data.order.status
  cart.value = data.items.map((item) => ({
    ...item,
    qty: Number(item.qty),
    unit_price: Number(item.unit_price),
    discount_amount: Number(item.discount_amount ?? 0),
    line_total: Number(item.line_total)
  }))
}

watch(search, async (value) => {
  clearError()
  if (value.trim().length < 2) {
    searchResults.value = []
    return
  }
  try {
    const rows = await request<Array<{
      product_id: string
      display_name: string
      sku: string
      sale_price: number
      category_id?: string | null
      category_name?: string | null
      image_url?: string | null
      qty_on_hand?: unknown
    }>>(`/products/search/billing?q=${encodeURIComponent(value.trim())}`)
    searchResults.value = rows.map(mapProductRow)
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Search failed'
  }
})

onMounted(async () => {
  if (import.meta.client) {
    const saved = localStorage.getItem(SHOW_LAST_RECEIPT_KEY)
    if (saved !== null) showLastReceipt.value = saved === 'true'
  }
  await loadProducts()
  await loadCategories()
  await restorePosSession()
})

async function restorePosSession() {
  const saved = readPosSession()
  if (!saved?.orderId) return
  try {
    orderId.value = saved.orderId
    orderStatus.value = saved.orderStatus
    invoiceId.value = saved.invoiceId
    postedInvoiceTotal.value = saved.postedInvoiceTotal
    paymentMethod.value = saved.paymentMethod
    selectedCategoryId.value = saved.selectedCategoryId || ALL_CATEGORIES_ID
    await refreshOrder()
    resetTenderedAmount()
  } catch {
    clearPosSession()
    orderId.value = null
    orderStatus.value = 'draft'
    cart.value = []
    invoiceId.value = null
    postedInvoiceTotal.value = null
  }
}

onBeforeUnmount(() => {
  persistPosSession()
})

watch(showLastReceipt, (value) => {
  if (import.meta.client) {
    localStorage.setItem(SHOW_LAST_RECEIPT_KEY, String(value))
  }
})

watch(paymentMethod, (method) => {
  if (method === 'cash') resetTenderedAmount()
  persistPosSession()
})

watch(
  [cart, total, postedInvoiceTotal],
  () => {
    resetTenderedAmount()
    persistPosSession()
  },
  { deep: true }
)

watch([orderId, orderStatus, invoiceId, paymentMethod, selectedCategoryId], () => {
  persistPosSession()
})

watch(tenderedAmount, () => persistPosSession())

const openAddItemModal = (product: ProductResult) => {
  selectedProduct.value = product
  addItemForm.qty = 1
  addItemForm.discountType = 'amount'
  addItemForm.discountValue = 0
  isAddModalOpen.value = true
}

const confirmAddItem = async () => {
  if (!selectedProduct.value) return
  clearError()
  try {
    isWorking.value = true
    const id = await ensureOrder()
    await request(`/orders/${id}/items`, {
      method: 'POST',
      body: {
        productId: selectedProduct.value.product_id,
        qty: Number(addItemForm.qty),
        discountType: addItemForm.discountType,
        discountValue: Number(addItemForm.discountValue)
      }
    })
    isAddModalOpen.value = false
    await refreshOrder()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to add item'
  } finally {
    isWorking.value = false
  }
}

const changeQty = async (item: OrderItem, delta: number) => {
  if (!orderId.value) return
  const nextQty = Number((item.qty + delta).toFixed(3))
  clearError()
  try {
    isWorking.value = true
    if (nextQty <= 0) {
      await request(`/orders/${orderId.value}/items/${item.id}`, { method: 'DELETE' })
    } else {
      await request(`/orders/${orderId.value}/items/${item.id}`, {
        method: 'PATCH',
        body: { qty: nextQty }
      })
    }
    await refreshOrder()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to update quantity'
  } finally {
    isWorking.value = false
  }
}

const removeItem = async (item: OrderItem) => {
  if (!orderId.value) return
  clearError()
  try {
    isWorking.value = true
    await request(`/orders/${orderId.value}/items/${item.id}`, { method: 'DELETE' })
    await refreshOrder()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to remove item'
  } finally {
    isWorking.value = false
  }
}

const clearCart = async () => {
  if (!orderId.value || cart.value.length === 0) return
  clearError()
  try {
    isWorking.value = true
    await Promise.all(cart.value.map((item) => request(`/orders/${orderId.value}/items/${item.id}`, { method: 'DELETE' })))
    await refreshOrder()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to clear cart'
  } finally {
    isWorking.value = false
  }
}

const holdOrder = async () => {
  if (!orderId.value) return
  clearError()
  try {
    await request(`/orders/${orderId.value}/hold`, { method: 'POST' })
    orderStatus.value = 'held'
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to hold order'
  }
}

const postInvoice = async () => {
  if (!orderId.value || cart.value.length === 0) return
  clearError()
  try {
    isWorking.value = true
    const invoice = await request<{ id: string; total_amount: number }>(`/orders/${orderId.value}/post`, {
      method: 'POST',
      body: {}
    })
    invoiceId.value = invoice.id
    postedInvoiceTotal.value = Number(invoice.total_amount)
    tenderedAmount.value = 0
    orderStatus.value = 'posted'
    void refreshTodayOverview()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to post invoice'
  } finally {
    isWorking.value = false
  }
}

const resetForNewBill = () => {
  orderId.value = null
  orderStatus.value = 'draft'
  cart.value = []
  invoiceId.value = null
  postedInvoiceTotal.value = null
  paymentMethod.value = 'cash'
  tenderedAmount.value = 0
  search.value = ''
  searchResults.value = []
  selectedCategoryId.value = ALL_CATEGORIES_ID
  categoryProducts.value = null
  clearPosSession()
  clearError()
  void loadProducts()
}

const collectPayment = async () => {
  if (!invoiceId.value || isCollectingPayment.value || !canCollect.value) return
  const payAmount = paymentAmountDue.value
  if (paymentMethod.value === 'cash' && cashTenderedShort.value > 0) {
    errorMessage.value = `Cash tendered is short by ${formatCurrency(cashTenderedShort.value)}`
    return
  }
  const paidInvoiceId = invoiceId.value
  clearError()
  isCollectingPayment.value = true
  try {
    await request('/payments/collect', {
      method: 'POST',
      body: {
        invoiceId: paidInvoiceId,
        markPendingIfUnderpaid: true,
        splits: [
          {
            method: paymentMethod.value,
            amount: payAmount,
            tenderedAmount: paymentMethod.value === 'cash' ? Number(tenderedAmount.value) : undefined
          }
        ]
      }
    })
    receiptPayload.value = await request<ReceiptPayload>(`/receipts/${paidInvoiceId}`)
    await refreshTodayOverview()
    resetForNewBill()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Payment failed'
  } finally {
    isCollectingPayment.value = false
  }
}

const receiptPrintStyles = `
  body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
  h1, h2, p { margin: 0; }
  .meta { margin-top: 5px; color: #475569; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; }
  th, td { border-bottom: 1px solid #e2e8f0; padding: 10px 6px; text-align: left; font-size: 14px; }
  th { background: #f8fafc; }
  td.num, th.num { text-align: right; }
  .totals { width: 340px; margin-left: auto; margin-top: 18px; }
  .row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 14px; }
  .grand { font-weight: 700; border-top: 1px solid #cbd5e1; margin-top: 6px; padding-top: 8px; }
  .footer { margin-top: 22px; text-align: center; color: #64748b; font-size: 12px; }
`

const printBill = () => {
  if (cart.value.length === 0) {
    errorMessage.value = 'Cart is empty. Please add items before printing.'
    return
  }

  const receiptNo = invoiceId.value ? `INV-${invoiceId.value.slice(0, 8)}` : `TEMP-${Date.now().toString().slice(-6)}`
  const printedAt = new Date().toLocaleString()
  const rowsHtml = cart.value
    .map(
      (item) => `
      <tr>
        <td>${escapeHtml(item.product_name)}</td>
        <td class="num">${item.qty}</td>
        <td class="num">${formatCurrency(item.unit_price)}</td>
        <td class="num">${formatCurrency(item.line_total)}</td>
      </tr>`
    )
    .join('')

  openPrintWindow(
    `<!doctype html>
    <html>
      <head>
        <title>Receipt ${escapeHtml(receiptNo)}</title>
        <style>${receiptPrintStyles}</style>
      </head>
      <body>
        <h1>Aone POS</h1>
        <p class="meta">Receipt: ${escapeHtml(receiptNo)}</p>
        <p class="meta">Printed: ${escapeHtml(printedAt)}</p>
        <p class="meta">Order: ${escapeHtml(orderId.value ?? '-')}</p>
        <p class="meta">Invoice: ${escapeHtml(invoiceId.value ?? 'Not posted yet')}</p>
        <h2 style="margin-top: 16px;">Customer Receipt</h2>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th class="num">Qty</th>
              <th class="num">Rate</th>
              <th class="num">Amount</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div class="totals">
          <div class="row"><span>Subtotal</span><span>${formatCurrency(subtotal.value)}</span></div>
          <div class="row"><span>Discount</span><span>- ${formatCurrency(discountTotal.value)}</span></div>
          <div class="row"><span>Tax</span><span>${formatCurrency(tax.value)}</span></div>
          <div class="row grand"><span>Total</span><span>${formatCurrency(total.value)}</span></div>
        </div>
        <p class="footer">Thank you for shopping with Aone POS.</p>
      </body>
    </html>`,
    receiptNo
  )
}

const printLastReceipt = () => {
  const r = receiptPayload.value
  if (!r) {
    errorMessage.value = 'No receipt to print. Collect payment first.'
    return
  }

  const receiptNo = r.header.invoiceNumber
  const printedAt = new Date().toLocaleString()
  const metaRows = [
    ['Invoice', r.header.invoiceNumber],
    ['Date', formatReceiptDate(r.header.createdAt)],
    ...(r.header.customerName ? [['Customer', r.header.customerName] as const] : []),
    ...(r.header.cashierName ? [['Cashier', r.header.cashierName] as const] : []),
    ...(r.header.branchName ? [['Branch', r.header.branchName] as const] : [])
  ]
    .map(
      ([label, value]) =>
        `<tr><th style="text-align:left;padding:4px 12px 4px 0;color:#64748b;">${escapeHtml(label)}</th><td>${escapeHtml(String(value))}</td></tr>`
    )
    .join('')

  const itemRows = r.items
    .map(
      (line) => `
      <tr>
        <td>${escapeHtml(line.productName)}</td>
        <td class="num">${line.qty}</td>
        <td class="num">${formatCurrency(line.unitPrice)}</td>
        <td class="num">${formatCurrency(line.discountAmount)}</td>
        <td class="num">${formatCurrency(line.taxAmount)}</td>
        <td class="num">${formatCurrency(line.lineTotal)}</td>
      </tr>`
    )
    .join('')

  const paymentRows = r.payments
    .map(
      (pay) => `
      <tr>
        <td>${escapeHtml(pay.status)}</td>
        <td class="num">${escapeHtml(pay.method)}</td>
        <td class="num">${formatCurrency(pay.amount)}</td>
      </tr>`
    )
    .join('')

  const paymentsTable =
    r.payments.length > 0
      ? `
        <h2 style="margin-top: 20px; font-size: 16px;">Payments</h2>
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th class="num">Method</th>
              <th class="num">Amount</th>
            </tr>
          </thead>
          <tbody>${paymentRows}</tbody>
        </table>`
      : ''

  openPrintWindow(
    `<!doctype html>
    <html>
      <head>
        <title>Receipt ${escapeHtml(receiptNo)}</title>
        <style>${receiptPrintStyles}</style>
      </head>
      <body>
        <h1>Aone POS</h1>
        <p class="meta">Printed: ${escapeHtml(printedAt)}</p>
        <table style="margin-top:12px;font-size:13px;">${metaRows}</table>
        <h2 style="margin-top: 16px; font-size: 16px;">Items</h2>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th class="num">Qty</th>
              <th class="num">Rate</th>
              <th class="num">Disc.</th>
              <th class="num">Tax</th>
              <th class="num">Total</th>
            </tr>
          </thead>
          <tbody>${itemRows}</tbody>
        </table>
        ${paymentsTable}
        <div class="totals">
          <div class="row"><span>Subtotal</span><span>${formatCurrency(r.totals.subtotal)}</span></div>
          <div class="row"><span>Discount</span><span>- ${formatCurrency(r.totals.discountTotal)}</span></div>
          <div class="row"><span>Tax</span><span>${formatCurrency(r.totals.taxTotal)}</span></div>
          ${
            r.totals.roundOff
              ? `<div class="row"><span>Round off</span><span>${formatCurrency(r.totals.roundOff)}</span></div>`
              : ''
          }
          <div class="row grand"><span>Grand total</span><span>${formatCurrency(r.totals.totalAmount)}</span></div>
          <div class="row"><span>Payment status</span><span>${escapeHtml(r.totals.paymentStatus)}</span></div>
        </div>
        <p class="footer">Thank you for shopping with Aone POS.</p>
      </body>
    </html>`,
    receiptNo
  )
}


const startNewBill = () => {
  resetForNewBill()
  receiptPayload.value = null
}

function closeLastReceiptPanel() {
  showLastReceipt.value = false
}
</script>

<template>
  <div class="pos-billing-root flex min-h-0 flex-col gap-4 max-xl:min-h-0 xl:flex-1 xl:overflow-hidden">
    <section
      class="grid min-h-0 min-w-0 gap-4 sm:gap-5 max-xl:min-h-0 xl:flex-1 xl:gap-6 xl:overflow-hidden xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]"
    >
      <UCard
        class="pos-billing-card flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
        :ui="{ body: 'flex min-h-0 flex-1 flex-col overflow-hidden' }"
      >
        <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3">
          <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Billing Counter</h2>
          <div class="flex flex-wrap gap-2">
            <UBadge color="neutral" variant="soft">Order: {{ orderStatus }}</UBadge>
            <UButton color="neutral" variant="soft" icon="i-lucide-pause-circle" :disabled="!orderId || isWorking" @click="holdOrder">
              Hold
            </UButton>
            <UButton color="neutral" variant="soft" icon="i-lucide-rotate-ccw" :disabled="isWorking" @click="startNewBill">
              New Bill
            </UButton>
          </div>
        </div>

        <div
          class="sticky top-0 z-10 shrink-0 space-y-3 border-b border-slate-200/80 bg-white/95 pb-3 backdrop-blur-sm dark:border-slate-700/80 dark:bg-slate-900/95"
        >
          <UAlert
            v-if="errorMessage"
            color="error"
            variant="soft"
            :description="errorMessage"
            icon="i-lucide-triangle-alert"
          />

          <UInput
            v-model="search"
            icon="i-lucide-search"
            size="lg"
            placeholder="Search by product name, SKU, or barcode..."
          />

          <div class="pos-category-scroll flex flex-nowrap gap-2 overflow-x-auto pb-1">
            <UButton
              v-for="category in categories"
              :key="category.id"
              class="shrink-0 whitespace-nowrap"
              color="neutral"
              :variant="selectedCategoryId === category.id ? 'solid' : 'soft'"
              :icon="category.id === ALL_CATEGORIES_ID ? 'i-lucide-grid-2x2' : 'i-lucide-tag'"
              @click="selectedCategoryId = category.id"
            >
              {{ category.name }}
            </UButton>
          </div>
        </div>

        <div class="pos-products-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-0.5 pb-6 pt-4">
          <div class="grid gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            <button
              v-for="product in activeProducts"
              :key="product.product_id"
              type="button"
              class="pos-product-card relative w-full min-w-0 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition duration-200 hover:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-emerald-500"
              :disabled="isWorking"
              @click="openAddItemModal(product)"
            >
              <div class="mb-3">
                <img
                  :src="product.image_url || DEFAULT_PRODUCT_IMAGE"
                  alt=""
                  class="h-28 w-full rounded-lg object-cover sm:h-32 lg:h-36"
                />
              </div>
              <UiTruncatedText
                :text="product.display_name"
                :lines="3"
                class="text-left font-medium text-slate-800 dark:text-slate-100"
              />
              <div class="mt-1 flex items-center justify-between gap-2 text-xs">
                <UiTruncatedText
                  :text="product.sku"
                  :lines="1"
                  tag="span"
                  class="min-w-0 flex-1 text-slate-500"
                />
                <span class="shrink-0 tabular-nums text-slate-600 dark:text-slate-300">
                  <span class="text-slate-500 dark:text-slate-400">Qty</span>
                  <span class="ml-1 font-semibold" :class="stockQtyClass(product.qty_on_hand)">
                    {{ formatStockQty(product.qty_on_hand) }}
                  </span>
                </span>
              </div>
              <p class="mt-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
                {{ formatCurrency(product.sale_price) }}
              </p>
            </button>
          </div>

          <p v-if="isLoadingProducts" class="mt-4 text-sm text-slate-500">Loading products...</p>
          <p v-else-if="activeProducts.length === 0" class="mt-4 text-sm text-slate-500">
            No products found for current search/category.
          </p>
        </div>
        </div>
      </UCard>

      <UCard
        class="pos-cart-card flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden"
        :ui="{ body: 'flex h-full min-h-0 flex-1 flex-col overflow-hidden' }"
      >
        <div class="flex shrink-0 items-center justify-between">
          <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Current Cart</h2>
          <UButton color="neutral" variant="ghost" icon="i-lucide-trash-2" :disabled="cart.length === 0 || isWorking" @click="clearCart">
            Clear
          </UButton>
        </div>

        <div class="pos-cart-layout mt-2 flex min-h-0 flex-1 flex-col overflow-hidden pr-1">
          <div class="pos-cart-items-scroll shrink-0 overscroll-contain">
          <div
            v-if="cart.length === 0"
            class="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500"
          >
            Your cart is empty. Tap a product to set quantity, discounts, and add to cart.
          </div>

          <div v-else class="space-y-3">
            <div v-for="item in cart" :key="item.id" class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
              <div class="flex items-center justify-between gap-2">
                <p class="min-w-0 flex-1 text-sm font-medium text-slate-800 dark:text-slate-100">{{ item.product_name }}</p>
                <div class="flex shrink-0 items-center gap-2">
                  <UButton color="error" variant="ghost" size="xs" icon="i-lucide-x" :disabled="isWorking" @click="removeItem(item)" />
                  <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-minus" :disabled="isWorking" @click="changeQty(item, -1)" />
                  <p class="w-6 text-center text-sm text-slate-700 dark:text-slate-100">{{ item.qty }}</p>
                  <UButton color="neutral" variant="soft" size="xs" icon="i-lucide-plus" :disabled="isWorking" @click="changeQty(item, 1)" />
                </div>
              </div>
              <div class="mt-1 flex items-center justify-between text-sm">
                <p class="text-slate-500">{{ formatCurrency(item.unit_price) }} each</p>
                <p class="font-semibold text-slate-700 dark:text-slate-100">{{ formatCurrency(item.line_total) }}</p>
              </div>
              <p v-if="Number(item.discount_amount ?? 0) > 0" class="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
                Discount: {{ formatCurrency(Number(item.discount_amount ?? 0)) }} ({{ item.discount_type }})
              </p>
            </div>
          </div>
          </div>

          <div class="pos-cart-footer-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div class="pos-cart-summary mt-4 space-y-2 border-t border-slate-200 pt-4 text-sm dark:border-slate-700">
            <div class="flex items-center justify-between">
              <span class="text-slate-500">Subtotal</span>
              <span class="font-medium">{{ formatCurrency(subtotal) }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-500">Discount</span>
              <span class="font-medium">- {{ formatCurrency(discountTotal) }}</span>
            </div>
            <div class="flex items-center justify-between">
              <span class="text-slate-500">Tax</span>
              <span class="font-medium">{{ formatCurrency(tax) }}</span>
            </div>
            <div class="flex items-center justify-between text-base font-semibold text-slate-900 dark:text-slate-100">
              <span>Total</span>
              <span>{{ formatCurrency(total) }}</span>
            </div>
          </div>

          <div class="mt-4 grid gap-2 pb-2">
            <UButton block size="lg" icon="i-lucide-file-check-2" :disabled="!cart.length || !!invoiceId || isWorking" @click="postInvoice">
              Post Invoice
            </UButton>

            <div class="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <p class="mb-2 text-sm font-medium">Payment</p>
              <p v-if="!invoiceId" class="mb-2 text-xs text-amber-700 dark:text-amber-300">
                Post the invoice to collect payment. Amounts below follow the cart total.
              </p>
              <p v-else-if="postedInvoiceTotal != null" class="mb-2 text-xs text-slate-500 dark:text-slate-400">
                Invoice total: {{ formatCurrency(postedInvoiceTotal) }}
              </p>
              <div class="grid gap-2">
                <UiLabeledField label="Method">
                  <UiSearchableSelect v-model="paymentMethod" :items="paymentMethods" />
                </UiLabeledField>
                <UiLabeledField label="Payment amount" html-for="pos-pay-amount">
                  <div
                    id="pos-pay-amount"
                    class="w-full rounded-md border border-slate-200 bg-slate-100 px-3 py-2 text-sm font-semibold tabular-nums text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  >
                    {{ formatCurrency(paymentAmountDue) }}
                  </div>
                </UiLabeledField>
                <UiLabeledField v-if="paymentMethod === 'cash'" label="Tendered cash" html-for="pos-pay-tendered">
                  <input
                    id="pos-pay-tendered"
                    :value="tenderedAmount === 0 ? '' : tenderedAmount"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="0"
                    :disabled="isCollectingPayment || isWorking || !invoiceId"
                    class="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-emerald-500/0 transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                    @input="onTenderedInput"
                  />
                  <p
                    v-if="invoiceId"
                    class="mt-1.5 text-xs text-slate-600 dark:text-slate-400"
                  >
                    Payable amount:
                    <span class="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                      {{ formatCurrency(paymentAmountDue) }}
                    </span>
                  </p>
                  <p
                    v-if="invoiceId && Number(tenderedAmount) > 0 && cashTenderedShort > 0"
                    class="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300"
                  >
                    Remaining payable: {{ formatCurrency(cashTenderedShort) }}
                  </p>
                </UiLabeledField>
                <div
                  v-if="paymentMethod === 'cash' && cashChangeDue > 0"
                  class="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 dark:border-emerald-800 dark:bg-emerald-950/40"
                >
                  <p class="text-xs font-medium text-emerald-800 dark:text-emerald-300">Change to return</p>
                  <p class="text-lg font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {{ formatCurrency(cashChangeDue) }}
                  </p>
                </div>
                <p
                  v-else-if="paymentMethod === 'cash' && cashTenderedShort > 0"
                  class="text-xs font-medium text-red-600 dark:text-red-400"
                >
                  Cash tendered is short by {{ formatCurrency(cashTenderedShort) }}
                </p>
                <UButton
                  block
                  color="secondary"
                  icon="i-lucide-credit-card"
                  :loading="isCollectingPayment"
                  :disabled="!canCollect || isCollectingPayment || isWorking"
                  @click="collectPayment"
                >
                  Collect Payment
                </UButton>
                <div class="rounded-md bg-slate-50 px-2 py-2 dark:bg-slate-800/80">
                  <UCheckbox v-model="showLastReceipt" label="Show last receipt after payment" />
                </div>
                <UButton
                  block
                  color="neutral"
                  variant="soft"
                  icon="i-lucide-printer"
                  :disabled="!receiptPayload"
                  @click="printLastReceipt"
                >
                  Print last receipt
                </UButton>
              </div>
            </div>

            <UButton block color="neutral" variant="soft" icon="i-lucide-printer" :disabled="isWorking || cart.length === 0" @click="printBill">
              Print Proforma
            </UButton>
          </div>
          </div>
        </div>
      </UCard>
    </section>

    <UCard
      v-if="showReceiptPanel"
      class="pos-last-receipt flex max-h-[min(42vh,22rem)] shrink-0 flex-col overflow-hidden"
      :ui="{ body: 'flex min-h-0 flex-1 flex-col overflow-hidden gap-0' }"
    >
      <div class="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2 dark:border-slate-700">
        <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">Last Receipt</h3>
        <div class="flex items-center gap-1">
          <UButton size="sm" color="neutral" variant="soft" icon="i-lucide-printer" @click="printLastReceipt">
            Print
          </UButton>
          <UButton
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            aria-label="Close last receipt"
            @click="closeLastReceiptPanel"
          />
        </div>
      </div>
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1">
        <table class="w-full text-left text-xs text-slate-600 dark:text-slate-300">
          <tbody>
            <tr class="border-b border-slate-100 dark:border-slate-800">
              <th class="py-1.5 pr-3 font-medium text-slate-500">Invoice</th>
              <td class="py-1.5 font-mono">{{ receiptPayload.header.invoiceNumber }}</td>
            </tr>
            <tr class="border-b border-slate-100 dark:border-slate-800">
              <th class="py-1.5 pr-3 font-medium text-slate-500">Date</th>
              <td class="py-1.5">{{ formatReceiptDate(receiptPayload.header.createdAt) }}</td>
            </tr>
            <tr v-if="receiptPayload.header.customerName" class="border-b border-slate-100 dark:border-slate-800">
              <th class="py-1.5 pr-3 font-medium text-slate-500">Customer</th>
              <td class="py-1.5">{{ receiptPayload.header.customerName }}</td>
            </tr>
            <tr v-if="receiptPayload.header.cashierName" class="border-b border-slate-100 dark:border-slate-800">
              <th class="py-1.5 pr-3 font-medium text-slate-500">Cashier</th>
              <td class="py-1.5">{{ receiptPayload.header.cashierName }}</td>
            </tr>
            <tr v-if="receiptPayload.header.branchName">
              <th class="py-1.5 pr-3 font-medium text-slate-500">Branch</th>
              <td class="py-1.5">{{ receiptPayload.header.branchName }}</td>
            </tr>
          </tbody>
        </table>

        <div class="table-scroll table-scroll-bordered table-scroll-sm">
          <table class="min-w-full text-left text-xs">
            <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <tr>
                <th class="px-2 py-2 font-medium">Item</th>
                <th class="px-2 py-2 text-right font-medium">Qty</th>
                <th class="px-2 py-2 text-right font-medium">Rate</th>
                <th class="px-2 py-2 text-right font-medium">Disc.</th>
                <th class="px-2 py-2 text-right font-medium">Tax</th>
                <th class="px-2 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(line, idx) in receiptPayload.items"
                :key="`${line.productName}-${idx}`"
                class="border-t border-slate-100 dark:border-slate-800"
              >
                <td class="px-2 py-2 font-medium text-slate-800 dark:text-slate-100">{{ line.productName }}</td>
                <td class="px-2 py-2 text-right tabular-nums">{{ line.qty }}</td>
                <td class="px-2 py-2 text-right tabular-nums">{{ formatCurrency(line.unitPrice) }}</td>
                <td class="px-2 py-2 text-right tabular-nums">{{ formatCurrency(line.discountAmount) }}</td>
                <td class="px-2 py-2 text-right tabular-nums">{{ formatCurrency(line.taxAmount) }}</td>
                <td class="px-2 py-2 text-right font-medium tabular-nums">{{ formatCurrency(line.lineTotal) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <table
          v-if="receiptPayload.payments.length"
          class="w-full text-left text-xs"
        >
          <thead>
            <tr class="text-slate-500">
              <th class="pb-1 font-medium">Payment</th>
              <th class="pb-1 text-right font-medium">Method</th>
              <th class="pb-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pay in receiptPayload.payments" :key="pay.id">
              <td class="py-1 capitalize text-slate-600 dark:text-slate-300">{{ pay.status }}</td>
              <td class="py-1 text-right capitalize">{{ pay.method }}</td>
              <td class="py-1 text-right font-medium tabular-nums">{{ formatCurrency(pay.amount) }}</td>
            </tr>
          </tbody>
        </table>

        <table class="ml-auto w-full max-w-xs text-xs">
          <tbody>
            <tr>
              <td class="py-1 text-slate-500">Subtotal</td>
              <td class="py-1 text-right tabular-nums">{{ formatCurrency(receiptPayload.totals.subtotal) }}</td>
            </tr>
            <tr>
              <td class="py-1 text-slate-500">Discount</td>
              <td class="py-1 text-right tabular-nums">- {{ formatCurrency(receiptPayload.totals.discountTotal) }}</td>
            </tr>
            <tr>
              <td class="py-1 text-slate-500">Tax</td>
              <td class="py-1 text-right tabular-nums">{{ formatCurrency(receiptPayload.totals.taxTotal) }}</td>
            </tr>
            <tr v-if="receiptPayload.totals.roundOff">
              <td class="py-1 text-slate-500">Round off</td>
              <td class="py-1 text-right tabular-nums">{{ formatCurrency(receiptPayload.totals.roundOff) }}</td>
            </tr>
            <tr class="border-t border-slate-200 font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100">
              <td class="py-2">Grand total</td>
              <td class="py-2 text-right tabular-nums">{{ formatCurrency(receiptPayload.totals.totalAmount) }}</td>
            </tr>
            <tr>
              <td class="py-1 text-slate-500">Payment status</td>
              <td class="py-1 text-right capitalize">{{ receiptPayload.totals.paymentStatus }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <div
      v-if="isAddModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="isAddModalOpen = false"
    >
      <div class="w-full max-w-md rounded-xl bg-white p-4 shadow-2xl dark:bg-slate-900">
        <h3 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Add Item</h3>
        <div class="grid gap-3">
          <div class="grid gap-2 rounded-lg bg-slate-100 p-3 dark:bg-slate-800">
            <UiDetailField label="Product">
              <UiTruncatedText
                :text="selectedProduct?.display_name ?? '-'"
                :lines="4"
                class="font-medium text-slate-800 dark:text-slate-100"
              />
            </UiDetailField>
            <UiDetailField label="SKU" :value="selectedProduct?.sku ?? '—'" />
            <UiDetailField label="Available qty">
              <span class="font-semibold" :class="stockQtyClass(Number(selectedProduct?.qty_on_hand ?? 0))">
                {{ formatStockQty(Number(selectedProduct?.qty_on_hand ?? 0)) }}
              </span>
              <span v-if="Number(selectedProduct?.qty_on_hand ?? 0) <= 0" class="text-amber-600 dark:text-amber-400">
                (sale allowed; stock may go negative)
              </span>
              <span
                v-else-if="Number(selectedProduct?.qty_on_hand ?? 0) <= LOW_STOCK_THRESHOLD"
                class="text-amber-600 dark:text-amber-400"
              >
                (low stock — {{ LOW_STOCK_THRESHOLD }} or fewer left)
              </span>
            </UiDetailField>
            <UiDetailField label="Unit price" :value="formatCurrency(Number(selectedProduct?.sale_price ?? 0))" />
          </div>
          <UiLabeledField label="Quantity" html-for="pos-add-qty">
            <UInput id="pos-add-qty" v-model.number="addItemForm.qty" type="number" min="1" step="1" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Discount type">
            <UiSearchableSelect
              v-model="addItemForm.discountType"
              :items="[
                { label: 'Discount Amount', value: 'amount' },
                { label: 'Discount Percentage', value: 'percent' }
              ]"
            />
          </UiLabeledField>
          <UiLabeledField :label="addItemForm.discountType === 'percent' ? 'Discount %' : 'Discount amount'" html-for="pos-add-discount">
            <UInput id="pos-add-discount" v-model.number="addItemForm.discountValue" type="number" min="0" class="w-full" />
          </UiLabeledField>
          <div class="mt-2 flex justify-end gap-2">
            <UButton color="neutral" variant="soft" @click="isAddModalOpen = false">Cancel</UButton>
            <UButton :loading="isWorking" @click="confirmAddItem">Add to Cart</UButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pos-billing-card {
  min-height: 0;
}

.pos-billing-card :deep(> div) {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}

.pos-billing-card :deep([class*='body']) {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
  flex-direction: column;
  overflow: hidden;
}

.pos-category-scroll {
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: rgb(148 163 184 / 0.6) transparent;
}

.pos-category-scroll::-webkit-scrollbar {
  height: 6px;
}

.pos-category-scroll::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background: rgb(148 163 184 / 0.55);
}

.pos-category-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.pos-products-scroll {
  overflow-x: hidden;
}

.pos-product-card:not(:disabled) {
  transition:
    transform 0.2s ease,
    box-shadow 0.2s ease,
    border-color 0.2s ease,
    background-color 0.2s ease;
}

.pos-product-card:not(:disabled):hover {
  transform: translateY(-4px);
  border-color: rgb(52 211 153);
  background-color: rgb(236 253 245);
  box-shadow:
    0 12px 28px -8px rgb(16 185 129 / 0.22),
    0 4px 12px -4px rgb(15 23 42 / 0.1);
}

.dark .pos-product-card:not(:disabled):hover {
  border-color: rgb(16 185 129);
  background-color: rgb(6 78 59 / 0.25);
  box-shadow:
    0 12px 28px -8px rgb(16 185 129 / 0.35),
    0 4px 12px -4px rgb(0 0 0 / 0.35);
}

.pos-product-card:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/* Cart column: fill grid cell; line items scroll when last receipt panel is open */
.pos-billing-root > section {
  align-items: stretch;
}

.pos-cart-card {
  max-height: 100%;
}

@media (max-width: 1279px) {
  .pos-cart-card {
    max-height: min(72dvh, 38rem);
    min-height: 18rem;
  }
}

.pos-cart-card :deep(.u-card-body),
.pos-cart-card :deep([class*='body']) {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.pos-cart-layout {
  min-height: 0;
}

/* Cart line items: show 3 rows, then scroll */
.pos-cart-items-scroll {
  max-height: min(calc(3 * 5.25rem + 0.75rem * 2), 36dvh);
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: rgb(148 163 184 / 0.6) transparent;
}

.pos-cart-items-scroll::-webkit-scrollbar {
  width: 6px;
}

.pos-cart-items-scroll::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background: rgb(148 163 184 / 0.55);
}

/* Totals + payment scroll on short viewports */
.pos-cart-footer-scroll {
  min-height: 0;
  -webkit-overflow-scrolling: touch;
  scrollbar-width: thin;
  scrollbar-color: rgb(148 163 184 / 0.6) transparent;
}

.pos-cart-footer-scroll::-webkit-scrollbar {
  width: 6px;
}

.pos-cart-footer-scroll::-webkit-scrollbar-thumb {
  border-radius: 9999px;
  background: rgb(148 163 184 / 0.55);
}
</style>
