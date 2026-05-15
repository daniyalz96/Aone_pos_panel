<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'

type Product = {
  id: string
  name: string
  sku: string
  barcode: string | null
  sale_price: number
  category_name: string | null
  image_url?: string | null
  qty_on_hand?: number | string | null
}

type ProductResult = {
  product_id: string
  display_name: string
  sku: string
  sale_price: number
  category: string
  image_url?: string | null
  /** On-hand stock from inventory_balances (same for base product and variants). */
  qty_on_hand: number
}

type Category = {
  id: string
  name: string
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

const { request } = useApi()
const DEFAULT_PRODUCT_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120' viewBox='0 0 120 120'%3E%3Crect width='120' height='120' fill='%23e2e8f0'/%3E%3Cpath d='M30 38h60v44H30z' fill='%2394a3b8'/%3E%3Ccircle cx='50' cy='56' r='7' fill='%23e2e8f0'/%3E%3Cpath d='M38 78l14-12 8 7 11-10 11 15z' fill='%23cbd5e1'/%3E%3C/svg%3E"

const paymentMethods = [
  { label: 'Cash', value: 'cash' },
  { label: 'Card', value: 'card' },
  { label: 'QR', value: 'qr' },
  { label: 'Wallet', value: 'wallet' },
  { label: 'Bank', value: 'bank' }
]

const search = ref('')
const selectedCategory = ref('All')
const categories = ref<string[]>(['All'])
const productCategoryMap = ref<Record<string, string>>({})
const productImageMap = ref<Record<string, string | null>>({})
const productQtyMap = ref<Record<string, number>>({})
const baseProducts = ref<ProductResult[]>([])
const searchResults = ref<ProductResult[]>([])

const orderId = ref<string | null>(null)
const orderStatus = ref<'draft' | 'held' | 'posted'>('draft')
const cart = ref<OrderItem[]>([])
const invoiceId = ref<string | null>(null)
const receiptPayload = ref<Record<string, unknown> | null>(null)

const isLoadingProducts = ref(false)
const isWorking = ref(false)
const errorMessage = ref('')

const isAddModalOpen = ref(false)
const selectedProduct = ref<ProductResult | null>(null)
const addItemForm = reactive({
  qty: 1,
  discountType: 'amount' as 'amount' | 'percent',
  discountValue: 0
})

const paymentForm = reactive({
  method: 'cash',
  amount: 0,
  tenderedAmount: 0
})

const activeProducts = computed(() => {
  const source = search.value.trim().length >= 2 ? searchResults.value : baseProducts.value
  if (selectedCategory.value === 'All') return source
  return source.filter((product) => product.category === selectedCategory.value)
})

const subtotal = computed(() => Number(cart.value.reduce((sum, item) => sum + item.qty * item.unit_price, 0).toFixed(2)))
const discountTotal = computed(() => Number(cart.value.reduce((sum, item) => sum + Number(item.discount_amount ?? 0), 0).toFixed(2)))
const total = computed(() => Number(cart.value.reduce((sum, item) => sum + item.line_total, 0).toFixed(2)))
const tax = computed(() => Number((total.value - (subtotal.value - discountTotal.value)).toFixed(2)))
const canCollect = computed(() => Boolean(invoiceId.value) && paymentForm.amount > 0)

const formatCurrency = (amount: number) => `PKR ${amount.toLocaleString()}`
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

const mapProductRow = (row: {
  product_id: string
  display_name: string
  sku: string
  sale_price: number
  category_name?: string | null
  image_url?: string | null
  qty_on_hand?: unknown
}) => ({
  product_id: row.product_id,
  display_name: row.display_name,
  sku: row.sku,
  sale_price: Number(row.sale_price),
  category: row.category_name ?? productCategoryMap.value[row.product_id] ?? 'Uncategorized',
  image_url: row.image_url ?? productImageMap.value[row.product_id] ?? null,
  qty_on_hand: parseStockQty(row.qty_on_hand, row.product_id)
})

const loadProducts = async () => {
  isLoadingProducts.value = true
  clearError()
  try {
    const products = await request<Product[]>('/products')
    baseProducts.value = products.map((product) => ({
      product_id: product.id,
      display_name: product.name,
      sku: product.sku,
      sale_price: Number(product.sale_price),
      category: product.category_name ?? 'Uncategorized',
      image_url: product.image_url ?? null,
      qty_on_hand: parseStockQty(product.qty_on_hand, product.id)
    }))

    productCategoryMap.value = baseProducts.value.reduce<Record<string, string>>((acc, product) => {
      acc[product.product_id] = product.category
      return acc
    }, {})
    productImageMap.value = baseProducts.value.reduce<Record<string, string | null>>((acc, product) => {
      acc[product.product_id] = product.image_url ?? null
      return acc
    }, {})
    productQtyMap.value = baseProducts.value.reduce<Record<string, number>>((acc, product) => {
      acc[product.product_id] = product.qty_on_hand
      return acc
    }, {})
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load products'
  } finally {
    isLoadingProducts.value = false
  }
}

const loadCategories = async () => {
  try {
    const rows = await request<Category[]>('/products/categories')
    categories.value = ['All', ...rows.map((category) => category.name)]
  } catch {
    const fromProducts = new Set(baseProducts.value.map((product) => product.category))
    categories.value = ['All', ...fromProducts]
  }
}

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
  await loadProducts()
  await loadCategories()
})

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
    paymentForm.amount = Number(invoice.total_amount)
    paymentForm.tenderedAmount = Number(invoice.total_amount)
    orderStatus.value = 'posted'
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to post invoice'
  } finally {
    isWorking.value = false
  }
}

