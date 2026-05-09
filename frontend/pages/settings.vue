<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useApi } from '~/composables/useApi'

const { request } = useApi()
const errorMessage = ref('')
const branches = ref<Array<{ id: string; code: string; name: string }>>([])
const suppliers = ref<Array<{ id: string; name: string }>>([])
const syncJobs = ref<Array<{ id: string; client_tx_id: string; status: string }>>([])
const conflicts = ref<Array<{ id: string; conflict_type: string; status: string }>>([])

const branchForm = reactive({
  code: '',
  name: '',
  address: ''
})

const supplierForm = reactive({
  name: '',
  phone: '',
  email: ''
})

const loadSettingsData = async () => {
  errorMessage.value = ''
  try {
    const [branchRes, supplierRes, syncRes, conflictRes] = await Promise.all([
      request<Array<{ id: string; code: string; name: string }>>('/branches'),
      request<Array<{ id: string; name: string }>>('/procurement/suppliers'),
      request<Array<{ id: string; client_tx_id: string; status: string }>>('/sync/status?limit=20'),
      request<Array<{ id: string; conflict_type: string; status: string }>>('/sync/conflicts?status=open')
    ])
    branches.value = branchRes
    suppliers.value = supplierRes
    syncJobs.value = syncRes
    conflicts.value = conflictRes
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to load settings data'
  }
}

const createBranch = async () => {
  try {
    await request('/branches', {
      method: 'POST',
      body: {
        code: branchForm.code,
        name: branchForm.name,
        address: branchForm.address || undefined
      }
    })
    branchForm.code = ''
    branchForm.name = ''
    branchForm.address = ''
    await loadSettingsData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to create branch'
  }
}

const createSupplier = async () => {
  try {
    await request('/procurement/suppliers', {
      method: 'POST',
      body: {
        name: supplierForm.name,
        phone: supplierForm.phone || undefined,
        email: supplierForm.email || undefined
      }
    })
    supplierForm.name = ''
    supplierForm.phone = ''
    supplierForm.email = ''
    await loadSettingsData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to create supplier'
  }
}

const runNotificationAutomation = async () => {
  try {
    await request('/notifications/automation/run', {
      method: 'POST',
      body: {}
    })
    await loadSettingsData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to run alert automation'
  }
}

onMounted(async () => {
  await loadSettingsData()
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
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Branch Setup</h2>
        <div class="grid gap-3">
          <UInput v-model="branchForm.code" placeholder="Branch code" />
          <UInput v-model="branchForm.name" placeholder="Branch name" />
          <UInput v-model="branchForm.address" placeholder="Address" />
          <UButton icon="i-lucide-store" @click="createBranch">Create Branch</UButton>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Supplier Setup</h2>
        <div class="grid gap-3">
          <UInput v-model="supplierForm.name" placeholder="Supplier name" />
          <UInput v-model="supplierForm.phone" placeholder="Phone" />
          <UInput v-model="supplierForm.email" placeholder="Email" />
          <UButton icon="i-lucide-truck" @click="createSupplier">Create Supplier</UButton>
        </div>
      </UCard>
    </div>

    <UCard>
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Operational Controls</h2>
        <UButton color="warning" icon="i-lucide-bell-ring" @click="runNotificationAutomation">Run Alert Automation</UButton>
      </div>
      <p class="text-sm text-slate-500">Trigger low-stock, sync-failure, pending-bill, and day-close alerts on demand.</p>
    </UCard>

    <div class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Branches</h2>
        <div class="space-y-2 text-sm">
          <div v-for="branch in branches" :key="branch.id" class="rounded-lg bg-slate-100 p-3 dark:bg-slate-800">
            <p class="font-medium">{{ branch.name }}</p>
            <p class="text-slate-500">Code: {{ branch.code }}</p>
          </div>
          <p v-if="!branches.length" class="text-slate-500">No branches configured.</p>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Suppliers</h2>
        <div class="space-y-2 text-sm">
          <div v-for="supplier in suppliers" :key="supplier.id" class="rounded-lg bg-slate-100 p-3 dark:bg-slate-800">
            <p class="font-medium">{{ supplier.name }}</p>
          </div>
          <p v-if="!suppliers.length" class="text-slate-500">No suppliers configured.</p>
        </div>
      </UCard>
    </div>

    <div class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Recent Sync Jobs</h2>
        <div class="space-y-2 text-sm">
          <div v-for="job in syncJobs" :key="job.id" class="rounded-lg bg-slate-100 p-3 dark:bg-slate-800">
            <p class="font-medium">{{ job.client_tx_id }}</p>
            <p class="text-slate-500">Status: {{ job.status }}</p>
          </div>
          <p v-if="!syncJobs.length" class="text-slate-500">No sync jobs.</p>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Open Sync Conflicts</h2>
        <div class="space-y-2 text-sm">
          <div v-for="conflict in conflicts" :key="conflict.id" class="rounded-lg bg-amber-50 p-3 dark:bg-amber-950/30">
            <p class="font-medium">{{ conflict.conflict_type }}</p>
            <p class="text-slate-500">Status: {{ conflict.status }}</p>
          </div>
          <p v-if="!conflicts.length" class="text-slate-500">No open conflicts.</p>
        </div>
      </UCard>
    </div>
  </section>
</template>
