<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { compactRsAxis, dashboardChartBase, indigoBarGradient } from '~/utils/dashboardHighcharts'

export type TopProfitProductPoint = {
  productName: string
  profit: number
}

const props = defineProps<{
  products: TopProfitProductPoint[]
}>()

const hostRef = ref<HTMLDivElement | null>(null)
let chart: { destroy: () => void } | null = null

const sortedProducts = computed(() =>
  [...props.products]
    .map((p) => ({
      productName: String(p.productName ?? '').trim() || 'Unknown product',
      profit: Number(p.profit) || 0
    }))
    .sort((a, b) => b.profit - a.profit)
)

const isEmpty = computed(() => sortedProducts.value.length === 0)

function chartData() {
  const items = sortedProducts.value
  return {
    categories: items.map((p) => p.productName),
    values: items.map((p) => p.profit)
  }
}

async function draw() {
  if (!import.meta.client || !hostRef.value || isEmpty.value) return
  const Highcharts = (await import('highcharts')).default

  chart?.destroy()
  chart = null

  const { categories, values } = chartData()

  chart = Highcharts.chart(hostRef.value, {
    ...dashboardChartBase,
    chart: {
      type: 'column',
      backgroundColor: 'transparent',
      height: 320,
      spacing: [8, 8, 12, 8]
    },
    xAxis: {
      categories,
      crosshair: true,
      lineColor: '#e2e8f0',
      labels: {
        rotation: -35,
        align: 'right',
        style: { fontSize: '10px', color: '#475569', fontWeight: '500' },
        formatter() {
          const text = String(this.value)
          return text.length > 18 ? `${text.slice(0, 16)}…` : text
        }
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
      pointFormat: '<span style="color:#818cf8">●</span> Gross profit: <b>Rs {point.y:,.0f}</b>'
    },
    plotOptions: {
      column: {
        borderRadius: 5,
        borderWidth: 0,
        color: indigoBarGradient,
        dataLabels: {
          enabled: true,
          crop: false,
          overflow: 'none',
          style: { fontSize: '10px', fontWeight: '600', textOutline: 'none', color: '#4338ca' },
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
watch(
  [sortedProducts, isEmpty],
  () => {
    if (isEmpty.value) {
      chart?.destroy()
      chart = null
      return
    }
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
  <div
    v-if="isEmpty"
    class="flex min-h-[320px] items-center justify-center text-sm text-slate-500 dark:text-slate-400"
  >
    No product sales in the last 30 days yet.
  </div>
  <div v-else ref="hostRef" class="dashboard-top-profit-products w-full min-h-[320px]" />
</template>

<style scoped>
.dashboard-top-profit-products :deep(.highcharts-container) {
  font-family: inherit;
}
</style>
