<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { compactRsAxis, dashboardChartBase, emeraldColumnGradient } from '~/utils/dashboardHighcharts'

export type HourlySalesPoint = { label: string; amount: number }

const props = defineProps<{
  points: HourlySalesPoint[]
}>()

const hostRef = ref<HTMLDivElement | null>(null)
let chart: { destroy: () => void } | null = null

function chartData() {
  const labels = props.points.map((p) => p.label)
  const amounts = props.points.map((p) => Number(p.amount) || 0)
  return { labels, amounts }
}

async function draw() {
  if (!import.meta.client || !hostRef.value) return
  const Highcharts = (await import('highcharts')).default

  chart?.destroy()
  chart = null

  const { labels, amounts } = chartData()

  chart = Highcharts.chart(hostRef.value, {
    ...dashboardChartBase,
    chart: {
      type: 'column',
      backgroundColor: 'transparent',
      height: 300,
      spacing: [8, 12, 16, 8]
    },
    xAxis: {
      categories: labels,
      lineColor: '#e2e8f0',
      labels: {
        style: { fontSize: '10px', color: '#64748b' },
        rotation: labels.length > 12 ? -45 : 0
      }
    },
    yAxis: {
      min: 0,
      title: { text: undefined },
      gridLineColor: '#f1f5f9',
      labels: {
        style: { fontSize: '10px', color: '#94a3b8' },
        formatter() {
          return compactRsAxis(Number(this.value))
        }
      }
    },
    legend: { enabled: false },
    tooltip: {
      useHTML: true,
      borderRadius: 8,
      backgroundColor: 'rgba(15, 23, 42, 0.92)',
      style: { color: '#f8fafc' },
      headerFormat: '<span style="font-size:11px;font-weight:600">{point.key}</span><br/>',
      pointFormat: '<span style="color:#10b981">●</span> Sales: <b>Rs {point.y:,.0f}</b><br/>'
    },
    plotOptions: {
      column: {
        borderRadius: 5,
        borderWidth: 0,
        color: emeraldColumnGradient,
        pointPadding: 0.08,
        groupPadding: 0.12,
        states: {
          hover: { brightness: 0.08 }
        }
      }
    },
    series: [
      {
        type: 'column',
        name: 'Sales',
        data: amounts
      }
    ]
  })
}

onMounted(() => void draw())
watch(() => props.points, () => void draw(), { deep: true })
onUnmounted(() => {
  chart?.destroy()
  chart = null
})
</script>

<template>
  <div ref="hostRef" class="dashboard-hourly-sales w-full min-h-[300px]" />
</template>

<style scoped>
.dashboard-hourly-sales :deep(.highcharts-container) {
  font-family: inherit;
}
</style>
