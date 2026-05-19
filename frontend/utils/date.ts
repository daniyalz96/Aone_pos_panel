const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric'
}

const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
}

const MONTH_OPTS: Intl.DateTimeFormatOptions = {
  month: 'long',
  year: 'numeric'
}

function parseDateInput(value: unknown): Date | null {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  const s = String(value).trim()
  if (!s) return null

  // Calendar date without time — parse as local midnight (avoids UTC day shift).
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number)
    return new Date(y, m - 1, d)
  }

  const parsed = new Date(s)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** e.g. 19 May 2026 */
export function formatDate(value: unknown, fallback = '—'): string {
  const d = parseDateInput(value)
  if (!d) return fallback
  return d.toLocaleDateString(undefined, DATE_OPTS)
}

/** e.g. 19 May 2026, 2:30 pm */
export function formatDateTime(value: unknown, fallback = '—'): string {
  const d = parseDateInput(value)
  if (!d) return fallback
  return d.toLocaleString(undefined, DATETIME_OPTS)
}

/** e.g. May 2026 from `2026-05` or ISO timestamps */
export function formatMonth(value: unknown, fallback = '—'): string {
  if (value == null || value === '') return fallback
  const s = String(value).trim()
  const ym = /^(\d{4})-(\d{1,2})$/.exec(s)
  if (ym) {
    const y = Number(ym[1])
    const m = Number(ym[2])
    if (m >= 1 && m <= 12) {
      return new Date(y, m - 1, 1).toLocaleDateString(undefined, MONTH_OPTS)
    }
  }
  return formatDate(value, fallback)
}
