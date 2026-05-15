<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ApiError, useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'

type Department = { id: string; name: string; is_active?: boolean }

/** USelect may emit a raw value or an item object depending on version / state. */
function selectToPrimitive(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined
  if (typeof val === 'string') return val.trim()
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (typeof val === 'object' && val !== null && 'value' in val) {
    const inner = (val as { value: unknown }).value
    if (inner === null || inner === undefined) return undefined
    return typeof inner === 'string' ? inner.trim() : String(inner).trim()
  }
  return undefined
}

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

const { request } = useApi()
const { user } = useAuth()

const canManageInventory = computed(() => {
  const u = user.value
  if (!u) return false
  const perms = u.permissions ?? []
  const roles = u.roles ?? []
  return perms.includes('manage_inventory') || roles.includes('admin') || roles.includes('manager')
})

const balances = ref<Balance[]>([])
const lowStock = ref<Balance[]>([])
const products = ref<Array<{ id: string; name: string; sku: string }>>([])
const movements = ref<Array<{ id: string; product_name: string; movement_type: string; qty: number; created_at: string }>>([])
const departments = ref<Department[]>([])
/** Non-empty sentinel — Nuxt UI `USelect` does not reliably support `value: ''` (see products filters). */
const ALL_DEPARTMENTS_VALUE = '__all_departments__'

const filterDepartmentId = ref<string>(ALL_DEPARTMENTS_VALUE)
const tableSearchQuery = ref('')
const tableLoading = ref(false)
const errorMessage = ref('')

