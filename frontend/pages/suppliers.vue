<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { ApiError, useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'

type LinkedCategory = { id: string; name: string }
type LinkedProduct = { id: string; name: string; sku: string }

type SupplierRow = {
  id: string
  name: string
  company_name?: string
  contact_person?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
  tax_ntn?: string | null
  opening_balance?: string | number | null
  /** Sum of positive ledger lines (opening + credit purchases). */
  total_balance?: string | number | null
  /** Sum of recorded supplier payments (cash / bank). */
  paid_balance?: string | number | null
  /** Net payable: sum of all ledger lines (same as legacy ledger_balance). */
  current_balance?: string | number | null
  ledger_balance?: string | number | null
  linked_categories?: unknown
  linked_products?: unknown
}

type CatalogCategory = { id: string; name: string }
type CatalogProduct = { id: string; name: string; sku: string }

type LedgerEntry = {
  id: string
  entry_kind: string
  amount: string | number
  memo?: string | null
  created_at: string
  running_balance?: number
}

const { request } = useApi()
const { user } = useAuth()
const toast = useToast()

/** Bump to remount catalog USelectMenu instances after async data (fixes controlled value display). */
const supplierCatalogUiKey = ref(0)
const createCatalogUiKey = ref(0)

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function normalizeUuidStr(id: unknown): string | null {
  const s = String(id ?? '')
    .trim()
    .toLowerCase()
  return UUID_SHAPE_RE.test(s) ? s : null
}

function pickLinkedCategoriesRaw(s: SupplierRow): unknown {
  const r = s as Record<string, unknown>
  return r.linked_categories ?? r.linkedCategories
}

function pickLinkedProductsRaw(s: SupplierRow): unknown {
  const r = s as Record<string, unknown>
  return r.linked_products ?? r.linkedProducts
}

/** USelectMenu (multiple) may emit string ids or full item objects depending on version. */
function normalizeCatalogIdList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of raw) {
    let id: string | null = null
    if (typeof x === 'string') id = normalizeUuidStr(x)
    else if (typeof x === 'number' && Number.isFinite(x)) id = normalizeUuidStr(String(x))
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>
      id = normalizeUuidStr(o.value ?? o.id)
    }
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

const canManage = computed(() => {
  const u = user.value
  if (!u) return false
  return (u.permissions ?? []).includes('manage_inventory') || (u.roles ?? []).some((r) => ['admin', 'manager'].includes(r))
})

const suppliers = ref<SupplierRow[]>([])
const errorMessage = ref('')
const manageOpen = ref(false)
const selectedId = ref<string | null>(null)
const detail = ref<SupplierRow | null>(null)
const ledger = ref<LedgerEntry[]>([])
const loadingDetail = ref(false)

const catalogLoadError = ref('')
const catalogCategories = ref<CatalogCategory[]>([])
const catalogProducts = ref<CatalogProduct[]>([])
const modalCategoryIds = ref<string[]>([])
const modalProductIds = ref<string[]>([])

/** Dropdown panel above supplier modal (`z-50`). */
const supplierSelectContent = { class: 'z-[200]' }

const categorySelectItems = computed(() =>
  catalogCategories.value
    .map((c) => {
      const value = normalizeUuidStr(c.id)
      if (!value) return null
      return { label: c.name, value }
    })
    .filter((x): x is { label: string; value: string } => x !== null)
)

const productSelectItems = computed(() =>
  catalogProducts.value
    .map((p) => {
      const value = normalizeUuidStr(p.id)
      if (!value) return null
      return {
        label: p.sku ? `${p.name} (${p.sku})` : p.name,
        value,
        name: p.name,
        sku: p.sku
      }
    })
    .filter((x): x is { label: string; value: string; name: string; sku: string } => x !== null)
)

const createForm = reactive({
  name: '',
  companyName: '',
  contactPerson: '',
  phone: '',
  email: '',
  address: '',
  taxNtn: '',
  openingBalance: 0,
  catalogCategoryIds: [] as string[],
  catalogProductIds: [] as string[]
})

const editForm = reactive({
  name: '',
  companyName: '',
  contactPerson: '',
  phone: '',
  email: '',
  address: '',
  taxNtn: ''
})

const paymentForm = reactive({
  amount: 0,
  method: 'cash' as 'cash' | 'bank_transfer',
  reference: ''
})

