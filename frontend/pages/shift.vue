<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useApi } from '~/composables/useApi'
import { fieldLabel, formatRecordValue } from '~/utils/recordDisplay'

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

const recordEntries = (record: Record<string, unknown> | null) => {
  if (!record) return [] as Array<{ key: string; label: string; value: string }>
  return Object.entries(record).map(([key, value]) => ({
    key,
    label: fieldLabel(key),
    value: formatRecordValue(value)
  }))
}

const activeShiftEntries = computed(() => recordEntries(activeShift.value))
const dayCloseEntries = computed(() => recordEntries(dayCloseSummary.value))

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
          <UiLabeledField label="Opening cash" html-for="shift-open-cash">
            <UInput id="shift-open-cash" v-model.number="openForm.openingCash" type="number" class="w-full" />
          </UiLabeledField>
          <UButton icon="i-lucide-play-circle" @click="openShift">Open Shift</UButton>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Close Shift</h2>
        <div class="grid gap-3">
          <UiLabeledField label="Closing cash" html-for="shift-close-cash">
            <UInput id="shift-close-cash" v-model.number="closeForm.closingCash" type="number" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Closing notes" html-for="shift-close-notes">
            <UTextarea id="shift-close-notes" v-model="closeForm.notes" class="w-full" />
          </UiLabeledField>
          <UButton color="warning" icon="i-lucide-stop-circle" @click="closeShift">Close Shift</UButton>
        </div>
      </UCard>
    </div>

    <UCard v-if="activeShift">
      <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Active Shift</h2>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <UiDetailField
          v-for="entry in activeShiftEntries"
          :key="entry.key"
          :label="entry.label"
          :value="entry.value"
        />
      </div>
    </UCard>

    <UCard v-if="dayCloseSummary">
      <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Day Close Summary</h2>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <UiDetailField
          v-for="entry in dayCloseEntries"
          :key="entry.key"
          :label="entry.label"
          :value="entry.value"
        />
      </div>
    </UCard>
  </section>
</template>
