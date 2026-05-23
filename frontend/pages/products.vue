<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { joinURL, withQuery } from 'ufo'
import { ApiError, useApi } from '~/composables/useApi'
import { useAuth } from '~/composables/useAuth'
import { useRuntimeConfig } from '#imports'
import DepartmentCreateForm from '~/components/DepartmentCreateForm.vue'
import { selectToPrimitive } from '~/composables/useSelectValue'

const SORT_VALUES = ['created_desc', 'created_asc', 'name_asc', 'name_desc', 'sale_asc', 'sale_desc'] as const

/** PG / JSON may expose is_active as boolean or string; Boolean("false") === true in JS. */
function normalizeActiveFlag(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['false', 'f', '0', 'no', 'off', 'disabled', 'n'].includes(s) || s === '') return false
    if (['true', 't', '1', 'yes', 'on', 'enabled', 'y'].includes(s)) return true
    /** Unknown string tokens should not implicitly mean "enabled" (fixes incorrect UI status). */
    return false
  }
  return Boolean(v)
}

/** Coerce checkbox / toggle / stray string into boolean before PATCH POST. */
function toBooleanStrict(v: unknown, fallback = true): boolean {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (['false', 'f', '0', 'no', 'off', 'unchecked'].includes(s)) return false
    if (['true', 't', '1', 'yes', 'on', 'checked'].includes(s)) return true
  }
  return Boolean(v)
}

type Department = { id: string; name: string }
type Category = {
  id: string
  name: string
  description?: string | null
  department_id?: string | null
  department_name?: string | null
}
type Product = {
  id: string
  name: string
  sku: string
  barcode: string
  sale_price: number
  cost_price: number
  tax_rate: number
  category_name?: string
  category_id?: string | null
  image_url?: string | null
  is_active: boolean
}

type AuthUser = {
  id: string
  email: string
  roles: string[]
  permissions: string[]
}

type ExcelImportRow = {
  rowNumber: number
  categoryName: string | null
  name: string
  sku: string
  barcode: string
  salePrice: number
  costPrice: number
  taxRate: number
  qtyOnHand: number
  openingBalance: number | null
  issues: string[]
}

const { request } = useApi()
const { user, token, setAuth } = useAuth()
const config = useRuntimeConfig()
const toast = useToast()
const NO_CATEGORY_VALUE = '__none__'
const FILTER_ALL_CATEGORIES = '__all_categories__'
/** Create-category flow: user must pick a real department from the list. */
const PICK_DEPARTMENT_VALUE = '__pick_department__'
/** Edit-category flow: optional unassigned department. */
const NO_DEPARTMENT_VALUE = '__no_department__'

/** Align with backend: permission or admin/manager role. */
const canManageProducts = computed(() => {
  const u = user.value
  if (!u) return false
  const perms = u.permissions ?? []
  const roles = u.roles ?? []
  return perms.includes('manage_inventory') || roles.includes('admin') || roles.includes('manager')
})

/** Read token/user from localStorage when useState lost them (refresh / direct URL). */
const hydrateFromStorageEarly = () => {
  if (!import.meta.client) return
  if (!token.value && typeof localStorage !== 'undefined') {
    const t = localStorage.getItem('pos_token')
    if (t) token.value = t
  }
  if (!user.value && typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem('pos_user')
    if (!raw) return
    try {
      user.value = JSON.parse(raw) as AuthUser
    } catch {
      user.value = null
    }
  }
}

const refreshUserProfile = async () => {
  try {
    hydrateFromStorageEarly()
    if (!token.value) return
    const me = await request<{ id: string; email: string; roles: string[]; permissions: string[] }>('/auth/me')
    setAuth(token.value, me)
  } catch {
    /* keep stored user */
  }
}

const PRODUCT_PAGE_SIZE = 100
const CATEGORY_PAGE_SIZE = 30

type Paginated<T> = { items: T[]; total: number; limit: number; offset: number }

const isLoading = ref(false)
const errorMessage = ref('')
const products = ref<Product[]>([])
/** Full list for filters and product forms. */
const allCategories = ref<Category[]>([])
/** Current page for the categories table. */
const categoryTableRows = ref<Category[]>([])
const productTotal = ref(0)
const categoryTotal = ref(0)
const productPage = ref(1)
const categoryPage = ref(1)
const departments = ref<Department[]>([])
const query = ref('')
const filterCategoryId = ref(FILTER_ALL_CATEGORIES)
const filterStatus = ref<'all' | 'active' | 'inactive'>('all')
const filterMinSale = ref('')
const filterMaxSale = ref('')
const sortBy = ref<'created_desc' | 'created_asc' | 'name_asc' | 'name_desc' | 'sale_asc' | 'sale_desc'>('created_desc')
const isEditModalOpen = ref(false)
const editingProductId = ref<string | null>(null)
const togglingProductId = ref<string | null>(null)
const deletingProductId = ref<string | null>(null)
const deletingCategoryId = ref<string | null>(null)
const bulkDeletingProducts = ref(false)
const bulkDeletingCategories = ref(false)
const selectedProductIds = ref<Set<string>>(new Set())
const selectedCategoryIds = ref<Set<string>>(new Set())
const deleteConfirmOpen = ref(false)
const deleteConfirmLoading = ref(false)

type DeletePending =
  | { kind: 'product'; mode: 'single'; product: Product }
  | { kind: 'product'; mode: 'bulk' }
  | { kind: 'category'; mode: 'single'; category: Category }
  | { kind: 'category'; mode: 'bulk' }

const deletePending = ref<DeletePending | null>(null)

const productForm = reactive({
  name: '',
  sku: '',
  barcode: '',
  salePrice: 0,
  costPrice: 0,
  taxRate: 0,
  imageUrl: '',
  categoryId: NO_CATEGORY_VALUE,
  isActive: true
})

const categoryForm = reactive({
  name: '',
  description: '',
  departmentId: PICK_DEPARTMENT_VALUE as string
})

const isCategoryEditModalOpen = ref(false)
const editCategoryForm = reactive({
  id: '' as string,
  name: '',
  description: '',
  departmentId: NO_DEPARTMENT_VALUE as string
})

const imageInputRef = ref<HTMLInputElement | null>(null)
const editImageInputRef = ref<HTMLInputElement | null>(null)
const excelInputRef = ref<HTMLInputElement | null>(null)

const importPreviewRows = ref<ExcelImportRow[]>([])
const importPreviewMeta = ref<{ fileName: string; rowCount: number } | null>(null)
const importParsing = ref(false)
const importApplying = ref(false)

const validExcelRowCount = computed(() => importPreviewRows.value.filter((r) => r.issues.length === 0).length)

const editForm = reactive({
  name: '',
  sku: '',
  barcode: '',
  salePrice: 0,
  costPrice: 0,
  taxRate: 0,
  imageUrl: '',
  categoryId: NO_CATEGORY_VALUE,
  isActive: true
})

const categoryLabel = (category: Category) =>
  category.department_name ? `${category.name} (${category.department_name})` : category.name

const filterCategoryItems = computed(() => [
  { label: 'All categories', value: FILTER_ALL_CATEGORIES },
  ...allCategories.value
    .filter((category) => typeof category.id === 'string' && category.id.trim().length > 0)
    .map((category) => ({ label: categoryLabel(category), value: category.id }))
])