const loadList = async () => {
  errorMessage.value = ''
  try {
    suppliers.value = await request<SupplierRow[]>('/procurement/suppliers')
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Failed to load suppliers'
  }
}

function normalizeJsonArrayField(raw: unknown): unknown[] {
  if (raw == null || raw === '') return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const v = JSON.parse(raw) as unknown
      if (Array.isArray(v)) return v
      if (v && typeof v === 'object') return [v]
      return []
    } catch {
      return []
    }
  }
  if (typeof raw === 'object') return [raw]
  return []
}

function parseLinkedCategories(raw: unknown): LinkedCategory[] {
  return normalizeJsonArrayField(raw)
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x))
    .map((x) => {
      const id = normalizeUuidStr(x.id)
      const name = String(x.name ?? '').trim()
      if (!id) return null
      return { id, name }
    })
    .filter((x): x is LinkedCategory => x !== null)
}

function parseLinkedProducts(raw: unknown): LinkedProduct[] {
  return normalizeJsonArrayField(raw)
    .filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x))
    .map((x) => {
      const id = normalizeUuidStr(x.id)
      if (!id) return null
      const name = String(x.name ?? '').trim()
      const sku = x.sku == null ? '' : String(x.sku)
      return { id, name, sku }
    })
    .filter((x): x is LinkedProduct => x !== null)
}

function parseLinkedCategoriesFromSupplier(s: SupplierRow): LinkedCategory[] {
  return parseLinkedCategories(pickLinkedCategoriesRaw(s))
}

function parseLinkedProductsFromSupplier(s: SupplierRow): LinkedProduct[] {
  return parseLinkedProducts(pickLinkedProductsRaw(s))
}

function linkListTitle(items: { name: string }[]): string {
  if (!items.length) return ''
  return items.map((i) => i.name).join(', ')
}

function linkListPreview(items: { name: string }[], maxNames = 2): string {
  if (!items.length) return '—'
  const head = items.slice(0, maxNames).map((i) => i.name)
  const tail = items.length > maxNames ? ` +${items.length - maxNames}` : ''
  return head.join(', ') + tail
}

function linkProductTitle(items: LinkedProduct[]): string {
  if (!items.length) return ''
  return items.map((i) => (i.sku ? `${i.name} (${i.sku})` : i.name)).join(', ')
}

function linkProductPreview(items: LinkedProduct[], maxNames = 2): string {
  if (!items.length) return '—'
  const head = items.slice(0, maxNames).map((i) => (i.sku ? `${i.name} (${i.sku})` : i.name))
  const tail = items.length > maxNames ? ` +${items.length - maxNames}` : ''
  return head.join(', ') + tail
}

const loadCatalogRefs = async () => {
  try {
    catalogLoadError.value = ''
    const [cats, prods] = await Promise.all([
      request<CatalogCategory[]>('/products/categories'),
      request<Array<{ id: string; name: string; sku?: string | null }>>(
        '/products?limit=500&isActive=true&sort=name_asc'
      )
    ])
    catalogCategories.value = (cats ?? [])
      .map((c) => {
        const id = normalizeUuidStr(c.id)
        if (!id) return null
        return { id, name: c.name }
      })
      .filter((x): x is CatalogCategory => x !== null)
    catalogProducts.value = (prods ?? [])
      .map((p) => {
        const id = normalizeUuidStr(p.id)
        if (!id) return null
        return {
          id,
          name: p.name,
          sku: String(p.sku ?? '')
        }
      })
      .filter((x): x is CatalogProduct => x !== null)
    createCatalogUiKey.value += 1
  } catch (e: unknown) {
    catalogLoadError.value = e instanceof ApiError ? e.message : 'Failed to load categories / products for suppliers'
  }
}

function fillCatalogFromRow(s: SupplierRow) {
  modalCategoryIds.value = parseLinkedCategoriesFromSupplier(s).map((c) => c.id)
  modalProductIds.value = parseLinkedProductsFromSupplier(s).map((p) => p.id)
}

const fillEditFromRow = (s: SupplierRow) => {
  editForm.name = s.name ?? ''
  editForm.companyName = (s.company_name ?? s.name) ?? ''
  editForm.contactPerson = (s.contact_person ?? '') as string
  editForm.phone = (s.phone ?? '') as string
  editForm.email = (s.email ?? '') as string
  editForm.address = (s.address ?? '') as string
  editForm.taxNtn = (s.tax_ntn ?? '') as string
}

