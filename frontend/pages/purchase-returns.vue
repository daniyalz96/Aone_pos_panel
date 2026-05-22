<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ApiError, useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'

type InvoiceLine = {
  id: string
  product_id: string
  product_name?: string
  sku?: string
  qty: string | number
  qty_returned?: string | number
  unit_cost: string | number
  line_total: string | number
}

type InvoiceDetail = {
  id: string
  invoice_number: string
  status: string
  supplier_name?: string
  company_name?: string
  lines?: InvoiceLine[]
}

const { request } = useApi()
const { user } = useAuth()

const canManage = () => {
  const u = user.value
  if (!u) return false
  return (u.permissions ?? []).includes('manage_inventory') || (u.roles ?? []).some((r) => ['admin', 'manager'].includes(r))
}

const invoices = ref<InvoiceDetail[]>([])
const selectedInvoiceId = ref('')
const invoiceDetail = ref<InvoiceDetail | null>(null)
const returnLines = ref<
  Array<{ lineId: string; productName: string; sku: string; ordered: number; alreadyReturned: number; max: number; qty: number }>
>([])
const reasonCode = ref<'damaged' | 'wrong_item' | 'overstock' | 'invoice_error' | 'other'>('damaged')
const notes = ref('')
const errorMessage = ref('')
const busy = ref(false)

const eligible = computed(() =>
  invoices.value.filter((i) => i.status === 'posted' || i.status === 'partially_returned'),
)

const loadInvoices = async () => {
  errorMessage.value = ''
  try {
    const rows = await request<InvoiceDetail[]>('/procurement/purchase-invoices?limit=200')
    invoices.value = rows
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Failed to load invoices'
  }
}

const loadDetail = async (id: string) => {
  if (!id) {
    invoiceDetail.value = null
    returnLines.value = []
    return
  }
  try {
    const d = await request<InvoiceDetail>(`/procurement/purchase-invoices/${id}`)
    invoiceDetail.value = d
    returnLines.value = (d.lines ?? []).map((l) => {
      const qty = Number(l.qty)
      const ret = Number(l.qty_returned ?? 0)
      return {
        lineId: l.id,
        productName: l.product_name ?? '',
        sku: l.sku ?? '',
        ordered: qty,
        alreadyReturned: ret,
        max: Math.max(0, qty - ret),
        qty: 0
      }
    })
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Failed to load invoice'
  }
}

const submitReturn = async () => {
  if (!canManage() || !selectedInvoiceId.value) return
  const lines = returnLines.value
    .filter((r) => r.qty > 0)
    .map((r) => ({ purchaseInvoiceLineId: r.lineId, qtyReturned: r.qty }))
  if (!lines.length) {
    errorMessage.value = 'Enter a return quantity on at least one line.'
    return
  }
  busy.value = true
  errorMessage.value = ''
  try {
    await request('/procurement/purchase-returns', {
      method: 'POST',
      body: {
        purchaseInvoiceId: selectedInvoiceId.value,
        reasonCode: reasonCode.value,
        notes: notes.value.trim() || undefined,
        lines
      }
    })
    notes.value = ''
    await loadInvoices()
    await loadDetail(selectedInvoiceId.value)
  } catch (e: unknown) {
    errorMessage.value = e instanceof ApiError ? e.message : 'Return failed'
  } finally {
    busy.value = false
  }
}

onMounted(loadInvoices)

watch(selectedInvoiceId, (id) => {
  void loadDetail(id)
})
</script>

<template>
  <section class="space-y-6">
    <div>
      <h1 class="text-xl font-semibold text-slate-900 dark:text-slate-100">Purchase returns</h1>
      <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Select a posted invoice, enter returned quantities, and choose a mandatory reason. Inventory and supplier payable update automatically for credit purchases.
      </p>
    </div>

    <UAlert v-if="errorMessage" color="error" variant="soft" :description="errorMessage" icon="i-lucide-triangle-alert" />

    <UCard>
      <div class="grid gap-4 lg:grid-cols-2">
        <div>
          <label class="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Purchase invoice</label>
          <UiSearchableSelect
            v-model="selectedInvoiceId"
            :items="eligible.map((i) => ({ label: `${i.invoice_number} — ${i.company_name || i.supplier_name}`, value: i.id }))"
            placeholder="Search invoice…"
            class="w-full"
          />
          <p v-if="!eligible.length" class="mt-2 text-sm text-slate-500">No posted invoices available.</p>
        </div>
        <div>
          <label class="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Reason code *</label>
          <UiSearchableSelect
            v-model="reasonCode"
            :items="[
              { label: 'Damaged', value: 'damaged' },
              { label: 'Wrong item', value: 'wrong_item' },
              { label: 'Overstock', value: 'overstock' },
              { label: 'Other', value: 'other' },
              { label: 'Invoice error', value: 'invoice_error' }
            ]"
            class="w-full"
          />
          <UiLabeledField label="Notes" html-for="pr-notes" class="mt-3">
            <UInput id="pr-notes" v-model="notes" class="w-full" />
          </UiLabeledField>
        </div>
      </div>

      <div v-if="invoiceDetail?.lines?.length" class="table-scroll mt-6">
        <table class="min-w-full text-left text-sm">
          <thead class="border-b text-xs uppercase text-slate-500">
            <tr>
              <th class="pb-2 pr-4">Product</th>
              <th class="pb-2 pr-4">Ordered</th>
              <th class="pb-2 pr-4">Already returned</th>
              <th class="pb-2 pr-4">Max return</th>
              <th class="pb-2">This return</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="meta in returnLines" :key="meta.lineId" class="border-b border-slate-100 dark:border-slate-800">
              <td class="py-2 pr-4">
                <span class="font-medium">{{ meta.productName }}</span>
                <span class="ml-2 text-xs text-slate-500">{{ meta.sku }}</span>
              </td>
              <td class="py-2 pr-4">{{ meta.ordered }}</td>
              <td class="py-2 pr-4">{{ meta.alreadyReturned }}</td>
              <td class="py-2 pr-4">{{ meta.max }}</td>
              <td class="py-2">
                <UInput
                  v-model.number="meta.qty"
                  type="number"
                  :max="meta.max"
                  class="w-28"
                  :disabled="meta.max <= 0"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <UButton
          v-if="canManage()"
          class="mt-4"
          icon="i-lucide-package-minus"
          :loading="busy"
          @click="submitReturn"
        >
          Post partial return
        </UButton>
      </div>
    </UCard>
  </section>
</template>