const productPageCount = computed(() =>
  Math.max(1, Math.ceil(productTotal.value / PRODUCT_PAGE_SIZE) || 1)
)
const categoryPageCount = computed(() =>
  Math.max(1, Math.ceil(categoryTotal.value / CATEGORY_PAGE_SIZE) || 1)
)
const productRangeStart = computed(() =>
  productTotal.value === 0 ? 0 : (productPage.value - 1) * PRODUCT_PAGE_SIZE + 1
)
const productRangeEnd = computed(() =>
  Math.min(productPage.value * PRODUCT_PAGE_SIZE, productTotal.value)
)
const categoryRangeStart = computed(() =>
  categoryTotal.value === 0 ? 0 : (categoryPage.value - 1) * CATEGORY_PAGE_SIZE + 1
)
const categoryRangeEnd = computed(() =>
  Math.min(categoryPage.value * CATEGORY_PAGE_SIZE, categoryTotal.value)
)

const statusFilterItems = [
  { label: 'All statuses', value: 'all' },
  { label: 'Enabled only', value: 'active' },
  { label: 'Disabled only', value: 'inactive' }
]

const sortSelectItems = [
  { label: 'Newest first', value: 'created_desc' },
  { label: 'Oldest first', value: 'created_asc' },
  { label: 'Name A–Z', value: 'name_asc' },
  { label: 'Name Z–A', value: 'name_desc' },
  { label: 'Sale price low → high', value: 'sale_asc' },
  { label: 'Sale price high → low', value: 'sale_desc' }
]

const categorySelectItems = computed(() => [
  { label: 'No category', value: NO_CATEGORY_VALUE },
  ...allCategories.value
    .filter((category) => typeof category.id === 'string' && category.id.trim().length > 0)
    .map((category) => ({ label: categoryLabel(category), value: category.id }))
])

const categoryDepartmentCreateItems = computed(() => [
  { label: 'Select department…', value: PICK_DEPARTMENT_VALUE },
  ...departments.value
    .filter((d) => typeof d.id === 'string' && d.id.trim().length > 0)
    .map((d) => ({ label: d.name, value: d.id }))
])

const categoryDepartmentEditItems = computed(() => [
  { label: 'No department', value: NO_DEPARTMENT_VALUE },
  ...departments.value
    .filter((d) => typeof d.id === 'string' && d.id.trim().length > 0)
    .map((d) => ({ label: d.name, value: d.id }))
])

const categoryDepartmentCreateSelectModel = computed({
  get: () => categoryForm.departmentId,
  set: (v: unknown) => {
    categoryForm.departmentId = (selectToPrimitive(v) ?? PICK_DEPARTMENT_VALUE) as typeof categoryForm.departmentId
  }
})

const editCategoryDepartmentSelectModel = computed({
  get: () => editCategoryForm.departmentId,
  set: (v: unknown) => {
    editCategoryForm.departmentId = (selectToPrimitive(v) ?? NO_DEPARTMENT_VALUE) as typeof editCategoryForm.departmentId
  }
})

const selectedImagePreview = computed(() => productForm.imageUrl || '')
const editImagePreview = computed(() => editForm.imageUrl || '')

const onProductImageSelected = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!file.type.startsWith('image/')) {
    errorMessage.value = 'Please select a valid image file.'
    input.value = ''
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    errorMessage.value = 'Image size must be 2MB or less.'
    input.value = ''
    return
  }

  errorMessage.value = ''
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Failed to read image file'))
    reader.readAsDataURL(file)
  }).catch(() => '')

  if (!dataUrl) {
    errorMessage.value = 'Failed to process selected image.'
    input.value = ''
    return
  }

  productForm.imageUrl = dataUrl
}

const clearSelectedImage = () => {
  productForm.imageUrl = ''
  if (imageInputRef.value) {
    imageInputRef.value.value = ''
  }
}

const onEditProductImageSelected = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (!file.type.startsWith('image/')) {
    errorMessage.value = 'Please select a valid image file.'
    input.value = ''
    return
  }
  if (file.size > 2 * 1024 * 1024) {
    errorMessage.value = 'Image size must be 2MB or less.'
    input.value = ''
    return
  }

  errorMessage.value = ''
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('Failed to read image file'))
    reader.readAsDataURL(file)
  }).catch(() => '')

  if (!dataUrl) {
    errorMessage.value = 'Failed to process selected image.'
    input.value = ''
    return
  }

  editForm.imageUrl = dataUrl
}

const clearEditImage = () => {
  editForm.imageUrl = ''
  if (editImageInputRef.value) {
    editImageInputRef.value.value = ''
  }
}

const clearExcelImportPreview = () => {
  importPreviewRows.value = []
  importPreviewMeta.value = null
  if (excelInputRef.value) {
    excelInputRef.value.value = ''
  }
}

const onExcelFileSelected = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  importParsing.value = true
  errorMessage.value = ''
  try {
    const body = new FormData()
    body.append('excelFile', file)
    const uploadUrl = joinURL(config.public.apiBase, '/products/import/excel')
    const res = await $fetch<{ fileName: string; rowCount: number; rows: ExcelImportRow[] }>(uploadUrl, {
      method: 'POST',
      headers: token.value ? { Authorization: `Bearer ${token.value}` } : {},
      body
    })
    importPreviewMeta.value = { fileName: res.fileName, rowCount: res.rowCount }
    importPreviewRows.value = res.rows
    if (!res.rows.length) {
      errorMessage.value =
        'No product rows found. Use a header row with columns such as Category, Product name, SKU, Barcode, Sale price.'
    }
  } catch (error: unknown) {
    importPreviewMeta.value = null
    importPreviewRows.value = []
    const err = error as { data?: { message?: string }; message?: string }
    const fromApi = err.data && typeof err.data === 'object' && err.data.message ? String(err.data.message) : ''
    errorMessage.value = fromApi || err.message || 'Failed to read Excel file.'
  } finally {
    importParsing.value = false
    input.value = ''
  }
}

const applyExcelImport = async () => {
  const rows = importPreviewRows.value.filter((r) => r.issues.length === 0).map((r) => ({
    rowNumber: r.rowNumber,
    categoryName: r.categoryName,
    name: r.name,
    sku: r.sku,
    barcode: r.barcode,
    salePrice: r.salePrice,
    costPrice: r.costPrice,
    taxRate: r.taxRate,
    qtyOnHand: r.qtyOnHand,
    openingBalance: r.openingBalance
  }))
  if (!rows.length) return

  importApplying.value = true
  errorMessage.value = ''
  try {
    const res = await request<{
      createdCount: number
      failedCount: number
      failed: { rowNumber: number; message: string }[]
    }>('/products/import/excel/apply', {
      method: 'POST',
      body: { rows }
    })
    if (res.createdCount > 0) {
      await loadData()
    }
    clearExcelImportPreview()
    if (res.failedCount > 0 && res.failed?.length) {
      errorMessage.value = res.failed.map((f) => `Row ${f.rowNumber}: ${f.message}`).join(' · ')
    }
  } catch (error: unknown) {
    if (error instanceof ApiError) {
      errorMessage.value = error.message
    } else {
      errorMessage.value = (error as { message?: string }).message ?? 'Import failed'
    }
  } finally {
    importApplying.value = false
  }
}

/**
 * Backend list handler expects string query params (`isActive` enum "true"|"false", UUID `categoryId`, etc.).
 * Keep every serialized value explicitly string-ish so proxies / ofetch cannot drop coercions unexpectedly.
 */
