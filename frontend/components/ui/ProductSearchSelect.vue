<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useProductSearch, type ProductSelectItem } from '~/composables/useProductSearch'
import { selectToPrimitive } from '~/composables/useSelectValue'

const props = withDefaults(
  defineProps<{
    modelValue?: string | string[] | null
    placeholder?: string
    disabled?: boolean
    id?: string
    multiple?: boolean
    isActive?: boolean
    supplierId?: string | null
    pinnedItems?: ProductSelectItem[]
    leadingItems?: ProductSelectItem[]
    content?: Record<string, unknown>
    ui?: Record<string, unknown>
    resetSearchTermOnSelect?: boolean
  }>(),
  {
    placeholder: 'Search product…',
    isActive: true,
    resetSearchTermOnSelect: true,
    pinnedItems: () => [],
    leadingItems: () => []
  }
)

const emit = defineEmits<{
  'update:modelValue': [value: string | string[] | undefined]
}>()

const supplierIdRef = computed(() => props.supplierId)
const { items, loading, search, searchImmediate, setPinned, rememberSelected } = useProductSearch({
  isActive: props.isActive,
  supplierId: supplierIdRef
})

const searchTerm = ref('')

const menuItems = computed(() => [...props.leadingItems, ...items.value])

const internal = computed({
  get: () => props.modelValue ?? undefined,
  set: (value) => {
    if (props.multiple) {
      const raw = Array.isArray(value) ? value : value != null ? [value] : []
      const normalized = raw.map((v) => selectToPrimitive(v)).filter((v): v is string => !!v)
      emit('update:modelValue', normalized)
      return
    }
    emit('update:modelValue', selectToPrimitive(value))
  }
})

function selectedIds(): string[] {
  const raw = props.modelValue
  if (props.multiple) {
    if (!Array.isArray(raw)) return []
    return raw.map((v) => selectToPrimitive(v)).filter((v): v is string => typeof v === 'string' && v.length > 0)
  }
  const one = selectToPrimitive(raw)
  return typeof one === 'string' && one.length > 0 ? [one] : []
}

function syncPinnedFromProps() {
  setPinned([...props.pinnedItems])
}

watch(
  () => props.pinnedItems,
  () => syncPinnedFromProps(),
  { immediate: true, deep: true }
)

watch(searchTerm, (term) => {
  search(term)
})

watch(
  () => props.supplierId,
  () => {
    if (searchTerm.value || items.value.length) searchImmediate(searchTerm.value)
  }
)

watch(
  () => props.modelValue,
  () => {
    const ids = new Set(selectedIds())
    if (!ids.size) return
    const selected = menuItems.value.filter((item) => ids.has(item.value))
    rememberSelected(selected)
  },
  { immediate: true }
)

function onOpen(open: boolean) {
  if (open) searchImmediate(searchTerm.value)
}

function onUpdate(value: string | string[] | undefined) {
  const ids = new Set(
    props.multiple
      ? (Array.isArray(value) ? value : []).map((v) => selectToPrimitive(v)).filter((v): v is string => typeof v === 'string')
      : (() => {
          const one = selectToPrimitive(value)
          return typeof one === 'string' && one.length > 0 ? [one] : []
        })()
  )
  if (!ids.size) return
  const selected = menuItems.value.filter((item) => ids.has(item.value))
  rememberSelected(selected)
}
</script>

<template>
  <USelectMenu
    :id="id"
    v-model="internal"
    v-model:search-term="searchTerm"
    :multiple="multiple"
    value-key="value"
    label-key="label"
    :items="menuItems"
    :filter-fields="['label', 'name', 'sku']"
    ignore-filter
    :placeholder="placeholder"
    :disabled="disabled"
    :loading="loading"
    :content="content"
    :ui="ui"
    :reset-search-term-on-select="resetSearchTermOnSelect"
    class="w-full"
    v-bind="$attrs"
    @update:open="onOpen"
    @update:model-value="onUpdate"
  />
</template>
