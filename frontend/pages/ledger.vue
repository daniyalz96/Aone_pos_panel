<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ApiError, useApi } from '~/composables/useApi'

type JournalEntryRow = {
  id: string
  source_type: string
  source_id: string
  memo: string | null
  created_at: string
  created_by: string | null
  created_by_email: string | null
}

type JournalLineRow = {
  id: string
  debit: string | number
  credit: string | number
  memo: string | null
  account_code: string
  account_name: string
  account_type: string
}

type LedgerAccountRow = {
  id: string
  code: string
  name: string
  type: string
  total_debit: number
  total_credit: number
  net_balance: number
}

const ALL_SOURCE_TYPES = '__all__'

const SOURCE_TYPE_OPTIONS = [
  { value: ALL_SOURCE_TYPES, label: 'All types' },
  { value: 'invoice', label: 'Invoice posted (sale)' },
  { value: 'payment', label: 'Payment received' },
  { value: 'refund', label: 'Refund' },
  { value: 'sales_return', label: 'Sales return' },
  { value: 'invoice_void', label: 'Invoice void' },
  { value: 'expense', label: 'Expense (drawer / POS)' }
] as const

const POS_LEDGER_NOTE = [
  {
    title: 'Invoice posted',
    type: 'invoice',
    detail: 'When an order becomes an invoice: receivable ↑, revenue & tax payable ↑.'
  },
  {
    title: 'Payment',
    type: 'payment',
    detail: 'Cash or bank ↑, accounts receivable ↓ (split payments create one journal per tender).'
  },
  {
    title: 'Refund',
    type: 'refund',
    detail: 'Sales return expense ↑, cash ↓.'
  },
  {
    title: 'Sales return',
    type: 'sales_return',
    detail: 'Reverses sale components; refund via cash/bank depending on method.'
  },
  {
    title: 'Void invoice',
    type: 'invoice_void',
    detail: 'Reverses revenue, tax payable, and receivable for cancelled posted invoices.'
  },
  {
    title: 'Expense',
    type: 'expense',
    detail: 'General expense ↑, cash ↓ (e.g. small drawer expenses from POS).'
  }
]

const { request } = useApi()
const errorMessage = ref('')
const forbidMessage = ref('')
const loadingEntries = ref(false)
const loadingAccounts = ref(false)
const activeTab = ref<'journal' | 'accounts'>('journal')

const filters = reactive({
  sourceType: ALL_SOURCE_TYPES,
  from: '',
  to: ''
})

const entries = ref<JournalEntryRow[]>([])
const accountsPayload = ref<{
  accounts: LedgerAccountRow[]
  totals: { debit: number; credit: number; balanced: boolean }
} | null>(null)

const detailOpen = ref(false)
const detailLoading = ref(false)
const detailEntry = ref<Record<string, unknown> | null>(null)
const detailLines = ref<JournalLineRow[]>([])

