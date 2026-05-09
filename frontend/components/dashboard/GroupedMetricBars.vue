<script setup lang="ts">
import { computed } from 'vue'

export type MetricPoint = {
  label: string
  primary: number
  secondary: number
}

const props = withDefaults(
  defineProps<{
    points: MetricPoint[]
    primaryLegend?: string
    secondaryLegend?: string
    peakPx?: number
  }>(),
  {
    primaryLegend: 'Sales',
    secondaryLegend: 'Tax',
    peakPx: 120
  }
)

const scaleMax = computed(() =>
  Math.max(
    1,
    ...props.points.flatMap((p) => [Math.abs(p.primary), Math.abs(p.secondary)])
  )
)

function pct(value: number) {
  return `${Math.min(100, Math.round((Math.abs(value) / scaleMax.value) * 100))}%`
}
</script>

<template>
  <div>
  <div class="flex flex-wrap items-end justify-between gap-2 sm:justify-start sm:gap-3 lg:justify-between">
    <div
      v-for="(point, idx) in points"
      :key="`${point.label}-${idx}`"
      class="flex min-w-[3rem] flex-1 flex-col items-center gap-2 sm:flex-initial"
    >
      <div
        class="flex max-w-[3.5rem] items-end justify-center gap-1 px-0.5"
        :style="{ height: `${peakPx}px` }"
      >
        <div
          class="flex h-full w-3 flex-col justify-end overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800"
          :title="`${primaryLegend}: ${point.primary}`"
        >
          <div
            class="w-full rounded-sm bg-emerald-500/90 dark:bg-emerald-400/80"
            :style="{ height: pct(point.primary) }"
          />
        </div>
        <div
          class="flex h-full w-3 flex-col justify-end overflow-hidden rounded-md bg-slate-100 dark:bg-slate-800"
          :title="`${secondaryLegend}: ${point.secondary}`"
        >
          <div
            class="w-full rounded-sm bg-amber-500/90 dark:bg-amber-400/70"
            :style="{ height: pct(point.secondary) }"
          />
        </div>
      </div>
      <p class="max-w-[4rem] truncate text-center text-[10px] font-medium text-slate-500 sm:text-xs dark:text-slate-400">
        {{ point.label }}
      </p>
    </div>
  </div>

  <div class="mt-4 flex flex-wrap gap-4 border-t border-slate-100 pt-3 text-[11px] text-slate-500 dark:border-slate-800 dark:text-slate-400">
    <span class="flex items-center gap-1.5">
      <span class="inline-block size-2 rounded-sm bg-emerald-500/90" /> {{ primaryLegend }}
    </span>
    <span class="flex items-center gap-1.5">
      <span class="inline-block size-2 rounded-sm bg-amber-500/90" /> {{ secondaryLegend }}
    </span>
  </div>
  </div>
</template>
