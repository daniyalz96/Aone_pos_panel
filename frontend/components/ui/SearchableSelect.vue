<script setup lang="ts">
import { computed } from 'vue'
import { selectToPrimitive } from '~/composables/useSelectValue'

export type SearchableSelectItem = {
  label: string
  value: string
  [key: string]: unknown
}

const props = withDefaults(
  defineProps<{
    modelValue?: string | null
    items: SearchableSelectItem[]
    placeholder?: string
    disabled?: boolean
    id?: string
    filterFields?: string[]
  }>(),
  {
    placeholder: 'Search…',
    filterFields: () => ['label']
  }
)

const emit = defineEmits<{
  'update:modelValue': [value: string | undefined]
}>()

const internal = computed({
  get: () => props.modelValue ?? undefined,
  set: (v) => emit('update:modelValue', selectToPrimitive(v))
})
</script>

<template>
  <USelectMenu
    :id="id"
    v-model="internal"
    value-key="value"
    label-key="label"
    :items="items"
    :placeholder="placeholder"
    :disabled="disabled"
    :filter-fields="filterFields"
    class="w-full"
    v-bind="$attrs"
  />
</template>