const buildProductListQuery = (): Record<string, string | number | boolean> => {
  const out: Record<string, string | number | boolean> = {}

  const sortRaw = selectToPrimitive(sortBy.value) ?? 'created_desc'
  out.sort = (SORT_VALUES as readonly string[]).includes(sortRaw) ? sortRaw : 'created_desc'

  const qTrim = query.value.trim()
  if (qTrim) out.q = qTrim

  const cat = selectToPrimitive(filterCategoryId.value)
  if (typeof cat === 'string' && cat.length > 0 && cat !== FILTER_ALL_CATEGORIES) {
    out.categoryId = cat
  }

  /** List API expects `isActive=true|false` (backend normalizes snake_case aliases separately). */
  const status = selectToPrimitive(filterStatus.value)
  if (status === 'active') {
    out.isActive = 'true'
  } else if (status === 'inactive') {
    out.isActive = 'false'
  }

  const minStr = String(filterMinSale.value ?? '').trim()
  const maxStr = String(filterMaxSale.value ?? '').trim()
  const minSale = Number.parseFloat(minStr)
  const maxSale = Number.parseFloat(maxStr)
  if (minStr !== '' && !Number.isNaN(minSale) && minSale >= 0) {
    out.minSalePrice = minSale
  }
  if (maxStr !== '' && !Number.isNaN(maxSale) && maxSale >= 0) {
    out.maxSalePrice = maxSale
  }

  return out
}

const clearFilters = () => {
  query.value = ''
  filterCategoryId.value = FILTER_ALL_CATEGORIES
  filterStatus.value = 'all'
  filterMinSale.value = ''
  filterMaxSale.value = ''
  sortBy.value = 'created_desc'
}

let productFilterDebounce: ReturnType<typeof setTimeout> | null = null

/** Parallel product GETs could finish out-of-order when filters debounce quickly — ignore stale responses. */
let productFetchGeneration = 0

const productsListUrl = () =>
  withQuery('/products', {
    ...(buildProductListQuery() as Record<string, string | number | boolean | undefined>),
    limit: PRODUCT_PAGE_SIZE,
    offset: (productPage.value - 1) * PRODUCT_PAGE_SIZE,
    withTotal: 'true'
  })

const categoriesTableUrl = () =>
  withQuery('/products/categories', {
    limit: CATEGORY_PAGE_SIZE,
    offset: (categoryPage.value - 1) * CATEGORY_PAGE_SIZE,
    withTotal: 'true'
  })

const productCategorySelectModel = computed({
  get: () => productForm.categoryId,
  set: (v: unknown) => {
    productForm.categoryId = (selectToPrimitive(v) ?? NO_CATEGORY_VALUE) as typeof productForm.categoryId
  }
})

const editCategorySelectModel = computed({
  get: () => editForm.categoryId,
  set: (v: unknown) => {
    editForm.categoryId = (selectToPrimitive(v) ?? NO_CATEGORY_VALUE) as typeof editForm.categoryId
  }
})

/** Reka/Nuxt UI Checkbox can emit boolean or string — normalize before API. */
const productActiveCheckModel = computed({
  get: () => toBooleanStrict(productForm.isActive, true),
  set: (v: unknown) => {
    productForm.isActive = toBooleanStrict(v, true)
  }
})

const editActiveCheckModel = computed({
  get: () => toBooleanStrict(editForm.isActive, true),
  set: (v: unknown) => {
    editForm.isActive = toBooleanStrict(v, true)
  }
})

/** Normalize Nuxt `USelect` v-model (sometimes the full item `{ label, value }` object). */
const filterCategoryIdModel = computed({
  get: () => filterCategoryId.value,
  set: (v: unknown) => {
    filterCategoryId.value = (selectToPrimitive(v) ?? FILTER_ALL_CATEGORIES) as typeof filterCategoryId.value
  }
})

const filterStatusModel = computed({
  get: () => filterStatus.value,
  set: (v: unknown) => {
    const s = selectToPrimitive(v)
    if (s === 'active' || s === 'inactive' || s === 'all') filterStatus.value = s
    else filterStatus.value = 'all'
  }
})

const sortByModel = computed({
  get: () => sortBy.value,
  set: (v: unknown) => {
    const s = selectToPrimitive(v)
    if ((SORT_VALUES as readonly string[]).includes(s ?? '')) sortBy.value = s as typeof sortBy.value
  }
})

const mapProductRows = (rows: Product[]) =>
  rows.map((row) => {
    const r = row as Product & { is_active?: unknown; category_id?: string | null }
    return {
      ...r,
      category_id: r.category_id ?? null,
      is_active: normalizeActiveFlag(r.is_active)
    }
  })

const loadCategoryTablePage = async () => {
  const res = await request<Paginated<Category>>(categoriesTableUrl())
  categoryTableRows.value = res.items
  categoryTotal.value = res.total
  const maxPage = Math.max(1, Math.ceil(res.total / CATEGORY_PAGE_SIZE) || 1)
  if (categoryPage.value > maxPage) {
    categoryPage.value = maxPage
    const retry = await request<Paginated<Category>>(categoriesTableUrl())
    categoryTableRows.value = retry.items
    categoryTotal.value = retry.total
  }
}

const loadProductsPage = async (gen: number) => {
  const productRes = await request<Paginated<Product>>(productsListUrl(), { cache: 'no-store' })
  if (gen !== productFetchGeneration) return
  products.value = mapProductRows(productRes.items)
  productTotal.value = productRes.total
  const maxPage = Math.max(1, Math.ceil(productRes.total / PRODUCT_PAGE_SIZE) || 1)
  if (productPage.value > maxPage) {
    productPage.value = maxPage
    const retry = await request<Paginated<Product>>(productsListUrl(), { cache: 'no-store' })
    if (gen !== productFetchGeneration) return
    products.value = mapProductRows(retry.items)
    productTotal.value = retry.total
  }
}

const loadData = async () => {
  const gen = ++productFetchGeneration
  isLoading.value = true
  errorMessage.value = ''
  try {
    const [, categoryListRes, , departmentRes] = await Promise.all([
      loadProductsPage(gen),
      request<Category[]>('/products/categories'),
      loadCategoryTablePage(),
      request<Department[]>('/products/departments')
    ])
    if (gen !== productFetchGeneration) return
    allCategories.value = categoryListRes
    departments.value = departmentRes
  } catch (error: unknown) {
    if (gen !== productFetchGeneration) return
    if (error instanceof ApiError) {
      errorMessage.value = error.message
    } else {
      errorMessage.value = (error as { message?: string }).message ?? 'Failed to load products'
    }
  } finally {
    if (gen === productFetchGeneration) isLoading.value = false
  }
}

const setProductPage = (page: number) => {
  const next = Math.min(Math.max(1, page), productPageCount.value)
  if (next === productPage.value) return
  productPage.value = next
  void reloadProductsNow()
}

const setCategoryPage = (page: number) => {
  const next = Math.min(Math.max(1, page), categoryPageCount.value)
  if (next === categoryPage.value) return
  categoryPage.value = next
  void (async () => {
    isLoading.value = true
    try {
      await loadCategoryTablePage()
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        errorMessage.value = error.message
      } else {
        errorMessage.value = (error as { message?: string }).message ?? 'Failed to load categories'
      }
    } finally {
      isLoading.value = false
    }
  })()
}

const resolveDepartmentIdForCreate = (): string | undefined => {
  const raw = selectToPrimitive(categoryForm.departmentId)
  if (!raw || raw === PICK_DEPARTMENT_VALUE) return undefined
  return raw
}

