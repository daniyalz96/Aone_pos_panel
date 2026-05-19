import { computed } from 'vue'
import { useAuth } from '~/composables/useAuth'

export type AppLink = {
  label: string
  icon: string
  to: string
  /** If set, link is shown only when the user has one of these roles */
  roles?: string[]
}

const allLinks: AppLink[] = [
  { label: 'Dashboard', icon: 'i-lucide-layout-dashboard', to: '/dashboard' },
  { label: 'Billing POS', icon: 'i-lucide-receipt', to: '/pos' },
  { label: 'Products', icon: 'i-lucide-package', to: '/products' },
  { label: 'Inventory', icon: 'i-lucide-boxes', to: '/inventory' },
  { label: 'Suppliers', icon: 'i-lucide-truck', to: '/suppliers' },
  { label: 'Purchases', icon: 'i-lucide-file-input', to: '/purchases' },
  { label: 'Purchase returns', icon: 'i-lucide-package-minus', to: '/purchase-returns' },
  { label: 'Customers', icon: 'i-lucide-users', to: '/customers' },
  { label: 'Expenses', icon: 'i-lucide-wallet', to: '/expenses' },
  { label: 'Reports', icon: 'i-lucide-chart-column-big', to: '/reports' },
  {
    label: 'Ledger & GL',
    icon: 'i-lucide-book-text',
    to: '/ledger',
    roles: ['admin', 'manager']
  },
  { label: 'Shift Close', icon: 'i-lucide-wallet-cards', to: '/shift' },
  { label: 'Settings', icon: 'i-lucide-settings', to: '/settings' }
]

export const useAppNavigation = () => {
  const { user } = useAuth()

  const links = computed(() => {
    const roleSet = new Set(user.value?.roles ?? [])
    return allLinks.filter((link) => {
      if (!link.roles?.length) return true
      return link.roles.some((r) => roleSet.has(r))
    })
  })

  return { links }
}
