<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { navigateTo } from '#imports'
import { ApiError, useApi } from '~/composables/useApi'
import { formatRs } from '~/composables/useMoneyFormat'
import { useAuth } from '~/composables/useAuth'

type InvoiceRow = {
  id: string
  supplier_id: string
  invoice_number: string
  reference_number?: string | null
  purchase_date: string
  payment_terms: string
  status: string
  total_amount: string | number
  supplier_name?: string
  company_name?: string
}

type SupplierOpt = { id: string; name: string; company_name?: string }

type CatalogProduct = {
  id: string
  name: string
  sku: string
  cost_price?: string | number | null
  sale_price?: string | number | null
}

type PrefabLine = {
  productId: string
  productName: string
  sku: string
  qty: number
  unitCost: number
  salePrice: number
  taxRatePct: number
}

const { request } = useApi()
const { user } = useAuth()

const canManage = () => {
  const u = user.value
  if (!u) return false
  return (u.permissions ?? []).includes('manage_inventory') || (u.roles ?? []).some((r) => ['admin', 'manager'].includes(r))
}

const invoices = ref<InvoiceRow[]>([])
const suppliers = ref<SupplierOpt[]>([])
const catalogProducts = ref<CatalogProduct[]>([])
const prefabLines = ref<PrefabLine[]>([])
const errorMessage = ref('')
const statusFilter = ref('__all__')

const newForm = ref({
  supplierId: '' as string,
  invoiceNumber: '',
  referenceNumber: '',
  purchaseDate: new Date().toISOString().slice(0, 10),
  paymentTerms: 'credit' as 'cash' | 'credit' | 'bank_transfer'
})

const loadCatalog = async (supplierId: string) => {
  if (!supplierId) {
    catalogProducts.value = []
    return
  }
  try {
    catalogProducts.value = await request<CatalogProduct[]>(
      `/products?supplierId=${encodeURIComponent(supplierId)}&isActive=true&limit=500&sort=name_asc`
    )
  } catch {
    catalogProducts.value = []
  }
}

watch(
  () => newForm.value.supplierId,
  (id) => {
    void loadCatalog(id)
    prefabLines.value = []
  }
)

const load = async () => {
  errorMessage.value = ''
  try {
    const q =
      statusFilter.value && statusFilter.value !== '__all__'
        ? `?status=${encodeURIComponent(statusFilter.value)}&limit=100`
        : '?limit=100'
    const [inv, sup] = await Promise.all([
      request<InvoiceRow[]>(`/procurement/purchase-invoices${q}`),
      request<SupplierOpt[]>('/procurement/suppliers')
    ])
    invoices.value = inv
    suppliers.value = sup
    if (newForm.value.supplierId) await loadCatalog(newForm.value.supplierId)
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Failed to load'
  }
}

const addPrefabFromCatalog = (p: CatalogProduct) => {
  prefabLines.value.push({
    productId: p.id,
    productName: p.name,
    sku: p.sku,
    qty: 1,
    unitCost: Number(p.cost_price ?? 0),
    salePrice: Number(p.sale_price ?? 0),
    taxRatePct: 0
  })
}

const removePrefabLine = (i: number) => {
  prefabLines.value.splice(i, 1)
}