const resolveDepartmentIdForPatch = (raw: string): string | null | undefined => {
  const v = selectToPrimitive(raw)
  if (v === undefined || v === NO_DEPARTMENT_VALUE) return null
  return v
}

const createCategory = async () => {
  if (!canManageProducts.value) return
  errorMessage.value = ''
  const deptId = resolveDepartmentIdForCreate()
  if (!deptId) {
    errorMessage.value =
      departments.value.length === 0
        ? 'Create at least one department before adding categories.'
        : 'Select a department for this category.'
    return
  }
  try {
    await request('/products/categories', {
      method: 'POST',
      body: {
        name: categoryForm.name,
        description: categoryForm.description || undefined,
        departmentId: deptId
      }
    })
    categoryForm.name = ''
    categoryForm.description = ''
    categoryForm.departmentId = PICK_DEPARTMENT_VALUE
    await loadData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to create category'
  }
}

const openEditCategory = (category: Category) => {
  editCategoryForm.id = category.id
  editCategoryForm.name = category.name
  editCategoryForm.description = category.description ?? ''
  const did =
    typeof category.department_id === 'string' && category.department_id.trim().length > 0
      ? category.department_id.trim()
      : ''
  editCategoryForm.departmentId = did || NO_DEPARTMENT_VALUE
  isCategoryEditModalOpen.value = true
}

const updateCategory = async () => {
  if (!canManageProducts.value || !editCategoryForm.id) return
  errorMessage.value = ''
  try {
    const departmentId = resolveDepartmentIdForPatch(editCategoryForm.departmentId)
    await request(`/products/categories/${editCategoryForm.id}`, {
      method: 'PATCH',
      body: {
        name: editCategoryForm.name,
        description: editCategoryForm.description.trim() === '' ? null : editCategoryForm.description,
        departmentId
      }
    })
    isCategoryEditModalOpen.value = false
    editCategoryForm.id = ''
    await loadData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to update category'
  }
}

const resolveCategoryPayload = (raw: string) =>
  raw === NO_CATEGORY_VALUE || raw.trim() === '' ? undefined : raw.trim()

const createProduct = async () => {
  errorMessage.value = ''
  try {
    const categoryId = resolveCategoryPayload(productForm.categoryId)
    await request('/products', {
      method: 'POST',
      body: {
        name: productForm.name,
        sku: productForm.sku,
        barcode: productForm.barcode,
        salePrice: Number(productForm.salePrice),
        costPrice: Number(productForm.costPrice),
        taxRate: Number(productForm.taxRate),
        imageUrl: productForm.imageUrl.trim() || undefined,
        categoryId,
        isActive: toBooleanStrict(productForm.isActive, true)
      }
    })
    productForm.name = ''
    productForm.sku = ''
    productForm.barcode = ''
    productForm.salePrice = 0
    productForm.costPrice = 0
    productForm.taxRate = 0
    productForm.imageUrl = ''
    productForm.categoryId = NO_CATEGORY_VALUE
    productForm.isActive = true
    if (imageInputRef.value) {
      imageInputRef.value.value = ''
    }
    await loadData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to create product'
  }
}

const openEditProduct = (product: Product) => {
  editingProductId.value = product.id
  editForm.name = product.name
  editForm.sku = product.sku
  editForm.barcode = product.barcode
  editForm.salePrice = Number(product.sale_price)
  editForm.costPrice = Number(product.cost_price)
  editForm.taxRate = Number(product.tax_rate)
  editForm.imageUrl = product.image_url ?? ''
  editForm.isActive = normalizeActiveFlag(product.is_active)
  const cid =
    typeof product.category_id === 'string' && product.category_id.trim().length > 0
      ? product.category_id.trim()
      : ''
  editForm.categoryId =
    cid || (allCategories.value.find((category) => category.name === (product.category_name ?? ''))?.id ?? NO_CATEGORY_VALUE)
  if (editImageInputRef.value) {
    editImageInputRef.value.value = ''
  }
  isEditModalOpen.value = true
}

const updateProduct = async () => {
  if (!editingProductId.value) return
  errorMessage.value = ''
  try {
    const categoryIdResolved = resolveCategoryPayload(editForm.categoryId)
    const body: Record<string, unknown> = {
      name: editForm.name,
      sku: editForm.sku,
      barcode: editForm.barcode,
      salePrice: Number(editForm.salePrice),
      costPrice: Number(editForm.costPrice),
      taxRate: Number(editForm.taxRate),
      imageUrl: editForm.imageUrl.trim() || undefined,
      isActive: toBooleanStrict(editForm.isActive, true)
    }
    body.categoryId = categoryIdResolved === undefined ? null : categoryIdResolved
    await request(`/products/${editingProductId.value}`, {
      method: 'PATCH',
      body
    })
    isEditModalOpen.value = false
    editingProductId.value = null
    await loadData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to update product'
  }
}

