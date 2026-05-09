<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    points: Array<{ label: string; value: number }>
    peakPx?: number
  }>(),
  { peakPx: 100 }
)

const scaleMax = computed(() => Math.max(1, ...props.points.map((p) => Math.abs(p.value))))

function heightPx(value: number) {
  return `${Math.max(8, Math.round((Math.abs(value) / scaleMax.value) * props.peakPx))}px`
}
</script>

<template>
  <div>
    <div v-if="points.length" class="flex min-h-[8rem] items-end justify-between gap-1 px-1 sm:gap-2">
      <div v-for="(p, idx) in points" :key="`${p.label}-${idx}`" class="flex min-w-0 flex-1 flex-col items-center gap-2">
        <div
          class="w-full max-w-10 rounded-t-md bg-gradient-to-t from-teal-700/90 to-teal-500/80 dark:from-teal-600/80 dark:to-teal-400/70"
          :style="{ height: heightPx(p.value) }"
          :title="`${p.label}: ${p.value}`"
        />
        <span class="max-w-full truncate text-center text-[10px] font-medium text-slate-500 sm:text-xs dark:text-slate-400">
          {{ p.label }}
        </span>
      </div>
    </div>
    <p v-else class="py-8 text-center text-sm text-slate-500">No trend data for this range.</p>
  </div>
</template>