const collectPayment = async () => {
  if (!invoiceId.value) return
  clearError()
  try {
    isWorking.value = true
    await request('/payments/collect', {
      method: 'POST',
      body: {
        invoiceId: invoiceId.value,
        splits: [
          {
            method: paymentForm.method,
            amount: Number(paymentForm.amount),
            tenderedAmount: paymentForm.method === 'cash' ? Number(paymentForm.tenderedAmount) : undefined
          }
        ]
      }
    })
    receiptPayload.value = await request<Record<string, unknown>>(`/receipts/${invoiceId.value}`)
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Payment failed'
  } finally {
    isWorking.value = false
  }
}

const printBill = () => {
  if (cart.value.length === 0) {
    errorMessage.value = 'Cart is empty. Please add items before printing.'
    return
  }

  const receiptNo = invoiceId.value ? `INV-${invoiceId.value.slice(0, 8)}` : `TEMP-${Date.now().toString().slice(-6)}`
  const printedAt = new Date().toLocaleString()
  const rowsHtml = cart.value
    .map((item) => {
      return `
      <tr>
        <td>${item.product_name}</td>
        <td>${item.qty}</td>
        <td>${formatCurrency(item.unit_price)}</td>
        <td>${formatCurrency(item.line_total)}</td>
      </tr>
    `
    })
    .join('')

  const popup = window.open('', '_blank', 'width=900,height=700')
  if (!popup) {
    errorMessage.value = 'Popup blocked. Please allow popups and try again.'
    return
  }

  popup.document.write(`
    <!doctype html>
    <html>
      <head>
        <title>Receipt ${receiptNo}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; color: #0f172a; }
          h1, h2, p { margin: 0; }
          .meta { margin-top: 5px; color: #475569; font-size: 13px; }
          table { width: 100%; border-collapse: collapse; margin-top: 18px; }
          th, td { border-bottom: 1px solid #e2e8f0; padding: 10px 6px; text-align: left; font-size: 14px; }
          th { background: #f8fafc; }
          .totals { width: 340px; margin-left: auto; margin-top: 18px; }
          .row { display: flex; justify-content: space-between; padding: 5px 0; font-size: 14px; }
          .grand { font-weight: 700; border-top: 1px solid #cbd5e1; margin-top: 6px; padding-top: 8px; }
          .footer { margin-top: 22px; text-align: center; color: #64748b; font-size: 12px; }
        </style>
      </head>
      <body>
        <h1>Aone POS</h1>
        <p class="meta">Receipt: ${receiptNo}</p>
        <p class="meta">Printed: ${printedAt}</p>
        <p class="meta">Order: ${orderId.value ?? '-'}</p>
        <p class="meta">Invoice: ${invoiceId.value ?? 'Not posted yet'}</p>

        <h2 style="margin-top: 16px;">Customer Receipt</h2>
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Qty</th>
              <th>Rate</th>
              <th>Amount</th>
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
    </html>
  `)
  popup.document.close()
  popup.focus()
  popup.print()
}