const toggleProductActive = async (product: Product) => {
  if (!canManageProducts.value) return
  togglingProductId.value = product.id
  errorMessage.value = ''
  try {
    const next = !normalizeActiveFlag(product.is_active)
    await request(`/products/${product.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: { isActive: next }
    })
    await loadData()
  } catch (error: unknown) {
    errorMessage.value = (error as { message?: string }).message ?? 'Failed to update product status'
  } finally {
    togglingProductId.value = null
  }
}

const selectedProductCount = computed(() => selectedProductIds.value.size)
const selectedCategoryCount = computed(() => selectedCategoryIds.value.size)

const allProductsOnPageSelected = computed(
  () => products.value.length > 0 && products.value.every((p) => selectedProductIds.value.has(p.id))
)
const allCategoriesOnPageSelected = computed(
  () =>
    categoryTableRows.value.length > 0 &&
    categoryTableRows.value.every((c) => selectedCategoryIds.value.has(c.id))
)

const clearProductSelection = () => {
  selectedProductIds.value = new Set()
}
const clearCategorySelection = () => {
  selectedCategoryIds.value = new Set()
}

const deleteConfirmTitle = computed(() => {
  const pending = deletePending.value
  if (!pending) return 'Confirm delete'
  const label = pending.kind === 'product' ? 'product' : 'category'
  if (pending.mode === 'bulk') {
    const count = pending.kind === 'product' ? selectedProductCount.value : selectedCategoryCount.value
    return `Delete ${count} ${label}(s)?`
  }
  if (pending.kind === 'product') return `Delete "${pending.product.name}"?`
  return `Delete "${pending.category.name}"?`
})

const deleteConfirmDescription =
  'This permanently removes the item from your catalog. Products used on sales or purchase records cannot be deleted. Deleting a category unlinks its products (they stay in the list without that category).'

const resetDeleteConfirm = () => {
  deleteConfirmOpen.value = false
  deletePending.value = null
}

const closeDeleteConfirm = () => {
  if (deleteConfirmLoading.value) return
  resetDeleteConfirm()
}

const openDeleteProductConfirm = (product: Product) => {
  deletePending.value = { kind: 'product', mode: 'single', product }
  deleteConfirmOpen.value = true
}

const openBulkDeleteProductsConfirm = () => {
  if (!selectedProductCount.value) return
  deletePending.value = { kind: 'product', mode: 'bulk' }
  deleteConfirmOpen.value = true
}

const openDeleteCategoryConfirm = (category: Category) => {
  deletePending.value = { kind: 'category', mode: 'single', category }
  deleteConfirmOpen.value = true
}

const openBulkDeleteCategoriesConfirm = () => {
  if (!selectedCategoryCount.value) return
  deletePending.value = { kind: 'category', mode: 'bulk' }
  deleteConfirmOpen.value = true
}

const setProductSelected = (id: string, checked: boolean) => {
  const next = new Set(selectedProductIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedProductIds.value = next
}

const setCategorySelected = (id: string, checked: boolean) => {
  const next = new Set(selectedCategoryIds.value)
  if (checked) next.add(id)
  else next.delete(id)
  selectedCategoryIds.value = next
}

const toggleSelectAllProducts = () => {
  const next = new Set(selectedProductIds.value)
  if (allProductsOnPageSelected.value) {
    for (const p of products.value) next.delete(p.id)
  } else {
    for (const p of products.value) next.add(p.id)
  }
  selectedProductIds.value = next
}

const toggleSelectAllCategories = () => {
  const next = new Set(selectedCategoryIds.value)
  if (allCategoriesOnPageSelected.value) {
    for (const c of categoryTableRows.value) next.delete(c.id)
  } else {
    for (const c of categoryTableRows.value) next.add(c.id)
  }
  selectedCategoryIds.value = next
}

const performDeleteProduct = async (product: Product) => {
  deletingProductId.value = product.id
  errorMessage.value = ''
  try {
    await request(`/products/${product.id}`, { method: 'DELETE' })
    setProductSelected(product.id, false)
    await reloadProductsNow()
    toast.add({
      title: 'Product deleted',
      description: `"${product.name}" was permanently removed.`,
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
  } catch (error: unknown) {
    const msg =
      error instanceof ApiError
        ? error.message
        : (error as { message?: string }).message ?? 'Failed to delete product'
    errorMessage.value = msg
    toast.add({ title: 'Delete failed', description: msg, color: 'error', icon: 'i-lucide-triangle-alert' })
    throw error
  } finally {
    deletingProductId.value = null
  }
}

const performBulkDeleteProducts = async () => {
  const ids = [...selectedProductIds.value]
  if (!ids.length) return
  bulkDeletingProducts.value = true
  errorMessage.value = ''
  try {
    const res = await request<{
      deletedCount: number
      failed: { id: string; message: string }[]
    }>('/products/bulk-delete', { method: 'POST', body: { ids } })
    clearProductSelection()
    await reloadProductsNow()
    toast.add({
      title: 'Products deleted',
      description: `${res.deletedCount} product(s) permanently removed.`,
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
    if (res.failed?.length) {
      const msg = res.failed.map((f) => f.message).join(' · ')
      errorMessage.value = msg
      toast.add({
        title: 'Some products were not deleted',
        description: msg,
        color: 'warning',
        icon: 'i-lucide-triangle-alert'
      })
    }
  } catch (error: unknown) {
    const msg =
      error instanceof ApiError
        ? error.message
        : (error as { message?: string }).message ?? 'Bulk delete failed'
    errorMessage.value = msg
    toast.add({ title: 'Bulk delete failed', description: msg, color: 'error', icon: 'i-lucide-triangle-alert' })
    throw error
  } finally {
    bulkDeletingProducts.value = false
  }
}

const performDeleteCategory = async (cat: Category) => {
  deletingCategoryId.value = cat.id
  errorMessage.value = ''
  try {
    await request(`/products/categories/${cat.id}`, { method: 'DELETE' })
    setCategorySelected(cat.id, false)
    await reloadProductsNow()
    toast.add({
      title: 'Category deleted',
      description: `"${cat.name}" was permanently removed.`,
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
  } catch (error: unknown) {
    const msg =
      error instanceof ApiError
        ? error.message
        : (error as { message?: string }).message ?? 'Failed to delete category'
    errorMessage.value = msg
    toast.add({ title: 'Delete failed', description: msg, color: 'error', icon: 'i-lucide-triangle-alert' })
    throw error
  } finally {
    deletingCategoryId.value = null
  }
}

const performBulkDeleteCategories = async () => {
  const ids = [...selectedCategoryIds.value]
  if (!ids.length) return
  bulkDeletingCategories.value = true
  errorMessage.value = ''
  try {
    const res = await request<{
      deletedCount: number
      failed: { id: string; message: string }[]
    }>('/products/categories/bulk-delete', { method: 'POST', body: { ids } })
    clearCategorySelection()
    await reloadProductsNow()
    toast.add({
      title: 'Categories deleted',
      description: `${res.deletedCount} category(ies) permanently removed.`,
      color: 'success',
      icon: 'i-lucide-circle-check'
    })
    if (res.failed?.length) {
      const msg = res.failed.map((f) => f.message).join(' · ')
      errorMessage.value = msg
      toast.add({
        title: 'Some categories were not deleted',
        description: msg,
        color: 'warning',
        icon: 'i-lucide-triangle-alert'
      })
    }
  } catch (error: unknown) {
    const msg =
      error instanceof ApiError
        ? error.message
        : (error as { message?: string }).message ?? 'Bulk delete failed'
    errorMessage.value = msg
    toast.add({ title: 'Bulk delete failed', description: msg, color: 'error', icon: 'i-lucide-triangle-alert' })
    throw error
  } finally {
    bulkDeletingCategories.value = false
  }
}

const confirmDeleteAction = async () => {
  if (!canManageProducts.value || !deletePending.value) return
  deleteConfirmLoading.value = true
  try {
    const pending = deletePending.value
    if (pending.kind === 'product' && pending.mode === 'single') {
      await performDeleteProduct(pending.product)
    } else if (pending.kind === 'product' && pending.mode === 'bulk') {
      await performBulkDeleteProducts()
    } else if (pending.kind === 'category' && pending.mode === 'single') {
      await performDeleteCategory(pending.category)
    } else if (pending.kind === 'category' && pending.mode === 'bulk') {
      await performBulkDeleteCategories()
    }
    resetDeleteConfirm()
  } catch {
    /* toast + errorMessage already set */
  } finally {
    deleteConfirmLoading.value = false
  }
}

/** Run product fetch after filter controls settle (typing search, selects). */
const scheduleProductReload = () => {
  if (productFilterDebounce) clearTimeout(productFilterDebounce)
  productFilterDebounce = setTimeout(() => {
    productFilterDebounce = null
    void loadData()
  }, 320)
}

const reloadProductsNow = () => {
  if (productFilterDebounce) {
    clearTimeout(productFilterDebounce)
    productFilterDebounce = null
  }
  void loadData()
}

watch(
  [query, filterCategoryId, filterStatus, filterMinSale, filterMaxSale, sortBy],
  () => {
    productPage.value = 1
    clearProductSelection()
    scheduleProductReload()
  }
)

watch(productPage, () => {
  clearProductSelection()
})

watch(categoryPage, () => {
  clearCategorySelection()
})

onMounted(async () => {
  await refreshUserProfile()
  await loadData()
})
</script>

<template>
  <section class="space-y-6">
    <UAlert
      v-if="errorMessage"
      color="error"
      variant="soft"
      :description="errorMessage"
      icon="i-lucide-triangle-alert"
    />

    <div class="grid gap-4 xl:grid-cols-3">
      <DepartmentCreateForm :can-manage="canManageProducts" @created="reloadProductsNow" />

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Create Category</h2>
        <p class="mb-3 text-sm text-slate-600 dark:text-slate-400">
          Every category is stored under one department. Create a department first if the list is empty.
        </p>
        <div class="grid gap-3">
          <UiLabeledField label="Category name" html-for="prd-cat-name" required>
            <UInput id="prd-cat-name" v-model="categoryForm.name" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Description" html-for="prd-cat-desc">
            <UTextarea id="prd-cat-desc" v-model="categoryForm.description" class="w-full" />
          </UiLabeledField>
          <div class="grid gap-1">
            <label class="text-xs font-medium text-slate-600 dark:text-slate-400">Department</label>
            <UiSearchableSelect
              v-model="categoryDepartmentCreateSelectModel"
              :items="categoryDepartmentCreateItems"
              placeholder="Search department…"
              :disabled="!departments.length"
            />
          </div>
          <UButton
            icon="i-lucide-plus"
            :disabled="!canManageProducts || !departments.length"
            @click="createCategory"
          >
            Save Category
          </UButton>
        </div>
      </UCard>

      <UCard>
        <h2 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Create Product</h2>
        <div class="grid gap-3 sm:grid-cols-2">
          <UiLabeledField label="Product name" html-for="prd-new-name" class="sm:col-span-2" required>
            <UInput id="prd-new-name" v-model="productForm.name" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="SKU" html-for="prd-new-sku">
            <UInput id="prd-new-sku" v-model="productForm.sku" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Barcode" html-for="prd-new-barcode">
            <UInput id="prd-new-barcode" v-model="productForm.barcode" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Sale price (Rs)" html-for="prd-new-sale">
            <UInput id="prd-new-sale" v-model.number="productForm.salePrice" type="number" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Cost price (Rs)" html-for="prd-new-cost">
            <UInput id="prd-new-cost" v-model.number="productForm.costPrice" type="number" class="w-full" />
          </UiLabeledField>
          <UiLabeledField label="Tax %" html-for="prd-new-tax">
            <UInput id="prd-new-tax" v-model.number="productForm.taxRate" type="number" class="w-full" />
          </UiLabeledField>
          <div class="sm:col-span-2 grid gap-2">
            <label class="text-xs font-medium text-slate-500">Product image (optional)</label>
            <input
              ref="imageInputRef"
              type="file"
              accept="image/*"
              class="block w-full rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              @change="onProductImageSelected"
            />
            <div class="flex items-center gap-3">
              <img
                :src="selectedImagePreview || 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2764%27 height=%2764%27 viewBox=%270 0 64 64%27%3E%3Crect width=%2764%27 height=%2764%27 fill=%27%23e2e8f0%27/%3E%3Cpath d=%27M16 22h32v20H16z%27 fill=%27%2394a3b8%27/%3E%3Ccircle cx=%2726%27 cy=%2730%27 r=%273%27 fill=%27%23e2e8f0%27/%3E%3Cpath d=%27M20 42l8-7 5 4 7-6 8 9z%27 fill=%27%23cbd5e1%27/%3E%3C/svg%3E'"
                alt="Selected product image"
                class="h-12 w-12 rounded object-cover"
              />
              <UButton
                color="neutral"
                variant="soft"
                size="xs"
                icon="i-lucide-x"
                :disabled="!productForm.imageUrl"
                @click="clearSelectedImage"
              >
                Remove image
              </UButton>
            </div>
          </div>
          <UiLabeledField label="Category">
            <UiSearchableSelect v-model="productCategorySelectModel" :items="categorySelectItems" placeholder="Search category…" />
          </UiLabeledField>
          <div class="sm:col-span-2">
            <UCheckbox v-model="productActiveCheckModel" name="product-active" label="Active (available on POS / billing)" />
          </div>
          <UButton class="sm:col-span-2" icon="i-lucide-package-plus" @click="createProduct">Save Product</UButton>
        </div>
      </UCard>
    </div>

    <UCard>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Categories</h2>
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            v-if="canManageProducts && selectedCategoryCount > 0"
            color="error"
            variant="soft"
            size="sm"
            icon="i-lucide-trash-2"
            :loading="bulkDeletingCategories"
            @click="openBulkDeleteCategoriesConfirm"
          >
            Delete selected ({{ selectedCategoryCount }})
          </UButton>
          <UButton color="neutral" variant="soft" icon="i-lucide-refresh-cw" size="sm" :loading="isLoading" @click="reloadProductsNow">
            Refresh
          </UButton>
        </div>
      </div>
      <div class="table-scroll">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th v-if="canManageProducts" class="w-10 px-3 py-2">
                <UCheckbox :model-value="allCategoriesOnPageSelected" @update:model-value="toggleSelectAllCategories" />
              </th>
              <th class="px-3 py-2">Name</th>
              <th class="px-3 py-2">Department</th>
              <th class="px-3 py-2">Description</th>
              <th class="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="cat in categoryTableRows"
              :key="cat.id"
              class="border-b border-slate-100 dark:border-slate-800"
            >
              <td v-if="canManageProducts" class="px-3 py-2" @click.stop>
                <UCheckbox
                  :model-value="selectedCategoryIds.has(cat.id)"
                  @update:model-value="(v: boolean) => setCategorySelected(cat.id, v)"
                />
              </td>
              <td class="px-3 py-2 font-medium">{{ cat.name }}</td>
              <td class="px-3 py-2">{{ cat.department_name || '—' }}</td>
              <td class="max-w-xs truncate px-3 py-2 text-slate-600 dark:text-slate-400">{{ cat.description || '—' }}</td>
              <td class="px-3 py-2">
                <div v-if="canManageProducts" class="flex flex-wrap items-center gap-1">
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="soft"
                    icon="i-lucide-pencil"
                    @click="openEditCategory(cat)"
                  >
                    Edit
                  </UButton>
                  <UButton
                    size="xs"
                    color="error"
                    variant="soft"
                    icon="i-lucide-trash-2"
                    :loading="deletingCategoryId === cat.id"
                    @click="openDeleteCategoryConfirm(cat)"
                  >
                    Delete
                  </UButton>
                </div>
                <span v-else class="text-slate-400">—</span>
              </td>
            </tr>
            <tr v-if="!categoryTableRows.length && !isLoading">
              <td class="px-3 py-4 text-slate-500" :colspan="canManageProducts ? 5 : 4">No categories yet.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div
        v-if="categoryTotal > 0"
        class="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-400"
      >
        <span>Showing {{ categoryRangeStart }}–{{ categoryRangeEnd }} of {{ categoryTotal }}</span>
        <div class="flex items-center gap-2">
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-chevron-left"
            :disabled="categoryPage <= 1 || isLoading"
            @click="setCategoryPage(categoryPage - 1)"
          />
          <span class="tabular-nums">Page {{ categoryPage }} / {{ categoryPageCount }}</span>
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-chevron-right"
            :disabled="categoryPage >= categoryPageCount || isLoading"
            @click="setCategoryPage(categoryPage + 1)"
          />
        </div>
      </div>
    </UCard>

    <UCard v-if="canManageProducts">
      <h2 class="mb-2 text-lg font-semibold text-slate-900 dark:text-slate-100">Import products from Excel</h2>
      <p class="mb-3 text-sm text-slate-600 dark:text-slate-400">
        First sheet: put headers in row 1 — for example
        <span class="font-medium text-slate-800 dark:text-slate-200">Category</span>,
        <span class="font-medium text-slate-800 dark:text-slate-200">Product name</span>,
        <span class="font-medium text-slate-800 dark:text-slate-200">SKU</span>,
        <span class="font-medium text-slate-800 dark:text-slate-200">Barcode</span>,
        <span class="font-medium text-slate-800 dark:text-slate-200">Sale price</span>,
        and optionally
        <span class="font-medium text-slate-800 dark:text-slate-200">Cost price</span>,
        <span class="font-medium text-slate-800 dark:text-slate-200">Tax %</span>,
        <span class="font-medium text-slate-800 dark:text-slate-200">Qty on hand</span>,
        and
        <span class="font-medium text-slate-800 dark:text-slate-200">Opening balance</span>.
        Parsed rows appear below; only rows without errors are imported. Stock values apply to Inventory and POS after import.
      </p>
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <input
          ref="excelInputRef"
          type="file"
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
          class="block max-w-full rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          :disabled="importParsing"
          @change="onExcelFileSelected"
        />
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-x"
          :disabled="!importPreviewRows.length && !importPreviewMeta"
          @click="clearExcelImportPreview"
        >
          Clear preview
        </UButton>
      </div>
      <p v-if="importPreviewMeta" class="mb-2 text-xs text-slate-500">
        {{ importPreviewMeta.fileName }} — {{ importPreviewMeta.rowCount }} row(s) parsed · {{ validExcelRowCount }} ready to import
      </p>
      <div v-if="importPreviewRows.length" class="table-scroll table-scroll-bordered">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th class="px-3 py-2">#</th>
              <th class="px-3 py-2">Category</th>
              <th class="px-3 py-2">Product</th>
              <th class="px-3 py-2">SKU</th>
              <th class="px-3 py-2">Barcode</th>
              <th class="px-3 py-2">Sale</th>
              <th class="px-3 py-2">Cost</th>
              <th class="px-3 py-2">Tax %</th>
              <th class="px-3 py-2 text-right">Qty on hand</th>
              <th class="px-3 py-2 text-right">Opening bal.</th>
              <th class="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in importPreviewRows"
              :key="row.rowNumber"
              class="border-b border-slate-100 dark:border-slate-800"
              :class="{ 'bg-red-50/80 dark:bg-red-950/20': row.issues.length > 0 }"
            >
              <td class="px-3 py-2 text-slate-500">{{ row.rowNumber }}</td>
              <td class="px-3 py-2">{{ row.categoryName || '—' }}</td>
              <td class="px-3 py-2 font-medium">{{ row.name }}</td>
              <td class="px-3 py-2">{{ row.sku }}</td>
              <td class="px-3 py-2">{{ row.barcode }}</td>
              <td class="px-3 py-2">Rs {{ Number(row.salePrice).toLocaleString() }}</td>
              <td class="px-3 py-2">Rs {{ Number(row.costPrice).toLocaleString() }}</td>
              <td class="px-3 py-2">{{ row.taxRate }}</td>
              <td class="px-3 py-2 text-right tabular-nums">{{ Number(row.qtyOnHand).toLocaleString() }}</td>
              <td class="px-3 py-2 text-right tabular-nums">
                {{ row.openingBalance === null ? '—' : Number(row.openingBalance).toLocaleString() }}
              </td>
              <td class="px-3 py-2">
                <UBadge v-if="row.issues.length === 0" color="success" variant="soft">OK</UBadge>
                <span v-else class="text-xs text-red-700 dark:text-red-300">{{ row.issues.join('; ') }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="importPreviewRows.length" class="mt-3 flex flex-wrap gap-2">
        <UButton
          icon="i-lucide-upload-cloud"
          :loading="importApplying"
          :disabled="validExcelRowCount === 0"
          @click="applyExcelImport"
        >
          Import {{ validExcelRowCount }} valid row(s)
        </UButton>
      </div>
    </UCard>

    <UCard>
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">Products</h2>
        <div class="flex flex-wrap gap-2">
          <UButton
            v-if="canManageProducts && selectedProductCount > 0"
            color="error"
            variant="soft"
            icon="i-lucide-trash-2"
            :loading="bulkDeletingProducts"
            @click="openBulkDeleteProductsConfirm"
          >
            Delete selected ({{ selectedProductCount }})
          </UButton>
          <UButton color="neutral" variant="soft" icon="i-lucide-refresh-cw" :loading="isLoading" @click="reloadProductsNow">
            Refresh
          </UButton>
        </div>
      </div>

      <div class="mb-4 grid gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/50 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <UiLabeledField label="Search" html-for="prd-filter-search" class="min-w-0 xl:col-span-2">
          <UInput id="prd-filter-search" v-model="query" icon="i-lucide-search" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Category" class="min-w-0">
          <UiSearchableSelect v-model="filterCategoryIdModel" :items="filterCategoryItems" placeholder="Search category…" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Status" class="min-w-0">
          <UiSearchableSelect v-model="filterStatusModel" :items="statusFilterItems" placeholder="Search status…" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Min sale (Rs)" html-for="prd-min-sale" class="min-w-0">
          <UInput id="prd-min-sale" v-model="filterMinSale" type="number" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Max sale (Rs)" html-for="prd-max-sale" class="min-w-0">
          <UInput id="prd-max-sale" v-model="filterMaxSale" type="number" class="w-full" />
        </UiLabeledField>
        <UiLabeledField label="Sort" class="min-w-0">
          <UiSearchableSelect v-model="sortByModel" :items="sortSelectItems" placeholder="Search sort…" class="w-full" />
        </UiLabeledField>
      </div>
      <div class="mb-4 flex flex-wrap gap-2">
        <UButton icon="i-lucide-filter" :loading="isLoading" @click="reloadProductsNow">Apply filters</UButton>
        <UButton color="neutral" variant="outline" icon="i-lucide-x" @click="clearFilters(); reloadProductsNow()">
          Clear filters
        </UButton>
      </div>

      <div class="table-scroll">
        <table class="min-w-full text-left text-sm">
          <thead class="bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            <tr>
              <th v-if="canManageProducts" class="w-10 px-3 py-2">
                <UCheckbox :model-value="allProductsOnPageSelected" @update:model-value="toggleSelectAllProducts" />
              </th>
              <th class="px-3 py-2">Name</th>
              <th class="px-3 py-2">Image</th>
              <th class="px-3 py-2">SKU</th>
              <th class="px-3 py-2">Barcode</th>
              <th class="px-3 py-2">Category</th>
              <th class="px-3 py-2">Sale</th>
              <th class="px-3 py-2">Tax %</th>
              <th class="px-3 py-2">Status</th>
              <th class="px-3 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="product in products"
              :key="product.id"
              class="border-b border-slate-100 dark:border-slate-800"
              :class="{ 'bg-slate-50/90 dark:bg-slate-950/40': !product.is_active }"
            >
              <td v-if="canManageProducts" class="px-3 py-2" @click.stop>
                <UCheckbox
                  :model-value="selectedProductIds.has(product.id)"
                  @update:model-value="(v: boolean) => setProductSelected(product.id, v)"
                />
              </td>
              <td class="px-3 py-2 font-medium">{{ product.name }}</td>
              <td class="px-3 py-2">
                <img
                  v-if="product.image_url"
                  :src="product.image_url"
                  alt="Product"
                  class="h-10 w-10 rounded object-cover"
                />
                <span v-else class="text-slate-400">-</span>
              </td>
              <td class="px-3 py-2">{{ product.sku }}</td>
              <td class="px-3 py-2">{{ product.barcode }}</td>
              <td class="px-3 py-2">{{ product.category_name || '-' }}</td>
              <td class="px-3 py-2">Rs {{ Number(product.sale_price).toLocaleString() }}</td>
              <td class="px-3 py-2">{{ product.tax_rate }}</td>
              <td class="px-3 py-2">
                <UBadge :color="product.is_active ? 'success' : 'neutral'" variant="soft">
                  {{ product.is_active ? 'Enabled' : 'Disabled' }}
                </UBadge>
              </td>
              <td class="px-3 py-2">
                <div class="flex flex-wrap items-center gap-1">
                  <UButton
                    v-if="canManageProducts"
                    size="xs"
                    color="neutral"
                    variant="soft"
                    icon="i-lucide-power"
                    :loading="togglingProductId === product.id"
                    @click="toggleProductActive(product)"
                  >
                    {{ product.is_active ? 'Disable' : 'Enable' }}
                  </UButton>
                  <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-pencil" @click="openEditProduct(product)">
                    Edit
                  </UButton>
                  <UButton
                    v-if="canManageProducts"
                    size="xs"
                    color="error"
                    variant="soft"
                    icon="i-lucide-trash-2"
                    :loading="deletingProductId === product.id"
                    @click="openDeleteProductConfirm(product)"
                  >
                    Delete
                  </UButton>
                </div>
              </td>
            </tr>
            <tr v-if="!products.length && !isLoading">
              <td class="px-3 py-4 text-slate-500" :colspan="canManageProducts ? 10 : 9">No products found.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div
        v-if="productTotal > 0"
        class="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600 dark:text-slate-400"
      >
        <span>Showing {{ productRangeStart }}–{{ productRangeEnd }} of {{ productTotal }}</span>
        <div class="flex items-center gap-2">
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-chevron-left"
            :disabled="productPage <= 1 || isLoading"
            @click="setProductPage(productPage - 1)"
          />
          <span class="tabular-nums">Page {{ productPage }} / {{ productPageCount }}</span>
          <UButton
            size="xs"
            color="neutral"
            variant="soft"
            icon="i-lucide-chevron-right"
            :disabled="productPage >= productPageCount || isLoading"
            @click="setProductPage(productPage + 1)"
          />
        </div>
      </div>
    </UCard>

    <div
      v-if="isCategoryEditModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="isCategoryEditModalOpen = false"
    >
      <div class="w-full max-w-lg rounded-xl bg-white p-4 shadow-2xl dark:bg-slate-900">
        <h3 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Edit Category</h3>
        <div class="grid gap-4">
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-cat-edit-name">Category name</label>
            <UInput id="prd-cat-edit-name" v-model="editCategoryForm.name" class="w-full" placeholder="Category name" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-cat-edit-desc">Description</label>
            <UTextarea id="prd-cat-edit-desc" v-model="editCategoryForm.description" class="w-full" placeholder="Optional description" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-cat-edit-dept">Department</label>
            <UiSearchableSelect
              id="prd-cat-edit-dept"
              v-model="editCategoryDepartmentSelectModel"
              class="w-full"
              :items="categoryDepartmentEditItems"
              placeholder="Search department…"
            />
          </div>
          <div class="mt-2 flex justify-end gap-2">
            <UButton color="neutral" variant="soft" @click="isCategoryEditModalOpen = false">Cancel</UButton>
            <UButton icon="i-lucide-save" @click="updateCategory">Update Category</UButton>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="isEditModalOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      @click.self="isEditModalOpen = false"
    >
      <div class="w-full max-w-2xl rounded-xl bg-white p-4 shadow-2xl dark:bg-slate-900">
        <h3 class="mb-3 text-lg font-semibold text-slate-900 dark:text-slate-100">Edit Product</h3>
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-edit-name">Product name</label>
            <UInput id="prd-edit-name" v-model="editForm.name" class="w-full" placeholder="Product name" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-edit-sku">SKU</label>
            <UInput id="prd-edit-sku" v-model="editForm.sku" class="w-full" placeholder="SKU" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-edit-barcode">Barcode</label>
            <UInput id="prd-edit-barcode" v-model="editForm.barcode" class="w-full" placeholder="Barcode" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-edit-sale">Sale price</label>
            <UInput id="prd-edit-sale" v-model.number="editForm.salePrice" class="w-full" type="number" placeholder="0.00" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-edit-cost">Cost price</label>
            <UInput id="prd-edit-cost" v-model.number="editForm.costPrice" class="w-full" type="number" placeholder="0.00" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-edit-tax">Tax %</label>
            <UInput id="prd-edit-tax" v-model.number="editForm.taxRate" class="w-full" type="number" placeholder="0" />
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-edit-category">Category</label>
            <UiSearchableSelect id="prd-edit-category" v-model="editCategorySelectModel" class="w-full" :items="categorySelectItems" placeholder="Search category…" />
          </div>

          <div class="sm:col-span-2">
            <UCheckbox v-model="editActiveCheckModel" name="edit-product-active" label="Active (available on POS / billing)" />
          </div>

          <div class="sm:col-span-2 flex min-w-0 flex-col gap-1.5">
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-300" for="prd-edit-image">Product image (optional)</label>
            <input
              id="prd-edit-image"
              ref="editImageInputRef"
              type="file"
              accept="image/*"
              class="block w-full rounded-lg border border-slate-200 bg-white p-2 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              @change="onEditProductImageSelected"
            />
            <div class="flex items-center gap-3">
              <img
                :src="editImagePreview || 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2764%27 height=%2764%27 viewBox=%270 0 64 64%27%3E%3Crect width=%2764%27 height=%2764%27 fill=%27%23e2e8f0%27/%3E%3Cpath d=%27M16 22h32v20H16z%27 fill=%27%2394a3b8%27/%3E%3Ccircle cx=%2726%27 cy=%2730%27 r=%273%27 fill=%27%23e2e8f0%27/%3E%3Cpath d=%27M20 42l8-7 5 4 7-6 8 9z%27 fill=%27%23cbd5e1%27/%3E%3C/svg%3E'"
                alt="Edit product image"
                class="h-12 w-12 rounded object-cover"
              />
              <UButton
                color="neutral"
                variant="soft"
                size="xs"
                icon="i-lucide-x"
                :disabled="!editForm.imageUrl"
                @click="clearEditImage"
              >
                Remove image
              </UButton>
            </div>
          </div>

          <div class="sm:col-span-2 mt-2 flex justify-end gap-2">
            <UButton color="neutral" variant="soft" @click="isEditModalOpen = false">Cancel</UButton>
            <UButton icon="i-lucide-save" @click="updateProduct">Update Product</UButton>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="deleteConfirmOpen"
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      @click.self="closeDeleteConfirm"
    >
      <div
        class="w-full max-w-md rounded-xl bg-white p-5 shadow-2xl dark:bg-slate-900"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-desc"
      >
        <div class="mb-4 flex items-start gap-3">
          <div
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400"
          >
            <UIcon name="i-lucide-trash-2" class="h-5 w-5" />
          </div>
          <div>
            <h3 id="delete-confirm-title" class="text-lg font-semibold text-slate-900 dark:text-slate-100">
              {{ deleteConfirmTitle }}
            </h3>
            <p id="delete-confirm-desc" class="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {{ deleteConfirmDescription }}
            </p>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="soft" :disabled="deleteConfirmLoading" @click="closeDeleteConfirm">
            Cancel
          </UButton>
          <UButton
            color="error"
            icon="i-lucide-trash-2"
            :loading="deleteConfirmLoading"
            @click="confirmDeleteAction"
          >
            Delete
          </UButton>
        </div>
      </div>
    </div>
  </section>
</template>
