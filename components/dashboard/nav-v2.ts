import type { LucideIcon } from 'lucide-react'
import {
  CheckSquare,
  Sparkles,
  ArrowLeftRight,
  ReceiptText,
  Wallet,
  BookOpen,
  HandCoins,
  Percent,
  BarChart3,
  FileCheck,
  Landmark,
  Puzzle,
  HelpCircle,
  Settings,
} from 'lucide-react'
import { EXTENSION_REQUIRED_CAPABILITY, type CapabilityKey } from '@/lib/entitlements/keys'
import type { EntityType } from '@/types'

/**
 * Visibility gates shared by the v1 nav items and the v2 tree. DashboardNav
 * evaluates them once (passesGates) so a surface hides for exactly the same
 * reason in both shells.
 */
export interface NavGateFlags {
  href: string
  employerOnly?: boolean
  requiresDimensions?: boolean
  requiresSalesOrders?: boolean
  requiresWebshop?: boolean
  requiresMileage?: boolean
  requiresExpenses?: boolean
  requiredCapability?: CapabilityKey
  entityOnly?: EntityType
  byraOnly?: boolean
  hidden?: boolean
  comingSoon?: boolean
  betaBadge?: boolean
}

/**
 * Shell v2 sidebar tree (dev_docs/ui_v2_build_plan.md, PR 2). Sections are
 * the prototype's BOLAGET list; a section's sub-items render under it while
 * the section is active, so nothing the v1 rail reached becomes a dead end.
 * Every href here already has a page; PR 3 to PR 8 change what the pages
 * show, not where they live.
 */
export interface NavV2Item extends NavGateFlags {
  labelKey: string
  icon?: LucideIcon
  sub?: NavV2Item[]
}

export const NAV_V2_TOP: NavV2Item[] = [
  {
    href: '/',
    labelKey: 'v2_todo',
    icon: CheckSquare,
    sub: [{ href: '/pending', labelKey: 'v2_proposals' }],
  },
  {
    href: '/chat',
    labelKey: 'assistant',
    icon: Sparkles,
    sub: [{ href: '/agent-knowledge', labelKey: 'agent_knowledge' }],
  },
]

export const NAV_V2_COMPANY: NavV2Item[] = [
  {
    href: '/accounts',
    labelKey: 'v2_accounts',
    icon: Landmark,
    sub: [
      { href: '/accounts', labelKey: 'v2_accounts_overview' },
      { href: '/settings/banking', labelKey: 'v2_bank_accounts' },
      { href: '/skattekonto', labelKey: 'skattekonto' },
      { href: '/reconciliation', labelKey: 'reconciliation' },
    ],
  },
  {
    href: '/transactions',
    labelKey: 'transactions',
    icon: ArrowLeftRight,
    sub: [
      { href: '/parties', labelKey: 'v2_parties' },
      { href: '/rules', labelKey: 'v2_rules' },
    ],
  },
  {
    href: '/invoices',
    labelKey: 'v2_invoicing',
    icon: ReceiptText,
    sub: [
      { href: '/invoices', labelKey: 'invoices' },
      { href: '/invoices/recurring', labelKey: 'v2_recurring' },
      { href: '/sales-orders', labelKey: 'sales_orders', requiresSalesOrders: true },
      { href: '/orders', labelKey: 'webshop_orders', requiresWebshop: true, betaBadge: true },
      { href: '/customers', labelKey: 'customers' },
      { href: '/articles', labelKey: 'articles' },
    ],
  },
  {
    href: '/supplier-invoices',
    labelKey: 'v2_purchases',
    icon: Wallet,
    sub: [
      { href: '/supplier-invoices', labelKey: 'supplier_invoices' },
      {
        href: '/e/general/invoice-inbox',
        labelKey: 'invoice_inbox',
        requiredCapability: EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox'],
      },
      { href: '/expenses', labelKey: 'expenses', requiresExpenses: true },
      { href: '/mileage', labelKey: 'mileage', requiresMileage: true },
      { href: '/supplier-invoices/payment-files', labelKey: 'v2_payment_files' },
      { href: '/suppliers', labelKey: 'suppliers' },
    ],
  },
  {
    href: '/bookkeeping',
    labelKey: 'bookkeeping',
    icon: BookOpen,
    sub: [
      { href: '/bookkeeping', labelKey: 'v2_vouchers' },
      { href: '/chart-of-accounts', labelKey: 'chart_of_accounts' },
      { href: '/bookkeeping/periodiseringar', labelKey: 'periodiseringar' },
      { href: '/assets', labelKey: 'assets' },
      { href: '/dimensions', labelKey: 'dimensions', requiresDimensions: true },
      { href: '/import', labelKey: 'import' },
    ],
  },
  {
    href: '/salary',
    labelKey: 'salary',
    icon: HandCoins,
    employerOnly: true,
    sub: [
      { href: '/salary', labelKey: 'v2_salary_runs' },
      { href: '/salary/employees', labelKey: 'employees' },
    ],
  },
  {
    href: '/reports/vat-declaration',
    labelKey: 'v2_tax',
    icon: Percent,
    sub: [
      { href: '/reports/vat-declaration', labelKey: 'vat_declaration' },
      { href: '/deadlines', labelKey: 'deadlines' },
    ],
  },
  {
    href: '/reports',
    labelKey: 'reports',
    icon: BarChart3,
    sub: [
      { href: '/reports', labelKey: 'reports' },
      { href: '/kpi', labelKey: 'kpi' },
    ],
  },
  {
    href: '/bookkeeping/year-end',
    labelKey: 'v2_closing',
    icon: FileCheck,
    sub: [
      { href: '/bookkeeping/year-end', labelKey: 'year_end' },
      { href: '/bookkeeping/year-end/arsredovisning', labelKey: 'annual_report', entityOnly: 'aktiebolag' },
      { href: '/reports/ink2-declaration', labelKey: 'income_declaration', entityOnly: 'aktiebolag' },
      { href: '/reports/ne-declaration', labelKey: 'income_declaration', entityOnly: 'enskild_firma' },
    ],
  },
]

export const NAV_V2_BOTTOM: NavV2Item[] = [
  { href: '/extensions', labelKey: 'extensions', icon: Puzzle },
  { href: '/help', labelKey: 'help', icon: HelpCircle },
  { href: '/settings', labelKey: 'settings', icon: Settings },
]

/**
 * Longest matching sub-item wins, so /invoices/recurring lights up
 * Återkommande and not Kundfakturor as well.
 */
export function activeSubHref(item: NavV2Item, isActive: (href: string) => boolean): string | null {
  const matches = (item.sub ?? []).filter((s) => isActive(s.href))
  if (matches.length === 0) return null
  return matches.reduce((best, s) => (s.href.length > best.href.length ? s : best)).href
}
