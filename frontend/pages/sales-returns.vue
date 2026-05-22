<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ApiError, useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'
import { useTodayOverview } from '~/composables/useTodayOverview'

type SaleInvoiceListRow = {
  id: string
  invoice_number: string
  created_at: string
  total_amount: string | number
  invoice_status: string
  customer_name: string | null
  branch_name: string | null
}

type ReturnLineDetail = {
  id: string
  productName: string
  sku: string
  qty: number
  qtyReturned: number
  maxReturn: number
  unitPrice: number
}

type InvoiceReturnDetail = {
  id: string
  invoiceNumber: string
  invoiceStatus: string
  paymentStatus: string
  totalAmount: number
  returnTotal: number
  customerName: string | null
  branchName: string | null
  cashierName: string | null
  lines: ReturnLineDetail[]
}

type LineReturnStatus = 'not_returned' | 'partially_returned' | 'fully_returned'

const route = useRoute()
const router = useRouter()
const { request } = useApi()
const { user } = useAuth()
const { refreshTodayOverview } = useTodayOverview()

const canReturn = computed(() => {
  const u = user.value
  if (!u) return false
  if ((u.permissions ?? []).includes('refund_approve')) return true
  return (u.roles ?? []).some((r) => r === 'admin' || r === 'manager')
})

const invoices = ref<SaleInvoiceListRow[]>([])
const selectedInvoiceId = ref('')
const invoiceDetail = ref<InvoiceReturnDetail | null>(null)
const returnLines = ref<
  Array<{
    lineId: string
    productName: string
    sku: string
    sold: number
    alreadyReturned: number
    max: number
    qty: number
    status: LineReturnStatus
  }>
>([])
const reason = ref('')
const refundMethod = ref<'cash' | 'bank' | 'card' | 'wallet' | 'qr'>('cash')
const errorMessage = ref('')
const busy = ref(false)

const eligible = computed(() =>
  invoices.value.filter((i) => i.invoice_status !== 'voided' && i.invoice_status !== 'returned'),
)

const refundMethodItems = [
  { label: 'Cash', value: 'cash' },
  { label: 'Bank', value: 'bank' },
  { label: 'Card', value: 'card' },
  { label: 'Wallet', value: 'wallet' },
  { label: 'QR', value: 'qr' }
]

function lineReturnStatus(sold: number, alreadyReturned: number, maxReturn: number): LineReturnStatus {
  if (maxReturn <= 0 || alreadyReturned >= sold) return 'fully_returned'
  if (alreadyReturned > 0) return 'partially_returned'
  return 'not_returned'
}

function lineStatusLabel(status: LineReturnStatus): string {
  if (status === 'fully_returned') return 'Fully returned'
  if (status === 'partially_returned') return 'Partially returned'
  return 'Not returned'
}

function lineStatusBadgeColor(status: LineReturnStatus): 'neutral' | 'warning' | 'success' {
  if (status === 'fully_returned') return 'success'
  if (status === 'partially_returned') return 'warning'
  return 'neutral'
}

const loadInvoices = async () => {
  errorMessage.value = ''
  try {
    const to = new Date()
    const from = new Date()
    from.setMonth(from.getMonth() - 3)
    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      limit: '200',
      offset: '0'
    })
    const res = await request<{ rows: SaleInvoiceListRow[] }>(`/reports/sale-invoices?${params}`)
    invoices.value = res.rows ?? []
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Failed to load sale invoices'
  }
}

const loadDetail = async (id: string) => {
  if (!id) {
    invoiceDetail.value = null
    returnLines.value = []
    return
  }
  try {
    const d = await request<InvoiceReturnDetail>(`/returns/invoice/${id}/detail`)
    invoiceDetail.value = d
    returnLines.value = (d.lines ?? []).map((l) => {
      const sold = l.qty
      const alreadyReturned = l.qtyReturned
      const max = l.maxReturn
      return {
        lineId: l.id,
        productName: l.productName,
        sku: l.sku,
        sold,
        alreadyReturned,
        max,
        qty: 0,
        status: lineReturnStatus(sold, alreadyReturned, max)
      }
    })
    errorMessage.value = ''
  } catch (e: unknown) {
    invoiceDetail.value = null
    returnLines.value = []
    errorMessage.value = e instanceof ApiError ? e.message : 'Failed to load invoice'
  }
}

