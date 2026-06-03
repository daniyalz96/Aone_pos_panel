import { ref, type Ref } from 'vue'
import { withQuery } from 'ufo'
import { useApi } from '~/composables/useApi'

export type ProductSelectItem = {
  label: string
  value: string
  name: string
  sku: string
}

type ProductRow = { id: string; name: string; sku?: string | null }

export function productToSelectItem(p: { id: string; name: string; sku?: string | null }): ProductSelectItem {
  const sku = String(p.sku ?? '').trim()
  return {
    label: sku ? `${p.name} (${sku})` : p.name,
    value: p.id,
    name: p.name,
    sku
  }
}

type UseProductSearchOptions = {
  isActive?: boolean
  supplierId?: Ref<string | null | undefined>
  limit?: number
  debounceMs?: number
}

export function useProductSearch(options: UseProductSearchOptions = {}) {
  const { request } = useApi()
  const items = ref<ProductSelectItem[]>([])
  const loading = ref(false)
  const pinnedItems = ref<ProductSelectItem[]>([])

  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let fetchGeneration = 0

  function setPinned(next: ProductSelectItem[]) {
    pinnedItems.value = next
  }

  function mergeItems(fetched: ProductSelectItem[]): ProductSelectItem[] {
    const seen = new Set<string>()
    const out: ProductSelectItem[] = []
    for (const item of [...pinnedItems.value, ...fetched]) {
      if (seen.has(item.value)) continue
      seen.add(item.value)
      out.push(item)
    }
    return out
  }

  function rememberSelected(selected: ProductSelectItem[]) {
    if (!selected.length) return
    setPinned(mergeItems([...pinnedItems.value, ...selected]))
  }

  async function runSearch(q: string) {
    const generation = ++fetchGeneration
    loading.value = true
    try {
      const params: Record<string, string | number> = {
        limit: options.limit ?? 50,
        sort: 'name_asc'
      }
      const trimmed = q.trim()
      if (trimmed) params.q = trimmed
      if (options.isActive !== false) params.isActive = 'true'
      const supplierId = options.supplierId?.value
      if (supplierId) params.supplierId = supplierId

      const rows = await request<ProductRow[]>(withQuery('/products', params))
      if (generation !== fetchGeneration) return
      items.value = mergeItems((rows ?? []).map(productToSelectItem))
    } catch {
      if (generation === fetchGeneration) items.value = mergeItems([])
    } finally {
      if (generation === fetchGeneration) loading.value = false
    }
  }

  function search(q: string) {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void runSearch(q), options.debounceMs ?? 250)
  }

  function searchImmediate(q: string) {
    if (debounceTimer) clearTimeout(debounceTimer)
    void runSearch(q)
  }

  return {
    items,
    loading,
    search,
    searchImmediate,
    setPinned,
    rememberSelected,
    mergeItems
  }
}