const loadDetail = async (id: string) => {
  loadingDetail.value = true
  errorMessage.value = ''
  try {
    const [d, l] = await Promise.all([
      request<SupplierRow>(`/procurement/suppliers/${id}`),
      request<LedgerEntry[]>(`/procurement/suppliers/${id}/ledger`)
    ])
    // Ignore stale responses (e.g. first load finishing after save+close, or switched supplier).
    if (!manageOpen.value || selectedId.value !== id) {
      return
    }
    detail.value = d
    ledger.value = l
    fillEditFromRow(d)
    fillCatalogFromRow(d)
    await nextTick()
    supplierCatalogUiKey.value += 1
  } catch (e: unknown) {
    if (manageOpen.value && selectedId.value === id) {
      errorMessage.value = e instanceof ApiError ? e.message : 'Failed to load supplier'
    }
  } finally {
    loadingDetail.value = false
  }
}

const openManage = async (s: SupplierRow) => {
  selectedId.value = s.id
  fillEditFromRow(s)
  fillCatalogFromRow(s)
  detail.value = { ...s }
  ledger.value = []
  manageOpen.value = true
  await nextTick()
  supplierCatalogUiKey.value += 1
  void loadDetail(s.id)
}

const closeManage = () => {
  manageOpen.value = false
  selectedId.value = null
  detail.value = null
  ledger.value = []
}

