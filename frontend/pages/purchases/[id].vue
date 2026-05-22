<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from '#imports'
import { ApiError, useApi } from '~/composables/useApi'
import { formatRs } from '~/composables/useMoneyFormat'
import { useAuth } from '~/composables/useAuth'

type LineRow = {
  id: string
  product_id: string
  product_name?: string
  sku?: string
  product_sale_price?: string | number | null
  unit_sale_price?: string | number | null
  qty: string | number
  unit_cost: string | number
  tax_rate_pct: string | number
  tax_amount: string | number
  line_total: string | number
  qty_returned?: string | number
}

type InvoiceDetail = {
  id: string
  supplier_id: string
  branch_id?: string | null
  invoice_number: string
  reference_number?: string | null
  purchase_date: string
  payment_terms: 'cash' | 'credit' | 'bank_transfer'
  status: string
  subtotal?: string | number
  tax_total?: string | number
  total_amount?: string | number
  notes?: string | null
  supplier_name?: string
  company_name?: string
  lines?: LineRow[]
}

type ProductHit = {
  id: string
  name: string
  sku: string
  cost_price?: string | number | null
  sale_price?: string | number | null
}

type SupplierOpt = { id: string; name: string; company_name?: string }

const route = useRoute()
const { request } = useApi()
const { user } = useAuth()

const invoiceId = computed(() => String(route.params.id ?? ''))

const canManage = () => {
  const u = user.value
  if (!u) return false
  return (u.permissions ?? []).includes('manage_inventory') || (u.roles ?? []).some((r) => ['admin', 'manager'].includes(r))
}

const inv = ref<InvoiceDetail | null>(null)
const branches = ref<Array<{ id: string; name: string; code: string }>>([])
const suppliers = ref<SupplierOpt[]>([])
const searchAllProducts = ref(false)
const errorMessage = ref('')
const saving = ref(false)
const posting = ref(false)

const header = reactive({
  supplierId: '',
  invoiceNumber: '',
  referenceNumber: '',
  purchaseDate: '',
  paymentTerms: 'credit' as 'cash' | 'credit' | 'bank_transfer',
  branchId: '__none__' as string,
  notes: ''
})

type EditableLine = {
  productId: string
  productName: string
  sku: string
  qty: number
  unitCost: number
  salePrice: number
  taxRatePct: number
  _search: string
}

const lines = ref<EditableLine[]>([])
const productHits = ref<Record<number, ProductHit[]>>({})
let searchTimer: ReturnType<typeof setTimeout> | null = null

const invoiceStatus = computed(() => (inv.value?.status ?? '').trim().toLowerCase())

const isDraft = computed(() => invoiceStatus.value === 'draft')
const isPosted = computed(() => invoiceStatus.value === 'posted')

/** Full line editing (qty, cost, sale, tax, product search) — draft or posted (not partial returns / reversed). */
const canEditDocumentLines = computed(
  () => canManage() && !!inv.value && (isDraft.value || isPosted.value)
)

const canEditPostedMeta = computed(() => {
  if (!canManage() || !inv.value) return false
  const s = invoiceStatus.value
  return s === 'posted' || s === 'partially_returned'
})

const lineTotal = (row: EditableLine) => {
  const base = row.qty * row.unitCost
  const tax = row.taxRatePct > 0 ? (base * row.taxRatePct) / 100 : 0
  return Math.round((base + tax) * 100) / 100
}

const grandPreview = computed(() => lines.value.reduce((s, r) => s + lineTotal(r), 0))

const loadBranches = async () => {
  try {
    branches.value = await request<Array<{ id: string; name: string; code: string }>>('/branches')
  } catch {
    branches.value = []
  }
}

const loadSuppliers = async () => {
  try {
    suppliers.value = await request<SupplierOpt[]>('/procurement/suppliers')
  } catch {
    suppliers.value = []
  }
}

