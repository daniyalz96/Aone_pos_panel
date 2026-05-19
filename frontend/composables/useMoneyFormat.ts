/** Pakistani Rupee display — use "Rs" (not PKR) across sale/cost and money UI. */
export function formatRs(
  value: unknown,
  options?: { minimumFractionDigits?: number; maximumFractionDigits?: number }
): string {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return 'Rs 0.00'
  return `Rs ${n.toLocaleString(undefined, {
    minimumFractionDigits: options?.minimumFractionDigits ?? 2,
    maximumFractionDigits: options?.maximumFractionDigits ?? 2
  })}`
}