const startNewBill = () => {
  orderId.value = null
  orderStatus.value = 'draft'
  cart.value = []
  invoiceId.value = null
  receiptPayload.value = null
  paymentForm.method = 'cash'
  paymentForm.amount = 0
  paymentForm.tenderedAmount = 0
  search.value = ''
  searchResults.value = []
  selectedCategory.value = 'All'
  clearError()
}
</script>

<template>
  <div class="space-y-6">
    <section class="grid gap-6 xl:grid-cols-3">
      <UCard class="xl:col-span-2">
        <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
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

        <UAlert
          v-if="errorMessage"
          color="error"
          variant="soft"
          :description="errorMessage"
          icon="i-lucide-triangle-alert"
          class="mb-4"
        />

        <UInput
          v-model="search"
          icon="i-lucide-search"
          size="lg"
          placeholder="Search by product name, SKU, or barcode..."
        />

        <div class="mt-4 flex flex-wrap gap-2">
          <UButton
            v-for="category in categories"
            :key="category"
            color="neutral"
            :variant="selectedCategory === category ? 'solid' : 'soft'"
            :icon="category === 'All' ? 'i-lucide-grid-2x2' : 'i-lucide-tag'"
            @click="selectedCategory = category"
          >
            {{ category }}
          </UButton>
        </div>

        <div class="mt-5 grid gap-3 overflow-visible sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          <button
            v-for="product in activeProducts"
            :key="product.product_id"
            type="button"
            class="relative z-0 rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition duration-200 ease-out hover:z-10 hover:-translate-y-1 hover:scale-[1.02] hover:border-emerald-400 hover:shadow-lg hover:shadow-emerald-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900 active:translate-y-0 active:scale-[1.01] dark:border-slate-700 dark:bg-slate-900 dark:hover:border-emerald-500 dark:hover:shadow-emerald-400/10"
            :disabled="isWorking"
            @click="openAddItemModal(product)"
          >
            <div class="mb-3">
              <img
                :src="product.image_url || DEFAULT_PRODUCT_IMAGE"
                alt="Product image"
                class="h-44 w-full rounded-lg object-cover"
              />
            </div>
            <div class="mb-0 flex min-h-[2.75rem] items-start justify-between gap-2">
              <p class="line-clamp-2 flex-1 text-left font-medium text-slate-800 dark:text-slate-100">
                {{ product.display_name }}
              </p>
              <span class="shrink-0 pt-0.5 text-right text-xs tabular-nums text-slate-600 dark:text-slate-300">
                <span class="text-slate-500 dark:text-slate-400">Qty</span>
                <span class="ml-1 font-semibold text-slate-800 dark:text-slate-100">
                  {{ formatStockQty(product.qty_on_hand) }}
                </span>
              </span>
            </div>
            <p class="text-xs text-slate-500">{{ product.sku }}</p>
            <p class="mt-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              {{ formatCurrency(product.sale_price) }}
            </p>
          </button>
        </div>

        <p v-if="isLoadingProducts" class="mt-4 text-sm text-slate-500">Loading products...</p>
        <p v-else-if="activeProducts.length === 0" class="mt-4 text-sm text-slate-500">
          No products found for current search/category.
        </p>
      </UCard>

      <UCard class="h-fit">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Current Cart</h2>
          <UButton color="neutral" variant="ghost" icon="i-lucide-trash-2" :disabled="cart.length === 0 || isWorking" @click="clearCart">
            Clear
          </UButton>
        </div>

        <div v-if="cart.length === 0" class="mt-5 rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-500">
          Your cart is empty. Tap a product to set quantity, discounts, and add to cart.
        </div>

        <div class="mt-4 space-y-3">
          <div v-for="item in cart" :key="item.id" class="rounded-xl bg-slate-100 p-3 dark:bg-slate-800">
            <div class="flex items-center justify-between gap-2">
              <p class="text-sm font-medium text-slate-800 dark:text-slate-100">{{ item.product_name }}</p>
              <div class="flex items-center gap-2">
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

        <div class="mt-5 space-y-2 border-t border-slate-200 pt-4 text-sm dark:border-slate-700">
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

        <div class="mt-5 grid gap-2">
          <UButton block size="lg" icon="i-lucide-file-check-2" :disabled="!cart.length || !!invoiceId || isWorking" @click="postInvoice">
            Post Invoice
          </UButton>

          <div class="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <p class="mb-2 text-sm font-medium">Payment</p>
            <div class="grid gap-2">
              <USelect v-model="paymentForm.method" :items="paymentMethods" />
              <UInput v-model.number="paymentForm.amount" type="number" placeholder="Payment amount" />
              <UInput
                v-if="paymentForm.method === 'cash'"
                v-model.number="paymentForm.tenderedAmount"
                type="number"
                placeholder="Tendered cash"
              />
              <UButton block color="secondary" icon="i-lucide-credit-card" :disabled="!canCollect || isWorking" @click="collectPayment">
                Collect Payment
              </UButton>
            </div>
          </div>

          <UButton block color="neutral" variant="soft" icon="i-lucide-printer" :disabled="isWorking || cart.length === 0" @click="printBill">
            Print Proforma
          </UButton>
        </div>
      </UCard>
    </section>

    <UCard v-if="receiptPayload">
      <h3 class="mb-2 text-base font-semibold">Last Receipt Payload</h3>
      <pre class="overflow-auto rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-800">{{ receiptPayload }}</pre>
    </UCard>

    <div
      v-if="isAddModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="isAddModalOpen = false"
    >
      <div class="w-full max-w-md rounded-xl bg-white p-4 shadow-2xl dark:bg-slate-900">
        <h3 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Add Item</h3>
        <div class="grid gap-3">
          <div class="rounded-lg bg-slate-100 p-3 dark:bg-slate-800">
            <p class="font-medium text-slate-800 dark:text-slate-100">{{ selectedProduct?.display_name ?? '-' }}</p>
            <p class="text-xs text-slate-500">{{ selectedProduct?.sku ?? '-' }}</p>
            <p class="mt-1 text-xs text-slate-600 dark:text-slate-300">
              Available qty: {{ formatStockQty(Number(selectedProduct?.qty_on_hand ?? 0)) }}
            </p>
            <p class="mt-1 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              {{ formatCurrency(Number(selectedProduct?.sale_price ?? 0)) }}
            </p>
          </div>
          <UInput v-model.number="addItemForm.qty" type="number" min="1" step="1" placeholder="Quantity" />
          <USelect
            v-model="addItemForm.discountType"
            :items="[
              { label: 'Discount Amount', value: 'amount' },
              { label: 'Discount Percentage', value: 'percent' }
            ]"
          />
          <UInput
            v-model.number="addItemForm.discountValue"
            type="number"
            min="0"
            :placeholder="addItemForm.discountType === 'percent' ? 'Discount %' : 'Discount amount'"
          />
          <div class="mt-2 flex justify-end gap-2">
            <UButton color="neutral" variant="soft" @click="isAddModalOpen = false">Cancel</UButton>
            <UButton :loading="isWorking" @click="confirmAddItem">Add to Cart</UButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