const supplierLabel = (s: SupplierOpt) => (s.company_name ? `${s.company_name} (${s.name})` : s.name)

/** Stable numbers for API (UInput can yield NaN / strings). */
const positiveMoney = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''))
  if (!Number.isFinite(n)) return undefined
  const m = Math.round(n * 100) / 100
  if (m <= 0) return undefined
  return m
}

const finiteNonneg = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''))
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.round(n * 100) / 100
}

const finitePositiveQty = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.round(n * 1000) / 1000
}

const loadInvoice = async () => {
  if (!invoiceId.value) return
  errorMessage.value = ''
  try {
    const data = await request<InvoiceDetail>(`/procurement/purchase-invoices/${invoiceId.value}`)
    inv.value = data
    header.supplierId = data.supplier_id
    header.invoiceNumber = data.invoice_number
    header.referenceNumber = data.reference_number ?? ''
    header.purchaseDate = String(data.purchase_date).slice(0, 10)
    header.paymentTerms = data.payment_terms
    header.branchId = data.branch_id ?? '__none__'
    header.notes = data.notes ?? ''
    lines.value = (data.lines ?? []).map((l) => ({
      productId: l.product_id,
      productName: l.product_name ?? '',
      sku: l.sku ?? '',
      qty: Number(l.qty),
      unitCost: Number(l.unit_cost),
      salePrice: Number(l.unit_sale_price ?? l.product_sale_price ?? 0),
      taxRatePct: Number(l.tax_rate_pct ?? 0),
      _search: ''
    }))
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Failed to load invoice'
  }
}

const searchProducts = async (rowIndex: number, q: string) => {
  const t = q.trim()
  if (t.length < 1) {
    productHits.value[rowIndex] = []
    return
  }
  try {
    const sid = searchAllProducts.value ? null : (header.supplierId || inv.value?.supplier_id)
    const supplierQ = sid ? `&supplierId=${encodeURIComponent(sid)}` : ''
    const rows = await request<ProductHit[]>(
      `/products?q=${encodeURIComponent(t)}&limit=20&isActive=true${supplierQ}`
    )
    productHits.value[rowIndex] = rows
  } catch {
    productHits.value[rowIndex] = []
  }
}

const onProductSearchInput = (rowIndex: number, q: string) => {
  const row = lines.value[rowIndex]
  if (row) row._search = q
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void searchProducts(rowIndex, q), 250)
}

const pickProduct = (rowIndex: number, p: ProductHit) => {
  const row = lines.value[rowIndex]
  if (!row) return
  row.productId = p.id
  row.productName = p.name
  row.sku = p.sku
  const cp = Number(p.cost_price ?? 0)
  if (cp > 0) row.unitCost = cp
  row.salePrice = Number(p.sale_price ?? 0)
  productHits.value[rowIndex] = []
  row._search = row.productName
}

const addLine = () => {
  lines.value.push({
    productId: '',
    productName: '',
    sku: '',
    qty: 1,
    unitCost: 0,
    salePrice: 0,
    taxRatePct: 0,
    _search: ''
  })
}

const removeLine = (i: number) => {
  lines.value.splice(i, 1)
}

const buildItemsPayload = () => {
  return lines.value
    .filter((l) => l.productId)
    .map((l) => {
      const sale = positiveMoney(l.salePrice)
      const item: {
        productId: string
        qty: number
        unitCost: number
        taxRatePct: number
        salePrice?: number
      } = {
        productId: l.productId,
        qty: finitePositiveQty(l.qty),
        unitCost: finiteNonneg(l.unitCost, 0),
        taxRatePct: finiteNonneg(l.taxRatePct, 0)
      }
      if (sale !== undefined) item.salePrice = sale
      return item
    })
}

