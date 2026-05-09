<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useApi } from '~/composables/useApi'

type Balance = {
  product_id: string
  name: string
  sku: string
  barcode: string
  qty_on_hand: number
}

const { request } = useApi()
const balances = ref<Balance[]>([])
const lowStock = ref<Balance[]>([])
const products = ref<Array<{ id: string; name: string; sku: string }>>([])
const movements = ref<Array<{ id: string; product_name: string; movement_type: string; qty: number; created_at: string }>>([])
const errorMessage = ref('')

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
  try {
    const [balanceRes, lowRes, productRes, movementRes] = await Promise.all([
      request<Balance[]>('/inventory/balances'),
      request<Balance[]>('/inventory/low-stock'),
      request<Array<{ id: string; name: string; sku: string }>>('/products'),
      request<Array<{ id: string; product_name: string; movement_type: string; qty: number; created_at: string }>>('/inventory/movements')
    ])
    balances.value = balanceRes
    lowStock.value = lowRes
    products.value = productRes.map((item) => ({ id: item.id, name: item.name, sku: item.sku }))
    movements.value = movementRes
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load inventory data'
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
  </section>
</template>
