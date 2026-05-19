<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useApi } from '~/composables/useApi'

type Customer = {
  id: string
  name: string
  phone: string | null
  email: string | null
  loyalty_points: number
}

const { request } = useApi()
const customers = ref<Customer[]>([])
const errorMessage = ref('')
const search = ref('')

const createForm = reactive({
  name: '',
  phone: '',
  email: '',
  isWalkIn: false
})

const loyaltyForm = reactive({
  customerId: '',
  pointsDelta: 0,
  note: ''
})

const loadCustomers = async () => {
  errorMessage.value = ''
  try {
    const endpoint = search.value ? `/customers?q=${encodeURIComponent(search.value)}` : '/customers'
    customers.value = await request<Customer[]>(endpoint)
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load customers'
  }
}

const createCustomer = async () => {
  try {
    await request('/customers', {
      method: 'POST',
      body: {
        name: createForm.name,
        phone: createForm.phone || undefined,
        email: createForm.email || undefined,
        isWalkIn: createForm.isWalkIn
      }
    })
    createForm.name = ''
    createForm.phone = ''
    createForm.email = ''
    createForm.isWalkIn = false
    await loadCustomers()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to create customer'
  }
}

const updateLoyalty = async () => {
  try {
    await request(`/customers/${loyaltyForm.customerId}/loyalty`, {
      method: 'PATCH',
      body: {
        pointsDelta: Number(loyaltyForm.pointsDelta),
        note: loyaltyForm.note || undefined
      }
    })
    loyaltyForm.customerId = ''
    loyaltyForm.pointsDelta = 0
    loyaltyForm.note = ''
    await loadCustomers()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to update loyalty'
  }
}

onMounted(async () => {
  await loadCustomers()
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
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Create Customer</h2>
        <div class="grid gap-3">
          <UiLabeledField label="Name" html-for="cust-create-name" required>
            <UInput id="cust-create-name" v-model="createForm.name" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Phone" html-for="cust-create-phone">
            <UInput id="cust-create-phone" v-model="createForm.phone" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Email" html-for="cust-create-email">
            <UInput id="cust-create-email" v-model="createForm.email" type="email" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Walk-in customer">
            <UCheckbox v-model="createForm.isWalkIn" />
          </UiLabeledField>
          <UButton icon="i-lucide-user-plus" @click="createCustomer">Save Customer</UButton>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Adjust Loyalty Points</h2>
        <div class="grid gap-3">
          <UiLabeledField label="Customer">
            <UiSearchableSelect
              v-model="loyaltyForm.customerId"
              :items="customers.map((c) => ({ label: `${c.name} (${c.loyalty_points} pts)`, value: c.id }))"
              placeholder="Search customer…"
            />
          </UiLabeledField>
          <UiLabeledField label="Points delta" html-for="cust-loyalty-delta">
            <UInput id="cust-loyalty-delta" v-model.number="loyaltyForm.pointsDelta" type="number" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Note" html-for="cust-loyalty-note">
            <UInput id="cust-loyalty-note" v-model="loyaltyForm.note" class="w-full" />
          </UiLabeledField>
          <UButton color="secondary" icon="i-lucide-award" @click="updateLoyalty">Update Loyalty</UButton>
        </div>
      </UCard>
    </div>

    <UCard>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Customers</h2>
        <div class="flex flex-wrap items-end gap-2">
          <UiLabeledField label="Search" html-for="cust-search" class="min-w-[12rem] flex-1">
            <UInput id="cust-search" v-model="search" icon="i-lucide-search" class="w-full" />
          </UiLabeledField>
          <UButton color="neutral" variant="soft" icon="i-lucide-refresh-cw" @click="loadCustomers">Refresh</UButton>
        </div>
      </div>

      <div class="overflow-auto">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th class="px-3 py-2">Name</th>
              <th class="px-3 py-2">Phone</th>
              <th class="px-3 py-2">Email</th>
              <th class="px-3 py-2">Loyalty</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="customer in customers" :key="customer.id" class="border-b border-slate-100 dark:border-slate-800">
              <td class="px-3 py-2">{{ customer.name }}</td>
              <td class="px-3 py-2">{{ customer.phone || '-' }}</td>
              <td class="px-3 py-2">{{ customer.email || '-' }}</td>
              <td class="px-3 py-2">{{ customer.loyalty_points }}</td>
            </tr>
            <tr v-if="!customers.length">
              <td class="px-3 py-4 text-slate-500" colspan="4">No customers found.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>
  </section>
</template>
