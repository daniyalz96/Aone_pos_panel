<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { compactRsAxis, dashboardChartBase } from '~/utils/dashboardHighcharts'

export type MonthlyProfitPoint = {
  label: string
  profit: number
  expenses: number
}

const props = defineProps<{
  points: MonthlyProfitPoint[]
}>()

const hostRef = ref<HTMLDivElement | null>(null)
let chart: { destroy: () => void } | null = null

function chartData() {
  const labels = props.points.map((p) => p.label)
  const profit = props.points.map((p) => Number(p.profit) || 0)
  const expenses = props.points.map((p) => Number(p.expenses) || 0)
  return { labels, profit, expenses }
}

async function draw() {
  if (!import.meta.client || !hostRef.value) return
  const Highcharts = (await import('highcharts')).default

  chart?.destroy()
  chart = null

  const { labels, profit, expenses } = chartData()

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
    legend: {
      align: 'center',
      verticalAlign: 'bottom',
      itemStyle: { fontSize: '11px', color: '#64748b' }
    },
    tooltip: {
      shared: true,
      useHTML: true,
      borderRadius: 8,
      backgroundColor: 'rgba(15, 23, 42, 0.92)',
      style: { color: '#f8fafc' },
      headerFormat: '<span style="font-size:11px;font-weight:600">{point.key}</span><br/>',
      pointFormat:
        '<span style="color:{series.color}">●</span> {series.name}: <b>Rs {point.y:,.0f}</b><br/>'
    },
    plotOptions: {
      column: {
        borderRadius: 6,
        borderWidth: 0,
        groupPadding: 0.12,
        pointPadding: 0.05
      }
    },
    series: [
      {
        type: 'column',
        name: 'Gross profit',
        data: profit,
        color: '#14b8a6'
      },
      {
        type: 'column',
        name: 'Expenses',
        data: expenses,
        color: '#f59e0b'
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
  <div ref="hostRef" class="dashboard-monthly-profit w-full min-h-[300px]" />
</template>

<style scoped>
.dashboard-monthly-profit :deep(.highcharts-container) {
  font-family: inherit;
}
</style>
