<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { withQuery } from 'ufo'
import { ApiError, useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'
import { selectToPrimitive } from '~/composables/useSelectValue'
import { formatRs } from '~/composables/useMoneyFormat'

type Department = { id: string; name: string; is_active?: boolean }

type Balance = {
  product_id: string
  name: string
  sku: string
  barcode: string
  qty_on_hand: number
  opening_balance?: string | number | null
  cost_price?: string | number | null
  sale_price?: string | number | null
  category_id?: string | null
  category_name?: string | null
  department_id?: string | null
  department_name?: string | null
}

type ProductCategory = { id: string; name: string; department_name?: string | null }

const NO_CATEGORY_VALUE = '__none__'
const PAGE_SIZE = 50

type Paginated<T> = { items: T[]; total: number; limit: number; offset: number }

const { request } = useApi()
const { user } = useAuth()
const toast = useToast()

const canManageInventory = computed(() => {
  const u = user.value
  if (!u) return false
  const perms = u.permissions ?? []
  const roles = u.roles ?? []
  return perms.includes('manage_inventory') || roles.includes('admin') || roles.includes('manager')
})

const balances = ref<Balance[]>([])
const balanceTotal = ref(0)
const balancePage = ref(1)
const lowStock = ref<Balance[]>([])
const lowStockTotal = ref(0)
const lowStockPage = ref(1)
const products = ref<Array<{ id: string; name: string; sku: string }>>([])
const movements = ref<Array<{ id: string; product_name: string; movement_type: string; qty: number; created_at: string }>>([])
const movementTotal = ref(0)
const movementPage = ref(1)
const departments = ref<Department[]>([])
/** Non-empty sentinel — Nuxt UI `USelect` does not reliably support `value: ''` (see products filters). */
const ALL_DEPARTMENTS_VALUE = '__all_departments__'

const filterDepartmentId = ref<string>(ALL_DEPARTMENTS_VALUE)
const tableSearchQuery = ref('')
const tableLoading = ref(false)
const lowStockLoading = ref(false)
const movementLoading = ref(false)
const errorMessage = ref('')

const balancePageCount = computed(() => Math.max(1, Math.ceil(balanceTotal.value / PAGE_SIZE) || 1))
const lowStockPageCount = computed(() => Math.max(1, Math.ceil(lowStockTotal.value / PAGE_SIZE) || 1))
const movementPageCount = computed(() => Math.max(1, Math.ceil(movementTotal.value / PAGE_SIZE) || 1))
const balanceRangeStart = computed(() =>
  balanceTotal.value === 0 ? 0 : (balancePage.value - 1) * PAGE_SIZE + 1
)
const balanceRangeEnd = computed(() => Math.min(balancePage.value * PAGE_SIZE, balanceTotal.value))
const lowStockRangeStart = computed(() =>
  lowStockTotal.value === 0 ? 0 : (lowStockPage.value - 1) * PAGE_SIZE + 1
)
const lowStockRangeEnd = computed(() => Math.min(lowStockPage.value * PAGE_SIZE, lowStockTotal.value))
const movementRangeStart = computed(() =>
  movementTotal.value === 0 ? 0 : (movementPage.value - 1) * PAGE_SIZE + 1
)
const movementRangeEnd = computed(() => Math.min(movementPage.value * PAGE_SIZE, movementTotal.value))

const categories = ref<ProductCategory[]>([])
const isInventoryEditOpen = ref(false)
const editSaving = ref(false)
const deletingProductId = ref<string | null>(null)
const bulkDeletingProducts = ref(false)
const selectedProductIds = ref<Set<string>>(new Set())
const deleteConfirmOpen = ref(false)
const deleteConfirmLoading = ref(false)
const deletePending = ref<{ mode: 'single'; row: Balance } | { mode: 'bulk' } | null>(null)

const editForm = reactive({
  productId: '' as string,
  name: '',
  sku: '',
  barcode: '',
  categoryId: NO_CATEGORY_VALUE as string,
  openingBalance: 0,
  qtyOnHand: 0,
  costPrice: 0,
  salePrice: 0
})

const categoryLabel = (category: ProductCategory) =>
  category.department_name ? `${category.name} (${category.department_name})` : category.name

const categorySelectItems = computed(() => [
  { label: 'No category', value: NO_CATEGORY_VALUE },
  ...categories.value
    .filter((c) => typeof c.id === 'string' && c.id.trim().length > 0)
    .map((c) => ({ label: categoryLabel(c), value: c.id }))
])

const editCategorySelectModel = computed({
  get: () => editForm.categoryId,
  set: (v: unknown) => {
    editForm.categoryId = (selectToPrimitive(v) ?? NO_CATEGORY_VALUE) as string
  }
})

const selectedProductCount = computed(() => selectedProductIds.value.size)

const allBalancesOnPageSelected = computed(
  () => balances.value.length > 0 && balances.value.every((r) => selectedProductIds.value.has(r.product_id))
)

const clearProductSelection = () => {
  selectedProductIds.value = new Set()
}

const setProductSelected = (id: string, checked: boolean) => {
  const next = new Set(selectedProductIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedProductIds.value = next
}

const toggleSelectAllBalances = () => {
  const next = new Set(selectedProductIds.value)
  if (allBalancesOnPageSelected.value) {
    for (const r of balances.value) next.delete(r.product_id)
  } else {
    for (const r of balances.value) next.add(r.product_id)
  }
  selectedProductIds.value = next
}

const deleteConfirmTitle = computed(() => {
  const pending = deletePending.value
  if (!pending) return 'Confirm delete'
  if (pending.mode === 'bulk') {
    return `Delete ${selectedProductCount.value} product(s)?`
  }
  return `Delete "${pending.row.name}"?`
})

const deleteConfirmDescription =
  'The product will be deactivated and hidden from POS. Sales history is kept.'

const closeDeleteConfirm = () => {
  if (deleteConfirmLoading.value) return
  deleteConfirmOpen.value = false
  deletePending.value = null
}

const openDeleteInventoryProductConfirm = (row: Balance) => {
  deletePending.value = { mode: 'single', row }
  deleteConfirmOpen.value = true
}

const openBulkDeleteInventoryProductsConfirm = () => {
  if (!selectedProductCount.value) return
  deletePending.value = { mode: 'bulk' }
  deleteConfirmOpen.value = true
}

const performDeleteInventoryProduct = async (row: Balance) => {
  deletingProductId.value = row.product_id
  errorMessage.value = ''
  try {
    await request(`/products/${row.product_id}`, { method: 'DELETE' })
    setProductSelected(row.product_id, false)
    await loadData()
    toast.add({
      title: 'Product deleted',
      description: `"${row.name}" was deactivated.`,
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
  } catch (error: unknown) {
    const msg =
      error instanceof ApiError
        ? error.message
        : (error as { message?: string }).message ?? 'Failed to delete product'
    errorMessage.value = msg
    toast.add({ title: 'Delete failed', description: msg, color: 'error', icon: 'i-lucide-triangle-alert' })
    throw error
  } finally {
    deletingProductId.value = null
  }
}

const performBulkDeleteInventoryProducts = async () => {
  const ids = [...selectedProductIds.value]
  if (!ids.length) return
  bulkDeletingProducts.value = true
  errorMessage.value = ''
  try {
    const res = await request<{
      deletedCount: number
      failed: { id: string; message: string }[]
    }>('/products/bulk-delete', { method: 'POST', body: { ids } })
    clearProductSelection()
    await loadData()
    toast.add({
      title: 'Products deleted',
      description: `${res.deletedCount} product(s) deactivated.`,
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
    if (res.failed?.length) {
      const msg = res.failed.map((f) => f.message).join(' · ')
      errorMessage.value = msg
      toast.add({
        title: 'Some products were not deleted',
        description: msg,
        color: 'warning',
        icon: 'i-lucide-triangle-alert'
      })
    }
  } catch (error: unknown) {
    const msg =
      error instanceof ApiError
        ? error.message
        : (error as { message?: string }).message ?? 'Bulk delete failed'
    errorMessage.value = msg
    toast.add({ title: 'Bulk delete failed', description: msg, color: 'error', icon: 'i-lucide-triangle-alert' })
    throw error
  } finally {
    bulkDeletingProducts.value = false
  }
}

const confirmDeleteAction = async () => {
  if (!canManageInventory.value || !deletePending.value) return
  deleteConfirmLoading.value = true
  try {
    const pending = deletePending.value
    if (pending.mode === 'single') {
      await performDeleteInventoryProduct(pending.row)
    } else {
      await performBulkDeleteInventoryProducts()
    }
    closeDeleteConfirm()
  } catch {
    /* toast + errorMessage already set */
  } finally {
    deleteConfirmLoading.value = false
  }
}

function onInventoryRowClick(row: Balance) {
  if (!canManageInventory.value) return
  openInventoryEdit(row)
}

function openInventoryEdit(row: Balance) {
  if (!canManageInventory.value) return
  errorMessage.value = ''
  editForm.productId = row.product_id
  editForm.name = row.name ?? ''
  editForm.sku = (row.sku ?? '').trim()
  editForm.barcode = (row.barcode ?? '').trim()
  const cid = row.category_id?.trim()
  editForm.categoryId = cid && cid.length > 0 ? cid : NO_CATEGORY_VALUE
  const ob = row.opening_balance
  const hasOpening =
    ob !== null && ob !== undefined && ob !== '' && Number.isFinite(Number(ob))
  editForm.openingBalance = hasOpening ? Number(ob) : Number(row.qty_on_hand)
  editForm.qtyOnHand = Number(row.qty_on_hand)
  editForm.costPrice = Number(row.cost_price ?? 0)
  editForm.salePrice = Number(row.sale_price ?? 0)
  isInventoryEditOpen.value = true
}

function closeInventoryEdit() {
  isInventoryEditOpen.value = false
}

async function saveInventoryEdit() {
  if (!canManageInventory.value) return
  const id = editForm.productId
  if (!id) return

  const name = editForm.name.trim()
  const sku = editForm.sku.trim()
  const barcode = editForm.barcode.trim()
  if (name.length < 2) {
    errorMessage.value = 'Name must be at least 2 characters.'
    return
  }
  if (sku.length < 2) {
    errorMessage.value = 'SKU must be at least 2 characters.'
    return
  }
  if (barcode.length < 3) {
    errorMessage.value = 'Barcode must be at least 3 characters.'
    return
  }
  const salePrice = Number(editForm.salePrice)
  const costPrice = Number(editForm.costPrice)
  if (!Number.isFinite(salePrice) || salePrice <= 0) {
    errorMessage.value = 'Sale price must be a positive number.'
    return
  }
  if (!Number.isFinite(costPrice) || costPrice < 0) {
    errorMessage.value = 'Cost price must be zero or greater.'
    return
  }
  const qty = Number(editForm.qtyOnHand)
  const opening = Number(editForm.openingBalance)
  if (!Number.isFinite(opening) || opening < 0) {
    errorMessage.value = 'Opening balance must be zero or greater.'
    return
  }
  if (!Number.isFinite(qty)) {
    errorMessage.value = 'Quantity on hand must be a valid number.'
    return
  }

  const categoryId = editForm.categoryId === NO_CATEGORY_VALUE ? null : editForm.categoryId
  const qtyRounded = Math.round(qty * 1000) / 1000
  const openingRounded = Math.round(opening * 1000) / 1000

  editSaving.value = true
  errorMessage.value = ''
  try {
    await request(`/products/${id}`, {
      method: 'PATCH',
      body: {
        name,
        sku,
        barcode,
        salePrice,
        costPrice,
        categoryId
      }
    })

    await request(`/inventory/balances/${id}`, {
      method: 'PATCH',
      body: {
        qtyOnHand: qtyRounded,
        openingBalance: openingRounded,
        reason: 'Updated from inventory screen'
      }
    })

    await loadData()
    closeInventoryEdit()
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      errorMessage.value = error.message
    } else {
      errorMessage.value = (error as { message?: string }).message ?? 'Failed to save changes'
    }
  } finally {
    editSaving.value = false
  }
}

const departmentFilterItems = computed(() => [
  { label: 'All departments', value: ALL_DEPARTMENTS_VALUE },
  ...departments.value.map((d) => ({ label: d.name, value: d.id }))
])

/** Normalize `USelect` v-model so `filterDepartmentId` stays a plain string UUID or sentinel. */
const filterDepartmentIdModel = computed({
  get: () => filterDepartmentId.value,
  set: (v: unknown) => {
    filterDepartmentId.value = (selectToPrimitive(v) ?? ALL_DEPARTMENTS_VALUE) as string
  }
})

function itemCode(row: Balance): string {
  const sku = (row.sku ?? '').trim()
  const bc = (row.barcode ?? '').trim()
  if (sku) return sku
  if (bc) return bc
  return '—'
}

function formatMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  if (Number.isNaN(n)) return '—'
  return formatRs(n)
}

function formatQtyWhole(value: string | number | null | undefined): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString()
}

const inventoryTableEmptyMessage = computed(() => {
  if (tableLoading.value) return ''
  if (balanceTotal.value === 0) {
    return tableSearchQuery.value.trim() ? 'No rows match your search.' : 'No products match this view.'
  }
  if (!balances.value.length) return 'No rows on this page.'
  return ''
})

const balancesListQuery = (): Record<string, string | number> => {
  const out: Record<string, string | number> = {
    limit: PAGE_SIZE,
    offset: (balancePage.value - 1) * PAGE_SIZE,
    withTotal: 'true'
  }
  const dept = filterDepartmentId.value
  if (dept !== ALL_DEPARTMENTS_VALUE && /^[0-9a-f-]{36}$/i.test(dept)) {
    out.departmentId = dept
  }
  const q = tableSearchQuery.value.trim()
  if (q) out.q = q
  return out
}

const balancesListUrl = () => withQuery('/inventory/balances', balancesListQuery())

const lowStockListUrl = () =>
  withQuery('/inventory/low-stock', {
    limit: PAGE_SIZE,
    offset: (lowStockPage.value - 1) * PAGE_SIZE,
    withTotal: 'true'
  })

const movementsListUrl = () =>
  withQuery('/inventory/movements', {
    limit: PAGE_SIZE,
    offset: (movementPage.value - 1) * PAGE_SIZE,
    withTotal: 'true'
  })

const stockInForm = reactive({
  productId: '',
  qty: 0,
  unitCost: 0,
  reason: ''
})

const stockOutForm = reactive({
  productId: '',
  qty: 0,
  reason: ''
})

const loadBalancesPage = async () => {
  const res = await request<Paginated<Balance>>(balancesListUrl())
  balances.value = res.items
  balanceTotal.value = res.total
  const maxPage = Math.max(1, Math.ceil(res.total / PAGE_SIZE) || 1)
  if (balancePage.value > maxPage) {
    balancePage.value = maxPage
    const retry = await request<Paginated<Balance>>(balancesListUrl())
    balances.value = retry.items
    balanceTotal.value = retry.total
  }
}

const loadLowStockPage = async () => {
  const res = await request<Paginated<Balance>>(lowStockListUrl())
  lowStock.value = res.items
  lowStockTotal.value = res.total
  const maxPage = Math.max(1, Math.ceil(res.total / PAGE_SIZE) || 1)
  if (lowStockPage.value > maxPage) {
    lowStockPage.value = maxPage
    const retry = await request<Paginated<Balance>>(lowStockListUrl())
    lowStock.value = retry.items
    lowStockTotal.value = retry.total
  }
}

const loadMovementsPage = async () => {
  const res = await request<
    Paginated<{ id: string; product_name: string; movement_type: string; qty: number; created_at: string }>
  >(movementsListUrl())
  movements.value = res.items
  movementTotal.value = res.total
  const maxPage = Math.max(1, Math.ceil(res.total / PAGE_SIZE) || 1)
  if (movementPage.value > maxPage) {
    movementPage.value = maxPage
    const retry = await request<
      Paginated<{ id: string; product_name: string; movement_type: string; qty: number; created_at: string }>
    >(movementsListUrl())
    movements.value = retry.items
    movementTotal.value = retry.total
  }
}

const loadData = async () => {
  errorMessage.value = ''
  tableLoading.value = true
  lowStockLoading.value = true
  movementLoading.value = true
  try {
    const [, , , productList, deptRes, categoryRes] = await Promise.all([
      loadBalancesPage(),
      loadLowStockPage(),
      loadMovementsPage(),
      request<Array<{ id: string; name: string; sku: string }>>('/products'),
      request<Department[]>('/products/departments'),
      request<ProductCategory[]>('/products/categories')
    ])
    products.value = productList.map((item) => ({ id: item.id, name: item.name, sku: item.sku }))
    departments.value = deptRes
    categories.value = categoryRes
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load inventory data'
  } finally {
    tableLoading.value = false
    lowStockLoading.value = false
    movementLoading.value = false
  }
}

const setBalancePage = (page: number) => {
  const next = Math.min(Math.max(1, page), balancePageCount.value)
  if (next === balancePage.value) return
  balancePage.value = next
  void (async () => {
    tableLoading.value = true
    try {
      await loadBalancesPage()
    } catch (error: unknown) {
      errorMessage.value = (error as { message?: string }).message ?? 'Failed to load inventory'
    } finally {
      tableLoading.value = false
    }
  })()
}

const setLowStockPage = (page: number) => {
  const next = Math.min(Math.max(1, page), lowStockPageCount.value)
  if (next === lowStockPage.value) return
  lowStockPage.value = next
  void (async () => {
    lowStockLoading.value = true
    try {
      await loadLowStockPage()
    } catch (error: unknown) {
      errorMessage.value = (error as { message?: string }).message ?? 'Failed to load low stock alerts'
    } finally {
      lowStockLoading.value = false
    }
  })()
}

const setMovementPage = (page: number) => {
  const next = Math.min(Math.max(1, page), movementPageCount.value)
  if (next === movementPage.value) return
  movementPage.value = next
  void (async () => {
    movementLoading.value = true
    try {
      await loadMovementsPage()
    } catch (error: unknown) {
      errorMessage.value = (error as { message?: string }).message ?? 'Failed to load movements'
    } finally {
      movementLoading.value = false
    }
  })()
}

let balanceSearchDebounce: ReturnType<typeof setTimeout> | null = null

watch(filterDepartmentId, () => {
  balancePage.value = 1
  clearProductSelection()
  void loadData()
})

watch(balancePage, () => {
  clearProductSelection()
})

watch(tableSearchQuery, () => {
  balancePage.value = 1
  if (balanceSearchDebounce) clearTimeout(balanceSearchDebounce)
  balanceSearchDebounce = setTimeout(() => {
    balanceSearchDebounce = null
    clearProductSelection()
    void (async () => {
      tableLoading.value = true
      try {
        await loadBalancesPage()
      } catch (error: unknown) {
        errorMessage.value = (error as { message?: string }).message ?? 'Failed to load inventory'
      } finally {
        tableLoading.value = false
      }
    })()
  }, 320)
})

const stockIn = async () => {
  try {
    await request('/inventory/stock-in', {
      method: 'POST',
      body: {
        productId: stockInForm.productId,
        qty: Number(stockInForm.qty),
        unitCost: Number(stockInForm.unitCost),
        reason: stockInForm.reason || undefined
      }
    })
    stockInForm.productId = ''
    stockInForm.qty = 0
    stockInForm.unitCost = 0
    stockInForm.reason = ''
    movementPage.value = 1
    lowStockPage.value = 1
    await loadData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Stock in failed'
  }
}

const stockOut = async () => {
  try {
    await request('/inventory/stock-out', {
      method: 'POST',
      body: {
        productId: stockOutForm.productId,
        qty: Number(stockOutForm.qty),
        reason: stockOutForm.reason || undefined
      }
    })
    stockOutForm.productId = ''
    stockOutForm.qty = 0
    stockOutForm.reason = ''
    movementPage.value = 1
    lowStockPage.value = 1
    await loadData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Stock out failed'
  }
}

onMounted(async () => {
  await loadData()
})
</script>

<template>
  <section class="space-y-6">
    <UAlert
      v-if="errorMessage"
      color="error"
      variant="soft"
      :description="errorMessage"
      icon="i-lucide-triangle-alert"
    />

    <UCard>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Inventory on hand</h2>
        </div>
        <div class="flex w-full flex-wrap items-end gap-2 sm:w-auto sm:justify-end">
          <UiLabeledField label="Search" html-for="inv-table-search" class="min-w-0 flex-1 sm:min-w-[16rem] sm:max-w-xs">
            <UInput
              id="inv-table-search"
              v-model="tableSearchQuery"
              icon="i-lucide-search"
              class="w-full"
            />
          </UiLabeledField>
          <UiLabeledField label="Department" class="min-w-[14rem]">
            <UiSearchableSelect
              v-model="filterDepartmentIdModel"
              :items="departmentFilterItems"
              placeholder="Search department…"
              class="w-full"
            />
          </UiLabeledField>
          <UButton
            v-if="canManageInventory && selectedProductCount > 0"
            color="error"
            variant="soft"
            size="sm"
            icon="i-lucide-trash-2"
            :loading="bulkDeletingProducts"
            @click="openBulkDeleteInventoryProductsConfirm"
          >
            Delete selected ({{ selectedProductCount }})
          </UButton>
        </div>
      </div>
      <div class="table-scroll table-scroll-bordered">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th v-if="canManageInventory" class="w-10 px-3 py-2">
                <UCheckbox :model-value="allBalancesOnPageSelected" @update:model-value="toggleSelectAllBalances" />
              </th>
              <th class="px-3 py-2">Item name</th>
              <th class="px-3 py-2">Item code</th>
              <th class="px-3 py-2">Category</th>
              <th class="px-3 py-2 text-right">Qty on hand</th>
              <th class="px-3 py-2 text-right">Cost price</th>
              <th class="px-3 py-2 text-right">Sale price</th>
              <th v-if="canManageInventory" class="px-3 py-2 w-24 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <template v-if="tableLoading">
              <tr>
                <td class="px-3 py-6 text-slate-500" :colspan="canManageInventory ? 8 : 6">Loading…</td>
              </tr>
            </template>
            <template v-else>
              <tr
                v-for="row in balances"
                :key="row.product_id"
                class="border-b border-slate-100 dark:border-slate-800 transition-colors"
                :class="
                  canManageInventory
                    ? 'cursor-pointer hover:bg-emerald-50/60 dark:hover:bg-emerald-950/20'
                    : ''
                "
                @click="onInventoryRowClick(row)"
              >
                <td v-if="canManageInventory" class="px-3 py-2" @click.stop>
                  <UCheckbox
                    :model-value="selectedProductIds.has(row.product_id)"
                    @update:model-value="(v: boolean) => setProductSelected(row.product_id, v)"
                  />
                </td>
                <td class="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">{{ row.name }}</td>
                <td class="px-3 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">{{ itemCode(row) }}</td>
                <td class="px-3 py-2 text-slate-700 dark:text-slate-300">{{ row.category_name || '—' }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatQtyWhole(row.qty_on_hand) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(row.cost_price) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(row.sale_price) }}</td>
                <td v-if="canManageInventory" class="px-3 py-2 text-right" @click.stop>
                  <div class="flex flex-wrap items-center justify-end gap-1">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="soft"
                      icon="i-lucide-pencil"
                      @click="openInventoryEdit(row)"
                    >
                      Edit
                    </UButton>
                    <UButton
                      size="xs"
                      color="error"
                      variant="soft"
                      icon="i-lucide-trash-2"
                      :loading="deletingProductId === row.product_id"
                      @click="openDeleteInventoryProductConfirm(row)"
                    >
                      Delete
                    </UButton>
                  </div>
                </td>
              </tr>
              <tr v-if="inventoryTableEmptyMessage">
                <td class="px-3 py-6 text-slate-500" :colspan="canManageInventory ? 8 : 6">
                  {{ inventoryTableEmptyMessage }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div
        v-if="balanceTotal > 0"
        class="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-400"
      >
        <span>Showing {{ balanceRangeStart }}–{{ balanceRangeEnd }} of {{ balanceTotal }}</span>
        <div class="flex items-center gap-2">
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-chevron-left"
            :disabled="balancePage <= 1 || tableLoading"
            @click="setBalancePage(balancePage - 1)"
          />
          <span class="tabular-nums">Page {{ balancePage }} / {{ balancePageCount }}</span>
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-chevron-right"
            :disabled="balancePage >= balancePageCount || tableLoading"
            @click="setBalancePage(balancePage + 1)"
          />
        </div>
      </div>
    </UCard>

    <div class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Stock In</h2>
        <div class="grid gap-3">
          <UiLabeledField label="Product">
            <UiSearchableSelect
              v-model="stockInForm.productId"
              :items="products.map((p) => ({ label: `${p.name} (${p.sku})`, value: p.id }))"
              placeholder="Search product…"
            />
          </UiLabeledField>
          <UiLabeledField label="Quantity" html-for="inv-in-qty">
            <UInput id="inv-in-qty" v-model.number="stockInForm.qty" type="number" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Unit cost" html-for="inv-in-cost">
            <UInput id="inv-in-cost" v-model.number="stockInForm.unitCost" type="number" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Reason" html-for="inv-in-reason">
            <UInput id="inv-in-reason" v-model="stockInForm.reason" class="w-full" />
          </UiLabeledField>
          <UButton icon="i-lucide-arrow-down-to-line" @click="stockIn">Submit Stock In</UButton>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Stock Out</h2>
        <div class="grid gap-3">
          <UiLabeledField label="Product">
            <UiSearchableSelect
              v-model="stockOutForm.productId"
              :items="products.map((p) => ({ label: `${p.name} (${p.sku})`, value: p.id }))"
              placeholder="Search product…"
            />
          </UiLabeledField>
          <UiLabeledField label="Quantity" html-for="inv-out-qty">
            <UInput id="inv-out-qty" v-model.number="stockOutForm.qty" type="number" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Reason" html-for="inv-out-reason">
            <UInput id="inv-out-reason" v-model="stockOutForm.reason" class="w-full" />
          </UiLabeledField>
          <UButton color="warning" icon="i-lucide-arrow-up-from-line" @click="stockOut">Submit Stock Out</UButton>
        </div>
      </UCard>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Low Stock Alerts</h2>
        <div class="table-scroll table-scroll-sm">
          <div class="space-y-2">
            <div v-for="item in lowStock" :key="item.product_id" class="grid gap-2 rounded-lg bg-amber-50 p-3 text-sm sm:grid-cols-3 dark:bg-amber-950/30">
              <UiDetailField label="Product" :value="item.name" />
              <UiDetailField label="SKU" :value="item.sku" />
              <UiDetailField label="Qty on hand" :value="formatQtyWhole(item.qty_on_hand)" />
            </div>
            <p v-if="!lowStock.length && !lowStockLoading" class="text-sm text-slate-500">No low stock items.</p>
            <p v-if="lowStockLoading" class="text-sm text-slate-500">Loading…</p>
          </div>
        </div>
        <div
          v-if="lowStockTotal > 0"
          class="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-400"
        >
          <span>Showing {{ lowStockRangeStart }}–{{ lowStockRangeEnd }} of {{ lowStockTotal }}</span>
          <div class="flex items-center gap-2">
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-chevron-left"
              :disabled="lowStockPage <= 1 || lowStockLoading"
              @click="setLowStockPage(lowStockPage - 1)"
            />
            <span class="tabular-nums">Page {{ lowStockPage }} / {{ lowStockPageCount }}</span>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-chevron-right"
              :disabled="lowStockPage >= lowStockPageCount || lowStockLoading"
              @click="setLowStockPage(lowStockPage + 1)"
            />
          </div>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Recent Movements</h2>
        <div class="table-scroll table-scroll-sm">
          <div class="space-y-2">
            <div v-for="move in movements" :key="move.id" class="grid gap-2 rounded-lg bg-slate-100 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4 dark:bg-slate-800">
              <UiDetailField label="Product" :value="move.product_name" />
              <UiDetailField label="Type" :value="move.movement_type" />
              <UiDetailField label="Qty" :value="Number(move.qty).toFixed(3)" />
              <UiDetailField label="When" :value="formatDateTime(move.created_at)" />
            </div>
            <p v-if="!movements.length && !movementLoading" class="text-sm text-slate-500">No movement history yet.</p>
            <p v-if="movementLoading" class="text-sm text-slate-500">Loading…</p>
          </div>
        </div>
        <div
          v-if="movementTotal > 0"
          class="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-400"
        >
          <span>Showing {{ movementRangeStart }}–{{ movementRangeEnd }} of {{ movementTotal }}</span>
          <div class="flex items-center gap-2">
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-chevron-left"
              :disabled="movementPage <= 1 || movementLoading"
              @click="setMovementPage(movementPage - 1)"
            />
            <span class="tabular-nums">Page {{ movementPage }} / {{ movementPageCount }}</span>
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-chevron-right"
              :disabled="movementPage >= movementPageCount || movementLoading"
              @click="setMovementPage(movementPage + 1)"
            />
          </div>
        </div>
      </UCard>
    </div>

    <div
      v-if="isInventoryEditOpen && canManageInventory"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="closeInventoryEdit"
    >
      <div
        class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-4 shadow-2xl dark:bg-slate-900"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inventory-edit-title"
      >
        <h3 id="inventory-edit-title" class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">
          Edit inventory item
        </h3>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-name">Item name</label>
            <UInput id="inv-edit-name" v-model="editForm.name" class="w-full" placeholder="Full product title" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-sku">SKU</label>
            <UInput id="inv-edit-sku" v-model="editForm.sku" class="w-full" placeholder="Stock keeping unit" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-barcode">Barcode</label>
            <UInput id="inv-edit-barcode" v-model="editForm.barcode" class="w-full" placeholder="Barcode" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-category">Category</label>
            <UiSearchableSelect
              id="inv-edit-category"
              v-model="editCategorySelectModel"
              class="w-full"
              :items="categorySelectItems"
              placeholder="Search category…"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-opening">Opening balance</label>
            <UInput
              id="inv-edit-opening"
              v-model.number="editForm.openingBalance"
              class="w-full"
              type="number"
              placeholder="0"
              step="any"
              min="0"
            />
            <p class="text-xs text-slate-500 dark:text-slate-400">
              Opening balance is your <strong class="font-medium text-slate-600 dark:text-slate-300">reference starting quantity</strong>.
              Quantity on hand is current stock (after sales, etc.). If you change opening only, on-hand moves by the same amount (e.g. opening 10→9 with 2 sold and 8 on hand → 7 on hand). The first time you save an opening with none stored yet, only the opening figure is saved; on-hand stays as-is unless you edit it.
            </p>
          </div>
          <div class="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-qty">Quantity on hand</label>
            <UInput
              id="inv-edit-qty"
              v-model.number="editForm.qtyOnHand"
              class="w-full"
              type="number"
              placeholder="0"
              step="any"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-cost">Cost price (Rs)</label>
            <UInput
              id="inv-edit-cost"
              v-model.number="editForm.costPrice"
              class="w-full"
              type="number"
              placeholder="0"
              min="0"
              step="any"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-sale">Sale price (Rs)</label>
            <UInput
              id="inv-edit-sale"
              v-model.number="editForm.salePrice"
              class="w-full"
              type="number"
              placeholder="0"
              min="0"
              step="any"
            />
          </div>
        </div>
        <div class="mt-4 flex justify-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
          <UButton color="neutral" variant="soft" :disabled="editSaving" @click="closeInventoryEdit">Cancel</UButton>
          <UButton icon="i-lucide-save" :loading="editSaving" @click="saveInventoryEdit">Save changes</UButton>
        </div>
      </div>
    </div>

    <div
      v-if="deleteConfirmOpen"
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      @click.self="closeDeleteConfirm"
    >
      <div
        class="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl dark:bg-slate-900"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="inv-delete-confirm-title"
        aria-describedby="inv-delete-confirm-desc"
      >
        <div class="mb-4 flex items-start gap-3">
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400"
          >
            <UIcon name="i-lucide-trash-2" class="h-5 w-5" />
          </div>
          <div>
            <h3 id="inv-delete-confirm-title" class="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {{ deleteConfirmTitle }}
            </h3>
            <p id="inv-delete-confirm-desc" class="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {{ deleteConfirmDescription }}
            </p>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="soft" :disabled="deleteConfirmLoading" @click="closeDeleteConfirm">
            Cancel
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-trash-2"
            :loading="deleteConfirmLoading"
            @click="confirmDeleteAction"
          >
            Delete
          </UButton>
        </div>
      </div>
    </div>
  </section>
</template>