const saveDraft = async () => {
  if (!canManage() || !inv.value || !isDraft.value) return
  saving.value = true
  errorMessage.value = ''
  try {
    await request(`/procurement/purchase-invoices/${invoiceId.value}`, {
      method: 'PATCH',
      body: {
        supplierId: header.supplierId,
        invoiceNumber: header.invoiceNumber.trim(),
        referenceNumber: header.referenceNumber.trim() || undefined,
        purchaseDate: header.purchaseDate,
        paymentTerms: header.paymentTerms,
        branchId: header.branchId && header.branchId !== '__none__' ? header.branchId : undefined,
        notes: header.notes.trim() || undefined,
        items: buildItemsPayload()
      }
    })
    await loadInvoice()
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Save failed'
  } finally {
    saving.value = false
  }
}

const savePostedDetails = async () => {
  if (!canEditPostedMeta.value || !inv.value) return
  saving.value = true
  errorMessage.value = ''
  try {
    const body: {
      invoiceNumber: string
      referenceNumber?: string
      purchaseDate: string
      notes?: string
      items?: ReturnType<typeof buildItemsPayload>
    } = {
      invoiceNumber: header.invoiceNumber.trim(),
      referenceNumber: header.referenceNumber.trim() || undefined,
      purchaseDate: header.purchaseDate,
      notes: header.notes.trim() || undefined
    }
    if (isPosted.value) {
      body.items = buildItemsPayload()
    }
    await request(`/procurement/purchase-invoices/${invoiceId.value}`, {
      method: 'PATCH',
      body
    })
    await loadInvoice()
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Save failed'
  } finally {
    saving.value = false
  }
}

const postInvoice = async () => {
  if (!canManage() || !isDraft.value) return
  await saveDraft()
  posting.value = true
  errorMessage.value = ''
  try {
    await request(`/procurement/purchase-invoices/${invoiceId.value}/post`, { method: 'POST' })
    await loadInvoice()
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Post failed'
  } finally {
    posting.value = false
  }
}

const reverseInvoice = async () => {
  if (!canManage() || isDraft.value || inv.value?.status === 'reversed') return
  errorMessage.value = ''
  try {
    await request(`/procurement/purchase-invoices/${invoiceId.value}/reverse`, {
      method: 'POST',
      body: { reasonCode: 'invoice_error', notes: 'Full reversal from invoice screen' }
    })
    await loadInvoice()
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Reverse failed'
  }
}

watch(invoiceId, () => void loadInvoice())

onMounted(async () => {
  await Promise.all([loadBranches(), loadSuppliers()])
  await loadInvoice()
})
</script>

