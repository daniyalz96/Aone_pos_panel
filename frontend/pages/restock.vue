<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { LOW_STOCK_THRESHOLD } from '~/constants/inventory'

type Balance = {
  product_id: string
  name: string
  sku: string
  barcode: string
  qty_on_hand: number
}

const { request } = useApi()
const lowStock = ref<Balance[]>([])
const products = ref<Array<{ id: string; name: string; sku: string }>>([])
const errorMessage = ref('')

function formatQtyWhole(value: string | number | null | undefined): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString()
}

const stockInForm = reactive({
  productId: '',
  qty: 0,
  unitCost: 0,
  reason: ''
})

const loadData = async () => {
  errorMessage.value = ''
  try {
    const [lowRes, productRes] = await Promise.all([
      request<Balance[]>(`/inventory/low-stock?threshold=${LOW_STOCK_THRESHOLD}`),
      request<Array<{ id: string; name: string; sku: string }>>('/products')
    ])
    lowStock.value = lowRes
    products.value = productRes.map((item) => ({ id: item.id, name: item.name, sku: item.sku }))
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load restock data'
  }
}

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

onMounted(async () => {
  await loadData()
})
</script>

<template>
  <section class="space-y-6">
    <div>
      <h1 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Restock</h1>
      <p class="mt-1 text-sm text-slate-500">Low-stock items and quick stock-in.</p>
    </div>

    <UAlert
      v-if="errorMessage"
      color="error"
      variant="soft"
      :description="errorMessage"
      icon="i-lucide-triangle-alert"
    />

    <div class="grid min-w-0 gap-4 lg:grid-cols-2">
      <UCard class="min-w-0">
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Low Stock</h2>
        <div class="space-y-2">
          <div v-for="item in lowStock" :key="item.product_id" class="grid gap-2 rounded-lg bg-amber-50 p-3 text-sm sm:grid-cols-3 dark:bg-amber-950/30">
            <UiDetailField label="Product" :value="item.name" />
            <UiDetailField label="SKU" :value="item.sku" />
            <UiDetailField label="Qty on hand" :value="formatQtyWhole(item.qty_on_hand)" />
          </div>
          <p v-if="!lowStock.length" class="text-sm text-slate-500">No low stock items.</p>
        </div>
      </UCard>

      <UCard class="min-w-0">
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Stock In</h2>
        <div class="grid gap-3">
          <UiLabeledField label="Product">
            <UiSearchableSelect
              v-model="stockInForm.productId"
              :items="products.map((p) => ({ label: `${p.name} (${p.sku})`, value: p.id }))"
              placeholder="Search product…"
            />
          </UiLabeledField>
          <UiLabeledField label="Quantity" html-for="restock-qty">
            <UInput id="restock-qty" v-model.number="stockInForm.qty" type="number" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Unit cost" html-for="restock-cost">
            <UInput id="restock-cost" v-model.number="stockInForm.unitCost" type="number" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Reason" html-for="restock-reason">
            <UInput id="restock-reason" v-model="stockInForm.reason" class="w-full" />
          </UiLabeledField>
          <UButton icon="i-lucide-arrow-down-to-line" @click="stockIn">Submit Stock In</UButton>
        </div>
      </UCard>
    </div>
  </section>
</template>
