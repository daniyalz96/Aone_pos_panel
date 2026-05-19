<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { compactRsAxis, dashboardChartBase, tealColumnGradient } from '~/utils/dashboardHighcharts'

export type MonthlyProfitPoint = { label: string; value: number }

const props = defineProps<{
  points: MonthlyProfitPoint[]
}>()

const hostRef = ref<HTMLDivElement | null>(null)
let chart: { destroy: () => void } | null = null

function chartData() {
  const labels = props.points.map((p) => p.label)
  const values = props.points.map((p) => Number(p.value) || 0)
  return { labels, values }
}

async function draw() {
  if (!import.meta.client || !hostRef.value) return
  const Highcharts = (await import('highcharts')).default

  chart?.destroy()
  chart = null

  const { labels, values } = chartData()

  chart = Highcharts.chart(hostRef.value, {
    ...dashboardChartBase,
    chart: {
      type: 'column',
      backgroundColor: 'transparent',
      height: 280,
      spacing: [8, 12, 16, 8]
    },
    xAxis: {
      categories: labels,
      lineColor: '#e2e8f0',
      labels: { style: { fontSize: '11px', color: '#64748b' } }
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
      pointFormat: '<span style="color:#14b8a6">●</span> Gross profit: <b>Rs {point.y:,.0f}</b><br/>'
    },
    plotOptions: {
      column: {
        borderRadius: 6,
        borderWidth: 0,
        color: tealColumnGradient,
        dataLabels: {
          enabled: values.length <= 8,
          crop: false,
          overflow: 'none',
          style: { fontSize: '10px', fontWeight: '600', textOutline: 'none', color: '#0f766e' },
          formatter() {
            return compactRsAxis(Number(this.y))
          }
        }
      }
    },
    series: [
      {
        type: 'column',
        name: 'Gross profit',
        data: values
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
  <div ref="hostRef" class="dashboard-monthly-profit w-full min-h-[280px]" />
</template>

<style scoped>
.dashboard-monthly-profit :deep(.highcharts-container) {
  font-family: inherit;
}
</style>