<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <NuxtLink to="/purchases" class="text-sm text-emerald-600 hover:underline dark:text-emerald-400">← All purchases</NuxtLink>
        <h1 class="mt-2 text-xl font-semibold text-slate-900 dark:text-slate-100">
          Invoice {{ inv?.invoice_number ?? '…' }}
        </h1>
        <p v-if="inv" class="text-sm text-slate-500">
          {{ inv.company_name || inv.supplier_name }} ·
          <UBadge variant="subtle">{{ inv.status }}</UBadge>
        </p>
        <p v-if="inv && canEditDocumentLines" class="text-xs text-slate-500">
          <template v-if="isDraft">
            Line search uses the supplier below; use “Search all products” if needed. Saving updates product cost and sale price (when sale &gt; 0).
          </template>
          <template v-else>
            Posted invoice — line edits update this document and product prices. Stock and ledger totals from the original post are not recalculated; use Reverse if amounts must match accounting exactly.
          </template>
        </p>
      </div>
      <div v-if="inv && canManage()" class="flex flex-wrap gap-2">
        <UButton v-if="isDraft" :loading="saving" variant="soft" icon="i-lucide-save" @click="saveDraft">Save draft</UButton>
        <UButton
          v-if="canEditPostedMeta"
          :loading="saving"
          variant="soft"
          icon="i-lucide-save"
          @click="savePostedDetails"
        >
          Save
        </UButton>
        <UButton
          v-if="isDraft"
          color="primary"
          :loading="posting"
          icon="i-lucide-upload"
          @click="postInvoice"
        >
          Post (stock + GL)
        </UButton>
        <UButton
          v-if="!isDraft && inv.status !== 'reversed'"
          color="warning"
          icon="i-lucide-rotate-ccw"
          @click="reverseInvoice"
        >
          Reverse / void shipment
        </UButton>
      </div>
    </div>

    <UAlert v-if="errorMessage" color="error" variant="soft" :description="errorMessage" icon="i-lucide-triangle-alert" />

    <UCard v-if="inv">
      <div v-if="isDraft && canManage()" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <UiLabeledField label="Supplier" class="sm:col-span-2 lg:col-span-3" required>
          <UiSearchableSelect
            v-model="header.supplierId"
            :items="suppliers.map((s) => ({ label: supplierLabel(s), value: s.id }))"
            placeholder="Search supplier…"
            class="w-full"
          />
        </UiLabeledField>
        <UiLabeledField label="Invoice number" html-for="pd-inv-num">
          <UInput id="pd-inv-num" v-model="header.invoiceNumber" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Reference" html-for="pd-ref">
          <UInput id="pd-ref" v-model="header.referenceNumber" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Purchase date" html-for="pd-date">
          <UInput id="pd-date" v-model="header.purchaseDate" type="date" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Payment terms">
          <UiSearchableSelect
            v-model="header.paymentTerms"
            :items="[
              { label: 'Credit (AP)', value: 'credit' },
              { label: 'Cash', value: 'cash' },
              { label: 'Bank transfer', value: 'bank_transfer' }
            ]"
            placeholder="Search payment terms…"
          />
        </UiLabeledField>
        <UiLabeledField label="Branch">
          <UiSearchableSelect
            v-model="header.branchId"
            :items="[
              { label: 'Global inventory (no branch)', value: '__none__' },
              ...branches.map((b) => ({ label: b.name, value: b.id }))
            ]"
            placeholder="Search branch…"
          />
        </UiLabeledField>
        <UiLabeledField label="Notes" html-for="pd-notes" class="sm:col-span-2 lg:col-span-3">
          <UInput id="pd-notes" v-model="header.notes" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Search all products" class="sm:col-span-2 lg:col-span-3" hint="Ignore supplier catalog filter">
          <UCheckbox v-model="searchAllProducts" />
        </UiLabeledField>
      </div>
      <div v-else-if="canEditPostedMeta" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <p class="text-sm text-slate-600 dark:text-slate-300 sm:col-span-2 lg:col-span-3">
          Posted invoice — edit document fields below. You can also change lines (qty, cost, sale, tax); that updates product catalog prices and this document’s totals, not posted stock or GL entries.
        </p>
        <p class="text-xs text-slate-500 sm:col-span-2 lg:col-span-3">
          {{ inv.company_name || inv.supplier_name }} · {{ inv.payment_terms }} · supplier, branch, and payment terms are fixed.
        </p>
        <UiLabeledField label="Invoice number" html-for="pd-inv-num">
          <UInput id="pd-inv-num" v-model="header.invoiceNumber" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Reference" html-for="pd-ref">
          <UInput id="pd-ref" v-model="header.referenceNumber" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Purchase date" html-for="pd-date">
          <UInput id="pd-date" v-model="header.purchaseDate" type="date" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Notes" html-for="pd-notes" class="sm:col-span-2 lg:col-span-3">
          <UInput id="pd-notes" v-model="header.notes" class="w-full" />
        </UiLabeledField>
        <div
          v-if="canEditDocumentLines && !isDraft"
          class="flex items-center gap-2 sm:col-span-2 lg:col-span-3"
        >
          <UCheckbox v-model="searchAllProducts" label="Search all products (ignore supplier catalog filter)" />
        </div>
      </div>
      <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        <UiDetailField label="Reference" :value="inv.reference_number || '—'" />
        <UiDetailField label="Date" :value="formatDate(inv.purchase_date)" />
        <UiDetailField label="Terms" :value="inv.payment_terms" />
        <UiDetailField label="Totals">
          {{ Number(inv.subtotal ?? 0).toFixed(2) }} + tax {{ Number(inv.tax_total ?? 0).toFixed(2) }} =
          {{ Number(inv.total_amount ?? 0).toFixed(2) }}
        </UiDetailField>
      </div>

      <div class="table-scroll mt-6">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b text-xs uppercase text-slate-500 dark:text-slate-400">
            <tr>
              <th class="pb-2 pr-2">Item</th>
              <th class="pb-2 pr-2">Qty</th>
              <th class="pb-2 pr-2">Unit cost</th>
              <th class="pb-2 pr-2">Sale price</th>
              <th class="pb-2 pr-2">Tax %</th>
              <th class="pb-2 pr-2 text-right">Line total</th>
              <th v-if="canEditDocumentLines" class="pb-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in lines" :key="i" class="border-b border-slate-100 dark:border-slate-800">
              <td class="py-2 pr-2 align-top">
                <template v-if="canEditDocumentLines">
                  <UInput
                    v-model="row._search"
                    placeholder="Search name or SKU…"
                    class="mb-1"
                    @update:model-value="(v) => onProductSearchInput(i, String(v ?? ''))"
                  />
                  <div v-if="productHits[i]?.length" class="max-h-40 overflow-y-auto rounded border border-slate-200 bg-white dark:border-slate-600 dark:bg-slate-900">
                    <button
                      v-for="p in productHits[i]"
                      :key="p.id"
                      type="button"
                      class="block w-full px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                      @click="pickProduct(i, p)"
                    >
                      {{ p.name }} · {{ p.sku }}
                    </button>
                  </div>
                  <p class="text-xs text-slate-500">Selected: {{ row.productName || '—' }}</p>
                </template>
                <template v-else>
                  <p class="font-medium">{{ row.productName }}</p>
                  <p class="text-xs text-slate-500">{{ row.sku }}</p>
                </template>
              </td>
              <td class="py-2 pr-2 align-top">
                <UInput v-if="canEditDocumentLines" v-model.number="row.qty" type="number" class="w-24" />
                <span v-else>{{ row.qty }}</span>
              </td>
              <td class="py-2 pr-2 align-top">
                <UInput v-if="canEditDocumentLines" v-model.number="row.unitCost" type="number" class="w-28" />
                <span v-else>{{ formatRs(row.unitCost) }}</span>
              </td>
              <td class="py-2 pr-2 align-top">
                <UInput
                  v-if="canEditDocumentLines"
                  v-model.number="row.salePrice"
                  type="number"
                  class="w-28"
                  title="When greater than zero, updates product retail on save"
                />
                <span v-else>{{ formatRs(row.salePrice) }}</span>
              </td>
              <td class="py-2 pr-2 align-top">
                <UInput v-if="canEditDocumentLines" v-model.number="row.taxRatePct" type="number" class="w-20" />
                <span v-else>{{ row.taxRatePct }}%</span>
              </td>
              <td class="py-2 pr-2 text-right align-top font-mono">{{ lineTotal(row).toFixed(2) }}</td>
              <td v-if="canEditDocumentLines" class="py-2 align-top">
                <UButton color="error" variant="ghost" icon="i-lucide-trash-2" size="xs" @click="removeLine(i)" />
              </td>
            </tr>
          </tbody>
        </table>
        <UButton v-if="canEditDocumentLines" class="mt-3" variant="soft" icon="i-lucide-plus" @click="addLine">Add line</UButton>
        <p class="mt-4 text-right text-sm font-semibold">
          <template v-if="canEditDocumentLines">Line preview total: {{ grandPreview.toFixed(2) }}</template>
          <template v-else>Invoice total: {{ Number(inv.total_amount ?? 0).toFixed(2) }}</template>
        </p>
      </div>
    </UCard>
  </section>
</template>