const categories = ref<ProductCategory[]>([])
const isInventoryEditOpen = ref(false)
const editSaving = ref(false)

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
  if (!Number.isFinite(qty) || qty < 0) {
    errorMessage.value = 'Quantity on hand must be zero or greater.'
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
  return `PKR ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatOpeningBalance(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n.toFixed(3)
}

const filteredBalances = computed(() => {
  const q = tableSearchQuery.value.trim().toLowerCase()
  if (!q) return balances.value
  return balances.value.filter((row) => {
    const hay = [
      row.name,
      row.sku,
      row.barcode,
      row.category_name,
      row.department_name,
      formatOpeningBalance(row.opening_balance),
      itemCode(row)
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
    return hay.includes(q)
  })
})

const inventoryTableEmptyMessage = computed(() => {
  if (tableLoading.value) return ''
  if (!balances.value.length) return 'No products match this view.'
  if (!filteredBalances.value.length) return 'No rows match your search.'
  return ''
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

const loadData = async () => {
  errorMessage.value = ''
  tableLoading.value = true
  try {
    const dept = filterDepartmentId.value
    const balancePath =
      dept !== ALL_DEPARTMENTS_VALUE && /^[0-9a-f-]{36}$/i.test(dept)
        ? `/inventory/balances?departmentId=${encodeURIComponent(dept)}`
        : '/inventory/balances'

    const [balanceRes, lowRes, productRes, movementRes, deptRes, categoryRes] = await Promise.all([
      request<Balance[]>(balancePath),
      request<Balance[]>('/inventory/low-stock'),
      request<Array<{ id: string; name: string; sku: string }>>('/products'),
      request<Array<{ id: string; product_name: string; movement_type: string; qty: number; created_at: string }>>(
        '/inventory/movements'
      ),
      request<Department[]>('/products/departments'),
      request<ProductCategory[]>('/products/categories')
    ])
    balances.value = balanceRes
    lowStock.value = lowRes
    products.value = productRes.map((item) => ({ id: item.id, name: item.name, sku: item.sku }))
    movements.value = movementRes
    departments.value = deptRes
    categories.value = categoryRes
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load inventory data'
  } finally {
    tableLoading.value = false
  }
}

watch(filterDepartmentId, () => {
  void loadData()
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
        <div class="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <UInput
            v-model="tableSearchQuery"
            icon="i-lucide-search"
            placeholder="Search name, SKU, barcode, category…"
            class="min-w-0 flex-1 sm:min-w-[16rem] sm:max-w-xs"
          />
          <USelect
            v-model="filterDepartmentIdModel"
            :items="departmentFilterItems"
            placeholder="Department"
            class="min-w-[14rem]"
          />
        </div>
      </div>
      <div class="overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th class="px-3 py-2">Item name</th>
              <th class="px-3 py-2">Item code</th>
              <th class="px-3 py-2">Category</th>
              <th class="px-3 py-2 text-right">Opening balance</th>
              <th class="px-3 py-2 text-right">Qty on hand</th>
              <th class="px-3 py-2 text-right">Cost price</th>
              <th class="px-3 py-2 text-right">Sale price</th>
              <th v-if="canManageInventory" class="px-3 py-2 w-24 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <template v-if="tableLoading">
              <tr>
                <td class="px-3 py-6 text-slate-500" :colspan="canManageInventory ? 8 : 7">Loading…</td>
              </tr>
            </template>
            <template v-else>
              <tr
                v-for="row in filteredBalances"
                :key="row.product_id"
                class="border-b border-slate-100 dark:border-slate-800 transition-colors"
                :class="
                  canManageInventory
                    ? 'cursor-pointer hover:bg-emerald-50/60 dark:hover:bg-emerald-950/20'
                    : ''
                "
                @click="onInventoryRowClick(row)"
              >
                <td class="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">{{ row.name }}</td>
                <td class="px-3 py-2 font-mono text-xs text-slate-700 dark:text-slate-300">{{ itemCode(row) }}</td>
                <td class="px-3 py-2 text-slate-700 dark:text-slate-300">{{ row.category_name || '—' }}</td>
                <td class="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-300">
                  {{ formatOpeningBalance(row.opening_balance) }}
                </td>
                <td class="px-3 py-2 text-right tabular-nums">{{ Number(row.qty_on_hand).toFixed(3) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(row.cost_price) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ formatMoney(row.sale_price) }}</td>
                <td v-if="canManageInventory" class="px-3 py-2 text-right" @click.stop>
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="soft"
                    icon="i-lucide-pencil"
                    @click="openInventoryEdit(row)"
                  >
                    Edit
                  </UButton>
                </td>
              </tr>
              <tr v-if="inventoryTableEmptyMessage">
                <td class="px-3 py-6 text-slate-500" :colspan="canManageInventory ? 8 : 7">
                  {{ inventoryTableEmptyMessage }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </UCard>

    <div class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Stock In</h2>
        <div class="grid gap-3">
          <USelect
            v-model="stockInForm.productId"
            :items="products.map((p) => ({ label: `${p.name} (${p.sku})`, value: p.id }))"
            placeholder="Select product"
          />
          <UInput v-model.number="stockInForm.qty" type="number" placeholder="Quantity" />
          <UInput v-model.number="stockInForm.unitCost" type="number" placeholder="Unit cost" />
          <UInput v-model="stockInForm.reason" placeholder="Reason" />
          <UButton icon="i-lucide-arrow-down-to-line" @click="stockIn">Submit Stock In</UButton>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Stock Out</h2>
        <div class="grid gap-3">
          <USelect
            v-model="stockOutForm.productId"
            :items="products.map((p) => ({ label: `${p.name} (${p.sku})`, value: p.id }))"
            placeholder="Select product"
          />
          <UInput v-model.number="stockOutForm.qty" type="number" placeholder="Quantity" />
          <UInput v-model="stockOutForm.reason" placeholder="Reason" />
          <UButton color="warning" icon="i-lucide-arrow-up-from-line" @click="stockOut">Submit Stock Out</UButton>
        </div>
      </UCard>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Low Stock Alerts</h2>
        <div class="space-y-2">
          <div v-for="item in lowStock" :key="item.product_id" class="rounded-lg bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
            <p class="font-medium">{{ item.name }}</p>
            <p class="text-slate-600 dark:text-slate-400">SKU: {{ item.sku }} • Qty: {{ Number(item.qty_on_hand).toFixed(3) }}</p>
          </div>
          <p v-if="!lowStock.length" class="text-sm text-slate-500">No low stock items.</p>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Recent Movements</h2>
        <div class="space-y-2">
          <div v-for="move in movements.slice(0, 12)" :key="move.id" class="rounded-lg bg-slate-100 p-3 text-sm dark:bg-slate-800">
            <p class="font-medium">{{ move.product_name }}</p>
            <p class="text-slate-600 dark:text-slate-400">
              {{ move.movement_type }} • Qty {{ Number(move.qty).toFixed(3) }} • {{ new Date(move.created_at).toLocaleString() }}
            </p>
          </div>
          <p v-if="!movements.length" class="text-sm text-slate-500">No movement history yet.</p>
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
            <USelect
              id="inv-edit-category"
              v-model="editCategorySelectModel"
              class="w-full"
              :items="categorySelectItems"
              placeholder="Select category"
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
              min="0"
            />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-cost">Cost price (PKR)</label>
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
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="inv-edit-sale">Sale price (PKR)</label>
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
  </section>
</template>
