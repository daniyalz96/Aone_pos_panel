<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useApi } from '~/composables/useApi'

const { request } = useApi()
const errorMessage = ref('')
const branches = ref<Array<{ id: string; code: string; name: string }>>([])
const syncJobs = ref<Array<{ id: string; client_tx_id: string; status: string }>>([])
const conflicts = ref<Array<{ id: string; conflict_type: string; status: string }>>([])

const branchForm = reactive({
  code: '',
  name: '',
  address: ''
})

const loadSettingsData = async () => {
  errorMessage.value = ''
  try {
    const [branchRes, syncRes, conflictRes] = await Promise.all([
      request<Array<{ id: string; code: string; name: string }>>('/branches'),
      request<Array<{ id: string; client_tx_id: string; status: string }>>('/sync/status?limit=20'),
      request<Array<{ id: string; conflict_type: string; status: string }>>('/sync/conflicts?status=open')
    ])
    branches.value = branchRes
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

    <UCard>
      <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Branch Setup</h2>
      <div class="grid gap-3 sm:max-w-md">
        <UiLabeledField label="Branch code" html-for="branch-code" required>
          <UInput id="branch-code" v-model="branchForm.code" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Branch name" html-for="branch-name" required>
          <UInput id="branch-name" v-model="branchForm.name" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Address" html-for="branch-address">
          <UInput id="branch-address" v-model="branchForm.address" class="w-full" />
        </UiLabeledField>
        <UButton icon="i-lucide-store" @click="createBranch">Create Branch</UButton>
      </div>
    </UCard>

    <UCard>
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Operational Controls</h2>
        <UButton color="warning" icon="i-lucide-bell-ring" @click="runNotificationAutomation">Run Alert Automation</UButton>
      </div>
      <p class="text-sm text-slate-500">Trigger low-stock, sync-failure, pending-bill, and day-close alerts on demand.</p>
    </UCard>

    <UCard>
      <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Branches</h2>
      <div class="space-y-2 text-sm">
        <div v-for="branch in branches" :key="branch.id" class="grid gap-2 rounded-lg bg-slate-100 p-3 sm:grid-cols-2 dark:bg-slate-800">
          <UiDetailField label="Name" :value="branch.name" />
          <UiDetailField label="Code" :value="branch.code" />
        </div>
        <p v-if="!branches.length" class="text-slate-500">No branches configured.</p>
      </div>
    </UCard>

    <div class="grid gap-4 lg:grid-cols-2">
      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Recent Sync Jobs</h2>
        <div class="space-y-2 text-sm">
          <div v-for="job in syncJobs" :key="job.id" class="grid gap-2 rounded-lg bg-slate-100 p-3 sm:grid-cols-2 dark:bg-slate-800">
            <UiDetailField label="Client transaction ID" :value="job.client_tx_id" />
            <UiDetailField label="Status" :value="job.status" />
          </div>
          <p v-if="!syncJobs.length" class="text-slate-500">No sync jobs.</p>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Open Sync Conflicts</h2>
        <div class="space-y-2 text-sm">
          <div v-for="conflict in conflicts" :key="conflict.id" class="grid gap-2 rounded-lg bg-amber-50 p-3 sm:grid-cols-2 dark:bg-amber-950/30">
            <UiDetailField label="Type" :value="conflict.conflict_type" />
            <UiDetailField label="Status" :value="conflict.status" />
          </div>
          <p v-if="!conflicts.length" class="text-slate-500">No open conflicts.</p>
        </div>
      </UCard>
    </div>
  </section>
</template>
