/** Normalize Nuxt UI select v-model (sometimes the full `{ label, value }` item). */
export function selectToPrimitive(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined
  if (typeof val === 'string') return val.trim()
  if (typeof val === 'number' || typeof val === 'boolean') return String(val)
  if (typeof val === 'object' && val !== null && 'value' in val) {
    const inner = (val as { value: unknown }).value
    if (inner === null || inner === undefined) return undefined
    return typeof inner === 'string' ? inner.trim() : String(inner).trim()
  }
  return undefined
}
