export type PosPaymentMethod = 'cash' | 'card' | 'qr' | 'wallet' | 'bank'

export type PosSessionSnapshot = {
  orderId: string | null
  orderStatus: 'draft' | 'held' | 'posted'
  invoiceId: string | null
  postedInvoiceTotal: number | null
  paymentMethod: PosPaymentMethod
  paymentAmount: number
  tenderedAmount: number
  selectedCategoryId: string
}

const STORAGE_KEY = 'aone-pos-billing-session'

export function readPosSession(): PosSessionSnapshot | null {
  if (!import.meta.client) return null
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PosSessionSnapshot
    if (!parsed.orderId) return null
    return parsed
  } catch {
    return null
  }
}

export function writePosSession(snapshot: PosSessionSnapshot) {
  if (!import.meta.client) return
  if (!snapshot.orderId) {
    sessionStorage.removeItem(STORAGE_KEY)
    return
  }
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
}

export function clearPosSession() {
  if (!import.meta.client) return
  sessionStorage.removeItem(STORAGE_KEY)
}
