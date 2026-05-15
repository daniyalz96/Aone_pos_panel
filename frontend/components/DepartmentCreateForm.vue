<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ApiError, useApi } from '~/composables/useApi'

const props = defineProps<{
  /** When false, hide actions (e.g. user lacks inventory permission). */
  canManage?: boolean
}>()

const emit = defineEmits<{
  created: []
}>()

const { request } = useApi()

const form = reactive({
  name: ''
})

const saving = ref(false)
const localError = ref('')

const submit = async () => {
  const trimmed = form.name.trim()
  if (!trimmed) {
    localError.value = 'Department name is required.'
    return
  }

  localError.value = ''
  saving.value = true
  try {
    await request('/products/departments', {
      method: 'POST',
      body: { name: trimmed }
    })
    form.name = ''
    emit('created')
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      localError.value = error.message
    } else {
      localError.value = (error as { message?: string }).message ?? 'Failed to create department'
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UCard>
    <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Create Department</h2>
    <p class="mb-3 text-sm text-slate-600 dark:text-slate-400">
      Departments group your catalog; each category can be assigned to one department.
    </p>
    <UAlert
      v-if="localError"
      class="mb-3"
      color="error"
      variant="soft"
      :description="localError"
      icon="i-lucide-triangle-alert"
    />
    <div class="grid gap-3">
      <div class="grid gap-1">
        <label class="text-xs font-medium text-slate-600 dark:text-slate-400" for="dept-name">Department name</label>
        <input
          id="dept-name"
          v-model="form.name"
          type="text"
          name="department-name"
          required
          autocomplete="organization"
          placeholder="retail"
          class="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-primary focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          :disabled="canManage === false || saving"
        />
      </div>
      <UButton
        icon="i-lucide-building-2"
        :loading="saving"
        :disabled="canManage === false"
        @click="submit"
      >
        Save Department
      </UButton>
    </div>
  </UCard>
</template>