const currency = (n: number) =>
  `Rs ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const queryEntries = () => {
  const params = new URLSearchParams()
  params.set('limit', '200')
  if (filters.sourceType && filters.sourceType !== ALL_SOURCE_TYPES) params.set('sourceType', filters.sourceType)
  if (filters.from) params.set('from', new Date(filters.from).toISOString())
  if (filters.to) params.set('to', new Date(`${filters.to}T23:59:59.999Z`).toISOString())
  return `?${params.toString()}`
}

const loadEntries = async () => {
  loadingEntries.value = true
  forbidMessage.value = ''
  errorMessage.value = ''
  try {
    entries.value = await request<JournalEntryRow[]>(`/ledger/entries${queryEntries()}`)
  } catch (error: unknown) {
    if (error instanceof ApiError && error.statusCode === 403) {
      forbidMessage.value = 'Your role cannot view the general ledger. Ask an administrator.'
    } else {
      errorMessage.value = error instanceof Error ? error.message : 'Failed to load journal entries'
    }
    entries.value = []
  } finally {
    loadingEntries.value = false
  }
}

const loadAccounts = async () => {
  loadingAccounts.value = true
  forbidMessage.value = ''
  errorMessage.value = ''
  try {
    accountsPayload.value = await request<{
      accounts: LedgerAccountRow[]
      totals: { debit: number; credit: number; balanced: boolean }
    }>('/ledger/accounts')
  } catch (error: unknown) {
    if (error instanceof ApiError && error.statusCode === 403) {
      forbidMessage.value = 'Your role cannot view the general ledger. Ask an administrator.'
    } else {
      errorMessage.value = error instanceof Error ? error.message : 'Failed to load accounts'
    }
    accountsPayload.value = null
  } finally {
    loadingAccounts.value = false
  }
}

const openDetail = async (id: string) => {
  detailOpen.value = true
  detailLoading.value = true
  detailEntry.value = null
  detailLines.value = []
  try {
    const res = await request<{ entry: Record<string, unknown>; lines: JournalLineRow[] }>(`/ledger/entries/${id}`)
    detailEntry.value = res.entry
    detailLines.value = res.lines ?? []
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Could not load entry detail'
    detailOpen.value = false
  } finally {
    detailLoading.value = false
  }
}

const closeDetail = () => {
  detailOpen.value = false
}

const debitSum = computed(() =>
  detailLines.value.reduce((a, row) => a + Number(row.debit), 0)
)
const creditSum = computed(() =>
  detailLines.value.reduce((a, row) => a + Number(row.credit), 0)
)

onMounted(async () => {
  await Promise.all([loadEntries(), loadAccounts()])
})
</script>

<template>
  <section class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-50">Ledger &amp; general journal</h1>
      <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Double-entry audit trail for every posted sale, payment, refund, return, void, and drawer expense linked to POS.
      </p>
    </div>

    <UAlert v-if="forbidMessage" color="warning" variant="soft" :description="forbidMessage" icon="i-lucide-shield-alert" />

    <UAlert
      v-else-if="errorMessage"
      color="error"
      variant="soft"
      :description="errorMessage"
      icon="i-lucide-triangle-alert"
    />

    <UCard>
      <h2 class="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">What the POS writes to the ledger</h2>
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div
          v-for="item in POS_LEDGER_NOTE"
          :key="item.type"
          class="rounded-xl border border-slate-200/80 bg-white/80 p-3 text-sm dark:border-slate-700 dark:bg-slate-900/50"
        >
          <p class="font-medium text-emerald-800 dark:text-emerald-300">{{ item.title }}</p>
          <p class="mt-1 text-slate-600 dark:text-slate-400">{{ item.detail }}</p>
          <code class="mt-2 inline-block rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {{ item.type }}
          </code>
        </div>
      </div>
    </UCard>

    <UCard class="flex flex-wrap gap-2 border-0 bg-transparent p-0 shadow-none ring-0">
      <UButton
        :variant="activeTab === 'journal' ? 'solid' : 'soft'"
        color="primary"
        @click="activeTab = 'journal'; loadEntries()"
      >
        Journal entries
      </UButton>
      <UButton
        :variant="activeTab === 'accounts' ? 'solid' : 'soft'"
        color="primary"
        @click="activeTab = 'accounts'; loadAccounts()"
      >
        Accounts &amp; balances
      </UButton>
    </UCard>

    <UCard v-show="activeTab === 'journal'">
      <div class="flex flex-wrap items-end gap-3 border-b border-slate-100 pb-4 dark:border-slate-800">
        <div class="min-w-[140px]">
          <label class="mb-1 block text-xs font-medium text-slate-500">Source</label>
          <UiSearchableSelect v-model="filters.sourceType" :items="SOURCE_TYPE_OPTIONS" placeholder="Search type…" class="min-w-[220px]" />
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-slate-500">From</label>
          <UInput v-model="filters.from" type="date" class="w-40" />
        </div>
        <div>
          <label class="mb-1 block text-xs font-medium text-slate-500">To</label>
          <UInput v-model="filters.to" type="date" class="w-40" />
        </div>
        <UButton icon="i-lucide-refresh-cw" :loading="loadingEntries" @click="loadEntries">Refresh</UButton>
      </div>

      <div class="overflow-x-auto">
        <table class="mt-4 min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400">
            <tr>
              <th class="px-3 py-2 font-medium">Posted</th>
              <th class="px-3 py-2 font-medium">Type</th>
              <th class="px-3 py-2 font-medium">Memo</th>
              <th class="px-3 py-2 font-medium">Source ID</th>
              <th class="px-3 py-2 font-medium">By</th>
              <th class="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            <tr v-if="loadingEntries">
              <td colspan="6" class="px-3 py-6 text-center text-slate-500">Loading…</td>
            </tr>
            <tr v-for="row in entries" v-else :key="row.id" class="border-b border-slate-100 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900/70">
              <td class="px-3 py-2 whitespace-nowrap text-slate-700 dark:text-slate-300">
                {{ formatDateTime(row.created_at) }}
              </td>
              <td class="px-3 py-2">
                <UBadge variant="soft" color="neutral">{{ row.source_type }}</UBadge>
              </td>
              <td class="max-w-[200px] truncate px-3 py-2 text-slate-600 dark:text-slate-400" :title="row.memo ?? ''">
                {{ row.memo ?? '—' }}
              </td>
              <td class="px-3 py-2 font-mono text-xs text-slate-500">{{ row.source_id }}</td>
              <td class="px-3 py-2 text-slate-600 dark:text-slate-400">{{ row.created_by_email ?? '—' }}</td>
              <td class="px-3 py-2 text-right">
                <UButton size="xs" variant="soft" @click="openDetail(row.id)">View lines</UButton>
              </td>
            </tr>
            <tr v-if="!loadingEntries && !entries.length">
              <td colspan="6" class="px-3 py-6 text-center text-slate-500">No journal entries yet. Post invoices and record payments from the POS to populate the ledger.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <UCard v-show="activeTab === 'accounts'">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p class="text-sm text-slate-600 dark:text-slate-400">
          Lifetime totals across all journals (chart of accounts with posted activity).
        </p>
        <UButton icon="i-lucide-refresh-cw" variant="soft" :loading="loadingAccounts" @click="loadAccounts">Refresh</UButton>
      </div>

      <div v-if="accountsPayload" class="mb-4 flex flex-wrap gap-4 text-sm">
        <div class="rounded-lg bg-slate-100 px-4 py-2 dark:bg-slate-800">
          <UiDetailField label="Total debits" :value="currency(accountsPayload.totals.debit)" />
        </div>
        <div class="rounded-lg bg-slate-100 px-4 py-2 dark:bg-slate-800">
          <UiDetailField label="Total credits" :value="currency(accountsPayload.totals.credit)" />
        </div>
        <UBadge v-if="accountsPayload.totals.balanced" color="success" variant="soft">Books balance</UBadge>
        <UBadge v-else color="error" variant="soft">Debit/credit mismatch — investigate data</UBadge>
      </div>

      <div class="overflow-x-auto">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400">
            <tr>
              <th class="px-3 py-2 font-medium">Code</th>
              <th class="px-3 py-2 font-medium">Account</th>
              <th class="px-3 py-2 font-medium">Type</th>
              <th class="px-3 py-2 font-medium text-right">Debits</th>
              <th class="px-3 py-2 font-medium text-right">Credits</th>
              <th class="px-3 py-2 font-medium text-right">Signed balance</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loadingAccounts">
              <td colspan="6" class="px-3 py-6 text-center text-slate-500">Loading…</td>
            </tr>
            <template v-else>
              <tr v-for="acc in accountsPayload?.accounts ?? []" :key="acc.id" class="border-b border-slate-100 dark:border-slate-800">
                <td class="px-3 py-2 font-mono text-xs">{{ acc.code }}</td>
                <td class="px-3 py-2 font-medium">{{ acc.name }}</td>
                <td class="px-3 py-2 capitalize text-slate-600 dark:text-slate-400">{{ acc.type }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ currency(acc.total_debit) }}</td>
                <td class="px-3 py-2 text-right tabular-nums">{{ currency(acc.total_credit) }}</td>
                <td class="px-3 py-2 text-right font-medium tabular-nums text-slate-800 dark:text-slate-100">
                  {{ currency(acc.net_balance) }}
                </td>
              </tr>
              <tr v-if="!(accountsPayload?.accounts?.length)">
                <td colspan="6" class="px-3 py-6 text-center text-slate-500">No accounts found.</td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </UCard>

    <!-- Entry detail overlay -->
    <Teleport to="body">
      <div
        v-if="detailOpen"
        class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center"
        role="presentation"
        @click.self="closeDetail"
      >
        <div
          class="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-900"
          role="dialog"
          aria-modal="true"
        >
          <div class="flex items-start justify-between gap-4">
            <div>
              <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-50">Journal entry</h2>
              <div v-if="detailEntry" class="mt-2 grid gap-2 sm:grid-cols-3">
                <UiDetailField label="Posted" :value="formatDateTime(detailEntry.created_at)" />
                <UiDetailField label="Type" :value="String(detailEntry.source_type)" />
                <UiDetailField label="Memo" :value="detailEntry.memo ? String(detailEntry.memo) : '—'" />
              </div>
            </div>
            <UButton variant="ghost" color="neutral" icon="i-lucide-x" aria-label="Close" @click="closeDetail" />
          </div>

          <div v-if="detailLoading" class="py-12 text-center text-slate-500">Loading lines…</div>

          <div v-else class="mt-4 overflow-x-auto">
            <table class="min-w-full text-left text-sm">
              <thead class="border-b border-slate-200 dark:border-slate-700">
                <tr class="text-slate-600 dark:text-slate-400">
                  <th class="px-2 py-2 font-medium">Account</th>
                  <th class="px-2 py-2 font-medium">Type</th>
                  <th class="px-2 py-2 font-medium text-right">Debit</th>
                  <th class="px-2 py-2 font-medium text-right">Credit</th>
                  <th class="px-2 py-2 font-medium">Line memo</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="line in detailLines" :key="line.id" class="border-b border-slate-100 dark:border-slate-800">
                  <td class="px-2 py-2">
                    <span class="font-mono text-xs text-slate-500">{{ line.account_code }}</span>
                    {{ line.account_name }}
                  </td>
                  <td class="px-2 py-2 capitalize text-slate-500">{{ line.account_type }}</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ Number(line.debit) > 0 ? currency(Number(line.debit)) : '—' }}</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ Number(line.credit) > 0 ? currency(Number(line.credit)) : '—' }}</td>
                  <td class="max-w-[180px] truncate px-2 py-2 text-slate-500" :title="line.memo ?? ''">{{ line.memo ?? '—' }}</td>
                </tr>
              </tbody>
              <tfoot class="border-t-2 border-slate-300 font-semibold dark:border-slate-600">
                <tr>
                  <td colspan="2" class="px-2 py-2">Totals</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ currency(debitSum) }}</td>
                  <td class="px-2 py-2 text-right tabular-nums">{{ currency(creditSum) }}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          <div class="mt-4 flex justify-end">
            <UButton variant="soft" color="neutral" @click="closeDetail">Close</UButton>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
