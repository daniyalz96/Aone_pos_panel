<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Pie slices: slice name + value (Rs) */
    series: { name: string; y: number }[]
    /** Optional subtitle above chart (empty = hidden) */
    title?: string
  }>(),
  { title: '' }
)

const hostRef = ref<HTMLDivElement | null>(null)
let chart: { destroy: () => void } | null = null

function sliceData() {
  const raw = props.series.filter((s) => Number(s.y) > 0)
  if (raw.length === 0) {
    return [{ name: 'No data', y: 1 }]
  }
  return raw
}

async function draw() {
  if (!import.meta.client || !hostRef.value) return
  const Highcharts = (await import('highcharts')).default

  if (chart) {
    chart.destroy()
    chart = null
  }

  const data = sliceData()
  const isPlaceholder = data.length === 1 && data[0].name === 'No data'

  chart = Highcharts.chart(hostRef.value, {
    chart: {
      type: 'pie',
      backgroundColor: 'transparent',
      height: 280
    },
    title: { text: undefined },
    credits: { enabled: false },
    tooltip: {
      pointFormat: isPlaceholder ? '{point.name}' : '<b>{point.percentage:.1f}%</b><br/>Rs {point.y:,.0f}'
    },
    plotOptions: {
      pie: {
        allowPointSelect: true,
        cursor: 'pointer',
        dataLabels: {
          enabled: true,
          format: isPlaceholder ? '{point.name}' : '<b>{point.name}</b>: {point.percentage:.1f} %',
          style: { textOutline: 'none', fontWeight: '500', fontSize: '11px' }
        },
        showInLegend: true
      }
    },
    legend: {
      layout: 'horizontal',
      align: 'center',
      verticalAlign: 'bottom',
      itemStyle: { fontSize: '11px' }
    },
    series: [
      {
        type: 'pie',
        name: props.title,
        colorByPoint: true,
        data
      }
    ]
  })
}

onMounted(() => {
  void draw()
})

watch(
  () => props.series,
  () => {
    void draw()
  },
  { deep: true }
)

onUnmounted(() => {
  chart?.destroy()
  chart = null
})
</script>

<template>
  <div>
    <p v-if="title" class="mb-2 text-xs text-slate-500 dark:text-slate-400">{{ title }}</p>
    <div ref="hostRef" class="dashboard-monthly-sales-pie w-full min-h-[280px]" />
  </div>
</template>

<style scoped>
.dashboard-monthly-sales-pie :deep(.highcharts-container) {
  font-family: inherit;
}
</style>