const createDraft = async () => {
  if (!canManage()) return
  if (!newForm.value.supplierId || !newForm.value.invoiceNumber.trim()) {
    errorMessage.value = 'Choose a supplier and enter an invoice number.'
    return
  }
  errorMessage.value = ''
  const items = prefabLines.value
    .filter((l) => l.productId && l.qty > 0)
    .map((l) => {
      const sale = positiveMoney(l.salePrice)
      const row: {
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
      if (sale !== undefined) row.salePrice = sale
      return row
    })
  try {
    const inv = await request<InvoiceRow>('/procurement/purchase-invoices', {
      method: 'POST',
      body: {
        supplierId: newForm.value.supplierId,
        invoiceNumber: newForm.value.invoiceNumber.trim(),
        referenceNumber: newForm.value.referenceNumber.trim() || undefined,
        purchaseDate: newForm.value.purchaseDate,
        paymentTerms: newForm.value.paymentTerms,
        items
      }
    })
    await navigateTo(`/purchases/${inv.id}`)
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Could not create draft'
  }
}

const supplierLabel = (s: SupplierOpt) => (s.company_name ? `${s.company_name} (${s.name})` : s.name)

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

onMounted(load)
</script>

<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Purchase invoices</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Drafts do not touch stock or the ledger until you post. Saving lines updates each product’s cost and optional retail price.</p>
      </div>
      <UButton icon="i-lucide-refresh-cw" variant="soft" @click="load">Refresh</UButton>
    </div>

    <UAlert v-if="errorMessage" color="error" variant="soft" :description="errorMessage" icon="i-lucide-triangle-alert" />

    <UCard v-if="canManage()">
      <h2 class="mb-4 text-lg font-semibold text-slate-900 dark:text-slate-100">New draft invoice</h2>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <UiLabeledField label="Supplier" required>
          <UiSearchableSelect
            v-model="newForm.supplierId"
            :items="suppliers.map((s) => ({ label: supplierLabel(s), value: s.id }))"
            placeholder="Search supplier…"
            class="min-w-0 w-full"
          />
        </UiLabeledField>
        <UiLabeledField label="Invoice number" html-for="pi-inv-num" required>
          <UInput id="pi-inv-num" v-model="newForm.invoiceNumber" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Reference" html-for="pi-ref">
          <UInput id="pi-ref" v-model="newForm.referenceNumber" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Purchase date" html-for="pi-date">
          <UInput id="pi-date" v-model="newForm.purchaseDate" type="date" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Payment terms" class="min-w-0 sm:col-span-2">
          <UiSearchableSelect
            v-model="newForm.paymentTerms"
            :items="[
              { label: 'Credit (AP)', value: 'credit' },
              { label: 'Cash', value: 'cash' },
              { label: 'Bank transfer', value: 'bank_transfer' }
            ]"
            placeholder="Search payment terms…"
            class="min-w-0 w-full"
          />
        </UiLabeledField>
      </div>

      <div v-if="newForm.supplierId" class="mt-6 space-y-3">
        <h3 class="text-sm font-semibold text-slate-800 dark:text-slate-200">Supplier catalog</h3>
        <p class="text-xs text-slate-500 dark:text-slate-400">
          Products linked to this supplier. Use Add to include them on the invoice; set quantity, cost, and sale price before creating the draft.
        </p>
        <div v-if="!catalogProducts.length" class="rounded border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-600">
          No linked products for this supplier. Open Suppliers and assign products or categories to the catalog.
        </div>
        <div v-else class="table-scroll table-scroll-compact table-scroll-bordered">
          <table class="min-w-full text-left text-xs">
            <thead class="sticky top-0 bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <tr>
                <th class="px-2 py-2">Product</th>
                <th class="px-2 py-2">SKU</th>
                <th class="px-2 py-2 text-right">Cost</th>
                <th class="px-2 py-2 text-right">Sale</th>
                <th class="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in catalogProducts" :key="p.id" class="border-t border-slate-100 dark:border-slate-800">
                <td class="px-2 py-1.5">{{ p.name }}</td>
                <td class="px-2 py-1.5 font-mono">{{ p.sku }}</td>
                <td class="px-2 py-1.5 text-right font-mono">{{ formatRs(p.cost_price) }}</td>
                <td class="px-2 py-1.5 text-right font-mono">{{ formatRs(p.sale_price) }}</td>
                <td class="px-2 py-1.5">
                  <UButton size="xs" variant="soft" icon="i-lucide-plus" @click="addPrefabFromCatalog(p)">Add</UButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="prefabLines.length" class="mt-6">
        <h3 class="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">Lines on this draft</h3>
        <div class="table-scroll table-scroll-sm">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b text-xs uppercase text-slate-500 dark:text-slate-400">
            <tr>
              <th class="pb-2 pr-2">Item</th>
              <th class="pb-2 pr-2">Qty</th>
              <th class="pb-2 pr-2">Unit cost</th>
              <th class="pb-2 pr-2">Sale price</th>
              <th class="pb-2 pr-2">Tax %</th>
              <th class="pb-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in prefabLines" :key="`prefab-${i}-${row.productId}`" class="border-b border-slate-100 dark:border-slate-800">
              <td class="py-2 pr-2">
                <p class="font-medium">{{ row.productName }}</p>
                <p class="text-xs text-slate-500">{{ row.sku }}</p>
              </td>
              <td class="py-2 pr-2">
                <UInput v-model.number="row.qty" type="number" class="w-24" />
              </td>
              <td class="py-2 pr-2">
                <UInput v-model.number="row.unitCost" type="number" class="w-28" />
              </td>
              <td class="py-2 pr-2">
                <UInput v-model.number="row.salePrice" type="number" class="w-28" title="Written to the product when the draft is created" />
              </td>
              <td class="py-2 pr-2">
                <UInput v-model.number="row.taxRatePct" type="number" class="w-20" />
              </td>
              <td class="py-2">
                <UButton color="error" variant="ghost" icon="i-lucide-trash-2" size="xs" @click="removePrefabLine(i)" />
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>

      <UButton class="mt-4" icon="i-lucide-file-plus" @click="createDraft">Create draft</UButton>
    </UCard>

    <UCard>
      <div class="mb-4 flex flex-wrap items-center gap-3">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Invoices</h2>
        <UiLabeledField label="Status">
          <UiSearchableSelect
            v-model="statusFilter"
            :items="[
              { label: 'All statuses', value: '__all__' },
              { label: 'Draft', value: 'draft' },
              { label: 'Posted', value: 'posted' },
              { label: 'Partially returned', value: 'partially_returned' },
              { label: 'Reversed', value: 'reversed' }
            ]"
            placeholder="Search status…"
            class="w-56"
            @update:model-value="load"
          />
        </UiLabeledField>
      </div>
      <div class="table-scroll">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-700 dark:text-slate-400">
            <tr>
              <th class="pb-2 pr-4">Date</th>
              <th class="pb-2 pr-4">Supplier</th>
              <th class="pb-2 pr-4">Invoice #</th>
              <th class="pb-2 pr-4">Terms</th>
              <th class="pb-2 pr-4">Status</th>
              <th class="pb-2 pr-4 text-right">Total</th>
              <th class="pb-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="inv in invoices" :key="inv.id" class="border-b border-slate-100 dark:border-slate-800">
              <td class="py-2 pr-4 whitespace-nowrap">{{ formatDate(inv.purchase_date) }}</td>
              <td class="py-2 pr-4">{{ inv.company_name || inv.supplier_name }}</td>
              <td class="py-2 pr-4 font-mono">{{ inv.invoice_number }}</td>
              <td class="py-2 pr-4">{{ inv.payment_terms }}</td>
              <td class="py-2 pr-4">
                <UBadge variant="subtle">{{ inv.status }}</UBadge>
              </td>
              <td class="py-2 pr-4 text-right font-mono">{{ Number(inv.total_amount ?? 0).toFixed(2) }}</td>
              <td class="py-2">
                <NuxtLink
                  v-if="canManage() && inv.status !== 'reversed'"
                  :to="`/purchases/${inv.id}`"
                  class="text-emerald-600 hover:underline dark:text-emerald-400"
                >
                  Edit
                </NuxtLink>
                <NuxtLink v-else :to="`/purchases/${inv.id}`" class="text-slate-600 hover:underline dark:text-slate-300">View</NuxtLink>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!invoices.length" class="py-8 text-center text-slate-500">No invoices.</p>
      </div>
    </UCard>
  </section>
</template>
