<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import {
  EXPENSE_CATEGORIES,
  EXPENSE_TYPE_LABELS,
  EXPENSE_TYPES,
  categoryLabel,
  type ExpenseType
} from '~/constants/expenseCategories'

type ExpenseRow = {
  id: string
  amount: number | string
  category: string
  expense_type: ExpenseType
  expense_date: string
  note: string | null
  created_at: string
  created_by_email?: string | null
}

type SummaryResponse = {
  total: number
  byType: Record<ExpenseType, { total: number; count: number }>
}

const { request } = useApi()

const errorMessage = ref('')
const loading = ref(false)
const saving = ref(false)
const deleting = ref(false)
const rows = ref<ExpenseRow[]>([])
const summary = ref<SummaryResponse | null>(null)
const isEditOpen = ref(false)
const deleteConfirmOpen = ref(false)
const deleteTarget = ref<ExpenseRow | null>(null)
const editingId = ref<string | null>(null)

type ExpensePeriod = 'today' | 'month' | 'year'

const PERIOD_STORAGE_KEY = 'aone-dashboard-kpi-period'

const periodChips: Array<{ label: string; value: ExpensePeriod }> = [
  { label: 'Today', value: 'today' },
  { label: 'Monthly', value: 'month' },
  { label: 'Yearly', value: 'year' }
]

const filterType = ref<'__all__' | ExpenseType>('__all__')
const filterFrom = ref('')
const filterTo = ref('')
const expensePeriod = ref<ExpensePeriod>('today')

function isExpensePeriod(v: unknown): v is ExpensePeriod {
  return v === 'today' || v === 'month' || v === 'year'
}

function loadExpensePeriod(): ExpensePeriod {
  if (!import.meta.client) return 'today'
  try {
    const saved = localStorage.getItem(PERIOD_STORAGE_KEY)
    if (isExpensePeriod(saved)) return saved
  } catch {
    /* ignore */
  }
  return 'today'
}

function periodToDateRange(period: ExpensePeriod): { from: string; to: string } {
  const to = todayIso()
  const now = new Date()
  if (period === 'today') {
    return { from: to, to }
  }
  if (period === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    return { from: start.toISOString().slice(0, 10), to }
  }
  const start = new Date(now.getFullYear(), 0, 1)
  return { from: start.toISOString().slice(0, 10), to }
}

const periodSummaryLabel = computed(() => {
  if (expensePeriod.value === 'today') return 'Today'
  if (expensePeriod.value === 'month') return 'This month'
  return 'This year'
})

function setExpensePeriod(period: ExpensePeriod) {
  expensePeriod.value = period
  const range = periodToDateRange(period)
  filterFrom.value = range.from
  filterTo.value = range.to
  if (import.meta.client) localStorage.setItem(PERIOD_STORAGE_KEY, period)
  void load()
}

const form = reactive({
  expenseType: 'business' as ExpenseType,
  category: 'rent',
  amount: 0,
  expenseDate: '',
  note: ''
})

const categoryItems = computed(() =>
  EXPENSE_CATEGORIES[form.expenseType].map((c) => ({ label: c.label, value: c.value }))
)

const editForm = reactive({
  expenseType: 'business' as ExpenseType,
  category: 'rent',
  amount: 0,
  expenseDate: '',
  note: ''
})

const editCategoryItems = computed(() =>
  EXPENSE_CATEGORIES[editForm.expenseType].map((c) => ({ label: c.label, value: c.value }))
)

