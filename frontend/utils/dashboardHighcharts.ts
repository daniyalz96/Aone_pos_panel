/** Shared Highcharts styling for POS dashboard charts. */

export function compactRsAxis(value: number): string {
  const v = Number(value)
  if (!Number.isFinite(v)) return '0'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k`
  return String(Math.round(v))
}

export const dashboardChartBase = {
  credits: { enabled: false as const },
  title: { text: undefined },
  accessibility: { enabled: false as const }
}

export const emeraldGradient = {
  linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
  stops: [
    [0, 'rgba(16, 185, 129, 0.45)'] as [number, string],
    [1, 'rgba(16, 185, 129, 0.02)'] as [number, string]
  ]
}

export const tealColumnGradient = {
  linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
  stops: [
    [0, '#2dd4bf'] as [number, string],
    [1, '#0d9488'] as [number, string]
  ]
}

export const emeraldColumnGradient = {
  linearGradient: { x1: 0, y1: 0, x2: 0, y2: 1 },
  stops: [
    [0, '#34d399'] as [number, string],
    [1, '#059669'] as [number, string]
  ]
}

export const indigoBarGradient = {
  linearGradient: { x1: 0, y1: 0, x2: 1, y2: 0 },
  stops: [
    [0, '#818cf8'] as [number, string],
    [1, '#4f46e5'] as [number, string]
  ]
}