const submitReturn = async () => {
  if (!canReturn.value || !selectedInvoiceId.value) return
  const trimmedReason = reason.value.trim()
  if (trimmedReason.length < 3) {
    errorMessage.value = 'Enter a return reason (at least 3 characters).'
    return
  }
  const items = returnLines.value
    .filter((r) => r.qty > 0)
    .map((r) => ({ invoiceItemId: r.lineId, qty: r.qty }))
  if (!items.length) {
    errorMessage.value = 'Enter a return quantity on at least one line.'
    return
  }
  busy.value = true
  errorMessage.value = ''
  try {
    await request('/returns', {
      method: 'POST',
      body: {
        invoiceId: selectedInvoiceId.value,
        reason: trimmedReason,
        refundMethod: refundMethod.value,
        items
      }
    })
    reason.value = ''
    await loadInvoices()
    await loadDetail(selectedInvoiceId.value)
    await refreshTodayOverview()
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Return failed'
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  await loadInvoices()
  const preselect = typeof route.query.invoiceId === 'string' ? route.query.invoiceId : ''
  if (preselect) selectedInvoiceId.value = preselect
})

watch(selectedInvoiceId, (id) => {
  void loadDetail(id)
})

watch(
  () => route.query.invoiceId,
  (id) => {
    if (typeof id === 'string' && id && id !== selectedInvoiceId.value) {
      selectedInvoiceId.value = id
    }
  },
)
</script>

<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Sale invoice returns</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Return items from a posted sale invoice. Stock is restored and a refund is recorded in the ledger.
        </p>
      </div>
      <UButton variant="soft" color="neutral" icon="i-lucide-arrow-left" @click="router.push('/reports')">
        Back to reports
      </UButton>
    </div>

    <UAlert
      v-if="!canReturn"
      color="warning"
      variant="soft"
      title="Permission required"
      description="Sale returns require admin/manager access or refund approval permission."
      icon="i-lucide-shield-alert"
    />

    <UAlert v-if="errorMessage" color="error" variant="soft" :description="errorMessage" icon="i-lucide-triangle-alert" />

    <UCard>
      <div class="grid gap-4 lg:grid-cols-2">
        <div>
          <label class="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Sale invoice</label>
          <UiSearchableSelect
            v-model="selectedInvoiceId"
            :items="
              eligible.map((i) => ({
                label: `${i.invoice_number} — ${i.customer_name ?? 'Walk-in'} · ${new Date(i.created_at).toLocaleDateString()}`,
                value: i.id
              }))
            "
            placeholder="Search invoice…"
            class="w-full"
          />
          <p v-if="!eligible.length" class="mt-2 text-sm text-slate-500">No invoices available for return.</p>
          <p v-else-if="invoiceDetail" class="mt-2 text-xs text-slate-500">
            Status: {{ invoiceDetail.invoiceStatus }} · Returned so far: Rs
            {{ Number(invoiceDetail.returnTotal).toLocaleString() }}
          </p>
        </div>
        <div class="space-y-3">
          <div>
            <label class="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Refund method</label>
            <UiSearchableSelect v-model="refundMethod" :items="refundMethodItems" class="w-full" />
          </div>
          <UiLabeledField label="Return reason *" html-for="sr-reason">
            <UInput
              id="sr-reason"
              v-model="reason"
              placeholder="e.g. Wrong item, damaged goods"
              class="w-full"
              :disabled="!canReturn"
            />
          </UiLabeledField>
        </div>
      </div>

      <div v-if="invoiceDetail?.lines?.length" class="table-scroll mt-6">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b text-xs uppercase text-slate-500">
            <tr>
              <th class="pb-2 pr-4">Product</th>
              <th class="pb-2 pr-4">Status</th>
              <th class="pb-2 pr-4">Sold</th>
              <th class="pb-2 pr-4">Already returned</th>
              <th class="pb-2 pr-4">Max return</th>
              <th class="pb-2">This return</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="meta in returnLines" :key="meta.lineId" class="border-b border-slate-100 dark:border-slate-800">
              <td class="py-2 pr-4">
                <span class="font-medium">{{ meta.productName }}</span>
                <span v-if="meta.sku" class="ml-2 text-xs text-slate-500">{{ meta.sku }}</span>
              </td>
              <td class="py-2 pr-4">
                <UBadge variant="soft" :color="lineStatusBadgeColor(meta.status)">
                  {{ lineStatusLabel(meta.status) }}
                </UBadge>
              </td>
              <td class="py-2 pr-4">{{ meta.sold }}</td>
              <td class="py-2 pr-4">{{ meta.alreadyReturned }}</td>
              <td class="py-2 pr-4">{{ meta.max }}</td>
              <td class="py-2">
                <UInput
                  v-model.number="meta.qty"
                  type="number"
                  min="0"
                  :max="meta.max"
                  step="0.001"
                  class="w-28"
                  :disabled="!canReturn || meta.max <= 0"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <UButton
          v-if="canReturn"
          class="mt-4"
          icon="i-lucide-undo-2"
          color="primary"
          :loading="busy"
          @click="submitReturn"
        >
          Post sale return
        </UButton>
      </div>
    </UCard>
  </section>
</template>