function fmtPkr(n: number) {
  return `Rs ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function qs() {
  const params = new URLSearchParams()
  if (filterFrom.value) params.set('from', new Date(filterFrom.value).toISOString())
  if (filterTo.value) params.set('to', new Date(`${filterTo.value}T23:59:59`).toISOString())
  if (filterType.value !== '__all__') params.set('expenseType', filterType.value)
  params.set('limit', '200')
  const s = params.toString()
  return s ? `?${s}` : ''
}

const filterTypeItems = [
  { label: 'All types', value: '__all__' },
  ...EXPENSE_TYPES.map((t) => ({ label: EXPENSE_TYPE_LABELS[t], value: t }))
]

async function load() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [list, sum] = await Promise.all([
      request<ExpenseRow[]>(`/expenses${qs()}`),
      request<SummaryResponse>(`/expenses/summary${qs()}`)
    ])
    rows.value = list
    summary.value = sum
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load expenses'
  } finally {
    loading.value = false
  }
}

function openEdit(row: ExpenseRow) {
  editingId.value = row.id
  editForm.expenseType = row.expense_type
  editForm.category = row.category
  editForm.amount = Number(row.amount)
  editForm.expenseDate = String(row.expense_date).slice(0, 10)
  editForm.note = row.note ?? ''
  isEditOpen.value = true
}

function closeEdit() {
  isEditOpen.value = false
  editingId.value = null
}

async function updateExpense() {
  if (!editingId.value || !editForm.amount || editForm.amount <= 0) {
    errorMessage.value = 'Enter a valid amount.'
    return
  }
  saving.value = true
  errorMessage.value = ''
  try {
    await request(`/expenses/${editingId.value}`, {
      method: 'PATCH',
      body: {
        expenseType: editForm.expenseType,
        category: editForm.category,
        amount: Number(editForm.amount),
        expenseDate: editForm.expenseDate || todayIso(),
        note: editForm.note.trim() || null
      }
    })
    closeEdit()
    await load()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to update expense'
  } finally {
    saving.value = false
  }
}

function askDelete(row: ExpenseRow) {
  deleteTarget.value = row
  deleteConfirmOpen.value = true
}

function cancelDelete() {
  deleteConfirmOpen.value = false
  deleteTarget.value = null
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  errorMessage.value = ''
  try {
    await request(`/expenses/${deleteTarget.value.id}`, { method: 'DELETE' })
    cancelDelete()
    await load()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to delete expense'
  } finally {
    deleting.value = false
  }
}

async function createExpense() {
  if (!form.amount || form.amount <= 0) {
    errorMessage.value = 'Enter a valid amount.'
    return
  }
  saving.value = true
  errorMessage.value = ''
  try {
    await request('/expenses', {
      method: 'POST',
      body: {
        expenseType: form.expenseType,
        category: form.category,
        amount: Number(form.amount),
        expenseDate: form.expenseDate || todayIso(),
        note: form.note.trim() || undefined
      }
    })
    form.amount = 0
    form.note = ''
    await load()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to save expense'
  } finally {
    saving.value = false
  }
}

watch(
  () => form.expenseType,
  (t) => {
    const cats = EXPENSE_CATEGORIES[t]
    if (!cats.some((c) => c.value === form.category)) {
      form.category = cats[0]?.value ?? 'other'
    }
  }
)

watch(
  () => editForm.expenseType,
  (t) => {
    const cats = EXPENSE_CATEGORIES[t]
    if (!cats.some((c) => c.value === editForm.category)) {
      editForm.category = cats[0]?.value ?? 'other'
    }
  }
)

onMounted(() => {
  const period = loadExpensePeriod()
  expensePeriod.value = period
  const range = periodToDateRange(period)
  filterFrom.value = range.from
  filterTo.value = range.to
  form.expenseDate = todayIso()
  void load()
})
</script>

<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Expenses</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Track personal, business, and charity spending alongside sales on the dashboard.
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1 dark:border-slate-700 dark:bg-slate-900/50">
          <button
            v-for="chip in periodChips"
            :key="chip.value"
            type="button"
            class="rounded-full px-4 py-1.5 text-sm font-medium transition-colors"
            :class="
              expensePeriod === chip.value
                ? 'bg-primary text-white shadow-sm'
                : 'text-slate-600 hover:bg-white dark:text-slate-300 dark:hover:bg-slate-800'
            "
            @click="setExpensePeriod(chip.value)"
          >
            {{ chip.label }}
          </button>
        </div>
        <UButton icon="i-lucide-refresh-cw" variant="soft" :loading="loading" @click="load">Refresh</UButton>
      </div>
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="soft"
      :description="errorMessage"
      icon="i-lucide-triangle-alert"
    />

    <div v-if="summary" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <UCard class="bg-slate-50 dark:bg-slate-800/50">
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Total · {{ periodSummaryLabel }}</p>
        <p class="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">{{ fmtPkr(summary.total) }}</p>
      </UCard>
      <UCard v-for="t in EXPENSE_TYPES" :key="t">
        <p class="text-xs font-medium text-slate-500">{{ EXPENSE_TYPE_LABELS[t] }}</p>
        <p class="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">
          {{ fmtPkr(summary.byType[t].total) }}
        </p>
        <p class="text-xs text-slate-500">{{ summary.byType[t].count }} entries</p>
      </UCard>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Record expense</h2>
        <UiLabeledField label="Expense type" class="mb-4">
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="t in EXPENSE_TYPES"
              :key="t"
              size="sm"
              color="neutral"
              :variant="form.expenseType === t ? 'solid' : 'soft'"
              @click="form.expenseType = t"
            >
              {{ EXPENSE_TYPE_LABELS[t] }}
            </UButton>
          </div>
        </UiLabeledField>
        <p class="mb-3 text-xs text-slate-500 dark:text-slate-400">
          <template v-if="form.expenseType === 'personal'">Grocery, utilities, fuel, installments, and other personal costs.</template>
          <template v-else-if="form.expenseType === 'business'">Rent, bills, salaries, and other shop operating costs (posted to ledger).</template>
          <template v-else>Charitable giving — zakat, sadaqah, donations (posted to ledger).</template>
        </p>
        <div class="grid gap-3 sm:grid-cols-2">
          <UiLabeledField label="Category">
            <UiSearchableSelect v-model="form.category" :items="categoryItems" placeholder="Search category…" />
          </UiLabeledField>
          <UiLabeledField label="Amount (Rs)" html-for="exp-amount">
            <UInput id="exp-amount" v-model.number="form.amount" type="number" min="0" step="0.01" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Date" html-for="exp-date" class="sm:col-span-2">
            <UInput id="exp-date" v-model="form.expenseDate" type="date" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Note" html-for="exp-note" class="sm:col-span-2">
            <UInput id="exp-note" v-model="form.note" class="w-full" />
          </UiLabeledField>
          <UButton class="sm:col-span-2" icon="i-lucide-plus" :loading="saving" @click="createExpense">
            Save expense
          </UButton>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Filters</h2>
        <div class="grid gap-3">
          <UiLabeledField label="Expense type">
            <UiSearchableSelect v-model="filterType" :items="filterTypeItems" placeholder="All types" />
          </UiLabeledField>
          <UiLabeledField label="From" html-for="exp-filter-from">
            <UInput id="exp-filter-from" v-model="filterFrom" type="date" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="To" html-for="exp-filter-to">
            <UInput id="exp-filter-to" v-model="filterTo" type="date" class="w-full" />
          </UiLabeledField>
          <p class="text-xs text-slate-500 dark:text-slate-400">
            Period: <span class="font-medium text-slate-700 dark:text-slate-200">{{ periodSummaryLabel }}</span>
            (use chips above or pick custom dates)
          </p>
          <UButton icon="i-lucide-filter" :loading="loading" @click="load">Apply filters</UButton>
        </div>
      </UCard>
    </div>

    <UCard>
      <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Recent entries</h2>
      <div class="table-scroll table-scroll-bordered">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th class="px-3 py-2">Date</th>
              <th class="px-3 py-2">Type</th>
              <th class="px-3 py-2">Category</th>
              <th class="px-3 py-2 text-right">Amount</th>
              <th class="px-3 py-2">Note</th>
              <th class="px-3 py-2 w-28 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id" class="border-b border-slate-100 dark:border-slate-800">
              <td class="px-3 py-2 whitespace-nowrap">{{ formatDate(row.expense_date) }}</td>
              <td class="px-3 py-2">
                <UBadge color="neutral" variant="soft">{{ EXPENSE_TYPE_LABELS[row.expense_type] }}</UBadge>
              </td>
              <td class="px-3 py-2">{{ categoryLabel(row.expense_type, row.category) }}</td>
              <td class="px-3 py-2 text-right font-medium tabular-nums">{{ fmtPkr(Number(row.amount)) }}</td>
              <td class="max-w-[12rem] truncate px-3 py-2 text-slate-500" :title="row.note ?? ''">{{ row.note || '—' }}</td>
              <td class="px-3 py-2 text-right">
                <div class="flex justify-end gap-1">
                  <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-pencil" @click="openEdit(row)">
                    Edit
                  </UButton>
                  <UButton size="xs" color="error" variant="soft" icon="i-lucide-trash-2" @click="askDelete(row)">
                    Delete
                  </UButton>
                </div>
              </td>
            </tr>
            <tr v-if="!rows.length && !loading">
              <td class="px-3 py-6 text-slate-500" colspan="6">No expenses in this period.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <div
      v-if="isEditOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="closeEdit"
    >
      <div class="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-4 shadow-2xl dark:bg-slate-900">
        <h3 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Edit expense</h3>
        <UiLabeledField label="Expense type" class="mb-4">
          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="t in EXPENSE_TYPES"
              :key="`edit-${t}`"
              size="sm"
              color="neutral"
              :variant="editForm.expenseType === t ? 'solid' : 'soft'"
              @click="editForm.expenseType = t"
            >
              {{ EXPENSE_TYPE_LABELS[t] }}
            </UButton>
          </div>
        </UiLabeledField>
        <div class="grid gap-3">
          <UiLabeledField label="Category">
            <UiSearchableSelect v-model="editForm.category" :items="editCategoryItems" placeholder="Search category…" />
          </UiLabeledField>
          <UiLabeledField label="Amount (Rs)" html-for="exp-edit-amount">
            <UInput id="exp-edit-amount" v-model.number="editForm.amount" type="number" min="0" step="0.01" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Date" html-for="exp-edit-date">
            <UInput id="exp-edit-date" v-model="editForm.expenseDate" type="date" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Note" html-for="exp-edit-note">
            <UInput id="exp-edit-note" v-model="editForm.note" class="w-full" />
          </UiLabeledField>
          <div class="mt-2 flex justify-end gap-2">
            <UButton color="neutral" variant="soft" @click="closeEdit">Cancel</UButton>
            <UButton icon="i-lucide-save" :loading="saving" @click="updateExpense">Save changes</UButton>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="deleteConfirmOpen && deleteTarget"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="cancelDelete"
    >
      <div class="w-full max-w-md rounded-xl bg-white p-4 shadow-2xl dark:bg-slate-900">
        <h3 class="mb-2 text-lg font-semibold text-slate-900 dark:text-slate-100">Delete expense?</h3>
        <p class="text-sm text-slate-600 dark:text-slate-300">
          Remove {{ EXPENSE_TYPE_LABELS[deleteTarget.expense_type] }} ·
          {{ categoryLabel(deleteTarget.expense_type, deleteTarget.category) }} ·
          {{ fmtPkr(Number(deleteTarget.amount)) }} on {{ formatDate(deleteTarget.expense_date) }}?
          Business and charity entries will also be removed from the ledger.
        </p>
        <div class="mt-4 flex justify-end gap-2">
          <UButton color="neutral" variant="soft" @click="cancelDelete">Cancel</UButton>
          <UButton color="error" icon="i-lucide-trash-2" :loading="deleting" @click="confirmDelete">Delete</UButton>
        </div>
      </div>
    </div>
  </section>
</template>
