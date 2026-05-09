<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useApi } from '~/composables/useApi'

const { request } = useApi()
const errorMessage = ref('')
const activeShift = ref<Record<string, unknown> | null>(null)
const dayCloseSummary = ref<Record<string, unknown> | null>(null)

const openForm = reactive({
  openingCash: 0
})

const closeForm = reactive({
  closingCash: 0,
  notes: ''
})

const openShift = async () => {
  errorMessage.value = ''
  try {
    activeShift.value = await request('/shifts/open', {
      method: 'POST',
      body: {
        openingCash: Number(openForm.openingCash)
      }
    })
    dayCloseSummary.value = null
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to open shift'
  }
}

const closeShift = async () => {
  errorMessage.value = ''
  try {
    const closed = await request<Record<string, unknown>>('/shifts/close', {
      method: 'POST',
      body: {
        closingCash: Number(closeForm.closingCash),
        notes: closeForm.notes || undefined
      }
    })
    activeShift.value = null
    if (closed.id) {
      dayCloseSummary.value = await request(`/reports/day-close?shiftId=${closed.id as string}`)
    }
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to close shift'
  }
}
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
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Open Shift</h2>
        <div class="grid gap-3">
          <UInput v-model.number="openForm.openingCash" type="number" placeholder="Opening cash" />
          <UButton icon="i-lucide-play-circle" @click="openShift">Open Shift</UButton>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Close Shift</h2>
        <div class="grid gap-3">
          <UInput v-model.number="closeForm.closingCash" type="number" placeholder="Closing cash" />
          <UTextarea v-model="closeForm.notes" placeholder="Closing notes" />
          <UButton color="warning" icon="i-lucide-stop-circle" @click="closeShift">Close Shift</UButton>
        </div>
      </UCard>
    </div>

    <UCard v-if="activeShift">
      <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Active Shift</h2>
      <pre class="overflow-auto rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-800">{{ activeShift }}</pre>
    </UCard>

    <UCard v-if="dayCloseSummary">
      <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Day Close Summary</h2>
      <pre class="overflow-auto rounded-lg bg-slate-100 p-3 text-xs dark:bg-slate-800">{{ dayCloseSummary }}</pre>
    </UCard>
  </section>
</template>