const createSupplier = async () => {
  if (!canManage.value) return
  errorMessage.value = ''
  try {
    await request('/procurement/suppliers', {
      method: 'POST',
      body: {
        name: createForm.name.trim(),
        companyName: createForm.companyName.trim() || undefined,
        contactPerson: createForm.contactPerson.trim() || null,
        phone: createForm.phone.trim() || undefined,
        email: createForm.email.trim() || undefined,
        address: createForm.address.trim() || null,
        taxNtn: createForm.taxNtn.trim() || null,
        openingBalance: Number(createForm.openingBalance) || 0,
        categoryIds: normalizeCatalogIdList(createForm.catalogCategoryIds),
        productIds: normalizeCatalogIdList(createForm.catalogProductIds)
      }
    })
    createForm.name = ''
    createForm.companyName = ''
    createForm.contactPerson = ''
    createForm.phone = ''
    createForm.email = ''
    createForm.address = ''
    createForm.taxNtn = ''
    createForm.openingBalance = 0
    createForm.catalogCategoryIds.splice(0, createForm.catalogCategoryIds.length)
    createForm.catalogProductIds.splice(0, createForm.catalogProductIds.length)
    await loadList()
    toast.add({
      title: 'Supplier created',
      description: 'The new supplier was added.',
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Create failed'
  }
}

const saveEdit = async () => {
  if (!canManage.value || !selectedId.value) return
  errorMessage.value = ''
  const id = selectedId.value
  try {
    const categoryIds = normalizeCatalogIdList(modalCategoryIds.value)
    const productIds = normalizeCatalogIdList(modalProductIds.value)
    await request(`/procurement/suppliers/${id}`, {
      method: 'PATCH',
      body: {
        name: editForm.name.trim(),
        companyName: editForm.companyName.trim(),
        contactPerson: editForm.contactPerson.trim() || null,
        phone: editForm.phone.trim() || null,
        email: editForm.email.trim() || null,
        address: editForm.address.trim() || null,
        taxNtn: editForm.taxNtn.trim() || null,
        categoryIds,
        productIds
      }
    })
    await loadList()
    toast.add({
      title: 'Supplier updated',
      description: 'Profile, categories, and products were saved.',
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
    closeManage()
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Save failed'
  }
}

const recordPayment = async () => {
  if (!canManage.value || !selectedId.value) return
  const amt = Number(paymentForm.amount)
  if (!Number.isFinite(amt) || amt <= 0) {
    errorMessage.value = 'Enter a valid payment amount.'
    return
  }
  errorMessage.value = ''
  try {
    await request(`/procurement/suppliers/${selectedId.value}/payments`, {
      method: 'POST',
      body: {
        amount: amt,
        method: paymentForm.method,
        reference: paymentForm.reference.trim() || undefined
      }
    })
    paymentForm.amount = 0
    paymentForm.reference = ''
    await loadList()
    await loadDetail(selectedId.value)
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Payment failed'
  }
}

const fmtMoney = (n: string | number | null | undefined) => {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v)) return 'Rs 0.00'
  return `Rs ${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const refreshSuppliersPage = () => {
  void loadList()
  void loadCatalogRefs()
}

onMounted(async () => {
  await Promise.all([loadList(), loadCatalogRefs()])
})
</script>

<template>
  <section class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Suppliers</h1>
      <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Table view with balances: total accrued on credit (opening + purchases), cash and bank payments, and current net payable.
        Purchase returns reduce the current balance but are not counted in “paid”.
      </p>
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="soft"
      :description="errorMessage"
      icon="i-lucide-triangle-alert"
    />

    <UAlert
      v-if="catalogLoadError"
      color="warning"
      variant="soft"
      :description="catalogLoadError"
      icon="i-lucide-package-x"
    />

    <UCard v-if="canManage">
      <h2 class="mb-4 text-lg font-semibold text-slate-900 dark:text-slate-100">New supplier</h2>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <div class="flex min-w-0 flex-col gap-1.5">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-name">Name</label>
          <UInput id="sup-new-name" v-model="createForm.name" class="w-full" placeholder="Legal / display name *" />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-company">Company name</label>
          <UInput id="sup-new-company" v-model="createForm.companyName" class="w-full" placeholder="Defaults to name if empty" />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-contact">Contact person</label>
          <UInput id="sup-new-contact" v-model="createForm.contactPerson" class="w-full" placeholder="Contact person" />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-phone">Phone</label>
          <UInput id="sup-new-phone" v-model="createForm.phone" class="w-full" placeholder="Phone" />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-email">Email</label>
          <UInput id="sup-new-email" v-model="createForm.email" class="w-full" type="email" placeholder="Email" />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-tax">Tax / NTN</label>
          <UInput id="sup-new-tax" v-model="createForm.taxNtn" class="w-full" placeholder="Tax / NTN" />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-opening">Opening payable</label>
          <UInput id="sup-new-opening" v-model="createForm.openingBalance" class="w-full" type="number" placeholder="0" />
        </div>
        <div class="flex min-w-0 flex-col gap-1.5 sm:col-span-2 lg:col-span-3">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-address">Address</label>
          <UInput id="sup-new-address" v-model="createForm.address" class="w-full" placeholder="Address" />
        </div>
        <div class="flex min-w-0 flex-col gap-2 sm:col-span-2 lg:col-span-3">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-categories">Supplies — categories</label>
          <p class="text-xs text-slate-500">Search and select categories this supplier typically provides.</p>
          <USelectMenu
            id="sup-new-categories"
            :key="'new-cat-' + createCatalogUiKey"
            v-model="createForm.catalogCategoryIds"
            multiple
            value-key="value"
            label-key="label"
            :items="categorySelectItems"
            placeholder="Search categories…"
            class="w-full max-w-xl"
            :disabled="!categorySelectItems.length"
            :reset-search-term-on-select="false"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-2 sm:col-span-2 lg:col-span-3">
          <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-new-products">Supplies — products</label>
          <p class="text-xs text-slate-500">Search by name or SKU; pick multiple products.</p>
          <USelectMenu
            id="sup-new-products"
            :key="'new-prod-' + createCatalogUiKey"
            v-model="createForm.catalogProductIds"
            multiple
            value-key="value"
            label-key="label"
            :items="productSelectItems"
            :filter-fields="['label', 'name', 'sku']"
            placeholder="Search products…"
            class="w-full max-w-xl"
            :disabled="!productSelectItems.length"
            :reset-search-term-on-select="false"
          />
        </div>
      </div>
      <UButton class="mt-4" icon="i-lucide-plus" @click="createSupplier">Create supplier</UButton>
    </UCard>

    <UCard>
      <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">All suppliers</h2>
        <UButton icon="i-lucide-refresh-cw" variant="soft" size="sm" @click="refreshSuppliersPage">Refresh</UButton>
      </div>

      <div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-50 text-xs font-semibold uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th class="px-3 py-3">Company</th>
              <th class="px-3 py-3">Contact</th>
              <th class="px-3 py-3">Phone</th>
              <th class="px-3 py-3 max-w-[11rem]">Categories</th>
              <th class="px-3 py-3 max-w-[14rem]">Products</th>
              <th class="px-3 py-3 text-right">Total balance</th>
              <th class="px-3 py-3 text-right">Paid</th>
              <th class="px-3 py-3 text-right">Current balance</th>
              <th v-if="canManage" class="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="s in suppliers"
              :key="s.id"
              class="border-t border-slate-100 dark:border-slate-800"
            >
              <td class="px-3 py-2">
                <p class="font-medium text-slate-900 dark:text-slate-100">{{ s.company_name ?? s.name }}</p>
                <p class="text-xs text-slate-500">{{ s.name }}</p>
              </td>
              <td class="px-3 py-2 text-slate-600 dark:text-slate-300">{{ s.contact_person || '—' }}</td>
              <td class="px-3 py-2 text-slate-600 dark:text-slate-300">{{ s.phone || '—' }}</td>
              <td
                class="max-w-[11rem] truncate px-3 py-2 text-slate-600 dark:text-slate-300"
                :title="linkListTitle(parseLinkedCategoriesFromSupplier(s))"
              >
                {{ linkListPreview(parseLinkedCategoriesFromSupplier(s)) }}
              </td>
              <td
                class="max-w-[14rem] truncate px-3 py-2 text-slate-600 dark:text-slate-300"
                :title="linkProductTitle(parseLinkedProductsFromSupplier(s))"
              >
                {{ linkProductPreview(parseLinkedProductsFromSupplier(s)) }}
              </td>
              <td class="px-3 py-2 text-right font-mono tabular-nums">{{ fmtMoney(s.total_balance) }}</td>
              <td class="px-3 py-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-200">{{ fmtMoney(s.paid_balance) }}</td>
              <td class="px-3 py-2 text-right font-mono tabular-nums font-medium text-emerald-800 dark:text-emerald-300">
                {{ fmtMoney(s.current_balance ?? s.ledger_balance) }}
              </td>
              <td v-if="canManage" class="px-3 py-2 text-right">
                <UButton icon="i-lucide-pencil" size="sm" variant="soft" @click="openManage(s)">Edit</UButton>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-if="!suppliers.length" class="px-3 py-10 text-center text-slate-500">No suppliers yet.</p>
      </div>
    </UCard>

    <Teleport to="body">
      <div
        v-if="manageOpen && selectedId"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[1px]"
        role="dialog"
        aria-modal="true"
        @click.self="closeManage"
      >
        <div
          class="flex max-h-[min(90vh,900px)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
        >
          <div class="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-700">
            <div>
              <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Edit supplier</h2>
              <div v-if="detail" class="mt-2 grid gap-2 sm:grid-cols-3">
                <UiDetailField label="Total balance" :value="fmtMoney(detail.total_balance)" />
                <UiDetailField label="Paid" :value="fmtMoney(detail.paid_balance)" />
                <UiDetailField label="Current balance" :value="fmtMoney(detail.current_balance ?? detail.ledger_balance)" />
              </div>
            </div>
            <UButton color="neutral" variant="ghost" icon="i-lucide-x" @click="closeManage" />
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            <div v-if="loadingDetail && !ledger.length" class="py-10 text-center text-slate-500">Loading…</div>
            <template v-else>
              <div v-if="canManage" class="mb-6 grid gap-4 sm:grid-cols-2">
                <div class="flex min-w-0 flex-col gap-1.5">
                  <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-edit-name">Name</label>
                  <UInput id="sup-edit-name" v-model="editForm.name" class="w-full" placeholder="Legal / display name" />
                </div>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-edit-company">Company name</label>
                  <UInput id="sup-edit-company" v-model="editForm.companyName" class="w-full" placeholder="Company name" />
                </div>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-edit-contact">Contact person</label>
                  <UInput id="sup-edit-contact" v-model="editForm.contactPerson" class="w-full" placeholder="Contact person" />
                </div>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-edit-phone">Phone</label>
                  <UInput id="sup-edit-phone" v-model="editForm.phone" class="w-full" placeholder="Phone number" />
                </div>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-edit-email">Email</label>
                  <UInput id="sup-edit-email" v-model="editForm.email" class="w-full" type="email" placeholder="Email" />
                </div>
                <div class="flex min-w-0 flex-col gap-1.5">
                  <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-edit-tax">Tax / NTN</label>
                  <UInput id="sup-edit-tax" v-model="editForm.taxNtn" class="w-full" placeholder="Tax or NTN number" />
                </div>
                <div class="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
                  <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-edit-address">Address</label>
                  <UInput id="sup-edit-address" v-model="editForm.address" class="w-full" placeholder="Street, city, country" />
                </div>
              </div>

              <div v-if="canManage" class="mb-6 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <h3 class="mb-1 text-sm font-semibold text-slate-800 dark:text-slate-200">Supplies — categories and products</h3>
                <p class="mb-3 text-xs text-slate-500">
                  Link this supplier to categories and/or specific products (saved with “Save profile”).
                </p>
                <div class="grid gap-4 sm:grid-cols-2">
                  <div class="flex min-w-0 flex-col gap-2">
                    <label class="text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-edit-categories">Categories</label>
                    <USelectMenu
                      id="sup-edit-categories"
                      :key="'edit-cat-' + supplierCatalogUiKey"
                      v-model="modalCategoryIds"
                      multiple
                      value-key="value"
                      label-key="label"
                      :items="categorySelectItems"
                      placeholder="Search categories…"
                      class="w-full"
                      :content="supplierSelectContent"
                      :disabled="!categorySelectItems.length"
                      :reset-search-term-on-select="false"
                    />
                  </div>
                  <div class="flex min-w-0 flex-col gap-2">
                    <label class="text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-edit-products">Products</label>
                    <USelectMenu
                      id="sup-edit-products"
                      :key="'edit-prod-' + supplierCatalogUiKey"
                      v-model="modalProductIds"
                      multiple
                      value-key="value"
                      label-key="label"
                      :items="productSelectItems"
                      :filter-fields="['label', 'name', 'sku']"
                      placeholder="Search products…"
                      class="w-full"
                      :content="supplierSelectContent"
                      :disabled="!productSelectItems.length"
                      :reset-search-term-on-select="false"
                    />
                  </div>
                </div>
              </div>

              <div v-if="canManage" class="mb-6">
                <UButton icon="i-lucide-save" @click="saveEdit">Save profile</UButton>
              </div>

              <div v-if="canManage" class="mb-6 rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <h3 class="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-200">Record payment</h3>
                <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <div class="flex min-w-0 flex-col gap-1.5">
                    <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-pay-amount">Amount</label>
                    <UInput id="sup-pay-amount" v-model.number="paymentForm.amount" class="w-full" type="number" placeholder="0.00" />
                  </div>
                  <div class="flex min-w-0 flex-col gap-1.5">
                    <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-pay-method">Payment method</label>
                    <UiSearchableSelect
                      id="sup-pay-method"
                      v-model="paymentForm.method"
                      class="w-full"
                      :items="[
                        { label: 'Cash', value: 'cash' },
                        { label: 'Bank transfer', value: 'bank_transfer' }
                      ]"
                    />
                  </div>
                  <div class="flex min-w-0 flex-col gap-1.5 lg:col-span-2">
                    <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="sup-pay-ref">Reference</label>
                    <UInput id="sup-pay-ref" v-model="paymentForm.reference" class="w-full" placeholder="Cheque no., transfer ref., …" />
                  </div>
                  <div class="flex items-end sm:col-span-2 lg:col-span-4">
                    <UButton icon="i-lucide-banknote" @click="recordPayment">Post payment</UButton>
                  </div>
                </div>
              </div>

              <h3 class="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-200">Ledger</h3>
              <div class="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
                <table class="min-w-full text-left text-sm">
                  <thead class="bg-slate-50 text-xs uppercase text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                    <tr>
                      <th class="px-3 py-2">Date</th>
                      <th class="px-3 py-2">Kind</th>
                      <th class="px-3 py-2">Amount</th>
                      <th class="px-3 py-2">Running</th>
                      <th class="px-3 py-2">Memo</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in ledger" :key="row.id" class="border-t border-slate-100 dark:border-slate-800">
                      <td class="px-3 py-2 whitespace-nowrap text-slate-600 dark:text-slate-300">{{ formatDateTime(row.created_at) }}</td>
                      <td class="px-3 py-2">{{ row.entry_kind }}</td>
                      <td class="px-3 py-2 font-mono">{{ fmtMoney(row.amount) }}</td>
                      <td class="px-3 py-2 font-mono text-emerald-700 dark:text-emerald-300">{{ fmtMoney(row.running_balance) }}</td>
                      <td class="px-3 py-2 text-slate-500">{{ row.memo || '—' }}</td>
                    </tr>
                  </tbody>
                </table>
                <p v-if="!ledger.length" class="px-3 py-6 text-center text-slate-500">No ledger movements yet.</p>
              </div>
            </template>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
