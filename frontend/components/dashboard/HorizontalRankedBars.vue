<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  items: Array<{ label: string; value: number }>
  valuePrefix?: string
}>()

const maxVal = computed(() => Math.max(1, ...props.items.map((i) => Math.abs(i.value))))

function pct(value: number) {
  return `${Math.round((Math.abs(value) / maxVal.value) * 100)}%`
}
</script>

<template>
  <div class="space-y-3">
    <div v-for="(item, idx) in items" :key="`${item.label}-${idx}`" class="flex items-center gap-2 sm:gap-3">
      <p class="w-28 shrink-0 truncate text-xs font-medium text-slate-700 dark:text-slate-200" :title="item.label">
        {{ item.label }}
      </p>
      <div class="relative h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div
          class="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 dark:from-indigo-400 dark:to-violet-400"
          :style="{ width: pct(item.value) }"
        />
      </div>
      <p class="w-24 shrink-0 text-right text-xs tabular-nums text-slate-600 dark:text-slate-400">
        {{ valuePrefix }}{{ typeof item.value === 'number' ? item.value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : item.value }}
      </p>
    </div>
    <p v-if="!items.length" class="text-sm text-slate-500">No data yet.</p>
  </div>
</template>
