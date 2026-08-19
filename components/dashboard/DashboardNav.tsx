'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  LayoutDashboard,
  Home,
  ReceiptText,
  Users,
  ArrowLeftRight,
  BookOpen,
  ListTree,
  BarChart3,
  Settings,
  LogOut,
  Upload,
  Inbox,
  Menu,
  X,
  HelpCircle,
  Building2,
  Wallet,
  TrendingUp,
  ClipboardCheck,
  HandCoins,
  Package,
  Tag,
  Tags,
  ChevronRight,
  Sparkles,
  Percent,
  Landmark,
  CalendarClock,
  CalendarRange,
  FileCheck,
  FileSpreadsheet,
  ScrollText,
  PanelLeft,
  PanelLeftClose,
  Library,
  BookCheck,
  ShoppingCart,
  Car,
} from 'lucide-react'
import { getBranding } from '@/lib/branding/service'
import { ENABLED_EXTENSION_IDS as _ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import { SupportLink } from '@/components/ui/support-link'
import CompanySwitcher from '@/components/dashboard/CompanySwitcher'
import UserMenu from '@/components/dashboard/UserMenu'
import SubscriptionTouchpoint from '@/components/billing/SubscriptionTouchpoint'
import AgentAvatar from '@/components/agent/AgentAvatar'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { useCompany } from '@/contexts/CompanyContext'
import { useRealtimeSupabase } from '@/lib/hooks/use-realtime-supabase'
import { useWorklistBadges } from '@/lib/hooks/use-worklist-badges'
import { persistUiState } from '@/lib/ui-state/client'
import { EXTENSION_REQUIRED_CAPABILITY, type CapabilityKey } from '@/lib/entitlements/keys'
import type { EntityType, UserUiState } from '@/types'

void _ENABLED_EXTENSION_IDS

interface ExtensionNavItem {
  href: string
  label: string
  icon: string
}

interface DashboardNavProps {
  companyName: string
  entityType: EntityType
  // Whether the company has registered as an employer (company_settings.
  // pays_salaries). Drives visibility of the payroll (Personal) section for
  // non-aktiebolag, notably an enskild firma that hires staff. See #782.
  paysSalaries?: boolean
  // Whether the dimensions register (company_settings.dimensions_enabled) is
  // switched on. Drives visibility of the Kostnadsställen & projekt row:
  // same mechanism as paysSalaries: fetched by the dashboard layout.
  dimensionsEnabled?: boolean
  // Whether the company has a webshop hooked up (active WooCommerce/Shopify
  // connection, or existing webshop_orders rows). Drives visibility of the
  // Order row: same mechanism as paysSalaries, fetched by the layout.
  hasWebshop?: boolean
  // Whether the Körjournal row shows: the company_settings.mileage_enabled
  // toggle OR existing mileage_trips rows (trips created via API/MCP must
  // stay reachable). Computed by the dashboard layout.
  hasMileage?: boolean
  isSandbox?: boolean
  extensionNavItems?: ExtensionNavItem[]
  // Signed-in user's full name + email: drives the bottom-left account
  // popover trigger so the user can see WHO they're logged in as,
  // distinct from the active COMPANY shown by CompanySwitcher up top.
  userName?: string | null
  userEmail?: string | null
  // Server-read user_preferences.ui_state: seeds sidebar collapse + fold
  // state so the first client render matches the server-stamped width.
  initialUiState?: UserUiState
}

type NavLabelKey =
  | 'dashboard'
  | 'home'
  | 'assistant'
  | 'agent_knowledge'
  | 'kpi'
  | 'invoice_inbox'
  | 'invoices'
  | 'sales_orders'
  | 'customers'
  | 'articles'
  | 'supplier_invoices'
  | 'suppliers'
  | 'review'
  | 'transactions'
  | 'bookkeeping'
  | 'chart_of_accounts'
  | 'dimensions'
  | 'assets'
  | 'reports'
  | 'import'
  | 'salary'
  | 'mileage'
  | 'employees'
  | 'vat_declaration'
  | 'skattekonto'
  | 'deadlines'
  | 'periodiseringar'
  | 'year_end'
  | 'annual_report'
  | 'income_declaration'
  | 'help'
  | 'settings'

// Nav layout (July 2026, UI-migration concept, dev_docs/ui_migration_plan.md
// PR 2): same routes, concept structure.
//   top of rail          : collapse toggle (64px icon rail when collapsed;
//                          state persists in user_preferences.ui_state).
//   top section          : flat, no header: Hem, Assistent (Flöden joins
//                          when the flow engine exists).
//   four groups          : static headers (Arbeta, Analys, Data,
//                          Skatt & bokslut); the Register (Data) and
//                          Bokslut (Skatt) sub-lists are animated folds.
//   bottom user block    : sticky; avatar + name + active company, opens
//                          the upward UserMenu with the company-switcher
//                          flyout, account links and logout.
// Help + Settings are NOT in `navItems`; they live in the user menu.
// Pending (Granskning) stays visible at all times: the badge carries the count.
type GroupKey = 'top' | 'arbeta' | 'analys' | 'data' | 'skatt'
// Folds: collapsible sub-lists inside a group (concept: Register under DATA,
// Bokslut under SKATT & BOKSLUT). Child rows render text-indented behind a
// hairline; open/closed state persists in user_preferences.ui_state.
type FoldKey = 'register' | 'bokslut'

interface NavItem {
  href: string
  labelKey: NavLabelKey
  icon: typeof LayoutDashboard
  group: GroupKey
  // When set, the item renders inside this fold (consecutive items with the
  // same fold key form one fold block at that position in the group).
  fold?: FoldKey
  // Payroll surfaces: visible only to employers: every aktiebolag (unchanged
  // behaviour) plus any company that has registered as an employer via
  // company_settings.pays_salaries (e.g. an enskild firma with staff). #782
  employerOnly?: boolean
  // Dimension surfaces: visible only when the company has opted in via
  // company_settings.dimensions_enabled (UI-visibility gate only; the pages
  // and APIs work regardless, dimensions plan §2).
  requiresDimensions?: boolean
  // Webshop surfaces: visible only when the company has an active
  // WooCommerce/Shopify connection or already-imported order rows.
  // UI-visibility gate only; the page and APIs work regardless.
  requiresWebshop?: boolean
  // Körjournal surfaces: visible only when the company has opted in via the
  // bookkeeping settings toggle (company_settings.mileage_enabled) or already
  // has trips. UI-visibility gate only; the page and APIs work regardless.
  requiresMileage?: boolean
  // Paywall surfaces: hidden unless the active company holds this paid
  // capability. Cosmetic only, the page and API gates are the real
  // enforcement; this just keeps the sidebar honest for non-payers.
  requiredCapability?: CapabilityKey
  // Statutory surfaces that only exist for one company form (INK2 vs
  // NE-bilaga, årsredovisning): hidden for the other entity type.
  entityOnly?: EntityType
  hidden?: boolean
  comingSoon?: boolean
  devBadge?: boolean
  betaBadge?: boolean
}

// Nav layout per the UI-migration concept (ui_migration_plan.md PR 2):
// same destinations, concept ordering, with the Register and Bokslut
// sub-lists as folds.
const navItems: NavItem[] = [
  // Top section: flat list, always visible, no header. (Flöden joins here
  // when the flow engine exists.)
  { href: '/', labelKey: 'home', icon: Home, group: 'top' },
  { href: '/chat', labelKey: 'assistant', icon: Sparkles, group: 'top' },
  // Arbeta: everything the user produces, bookkeeping funnel first
  // (Bokföring · Underlag · Transaktioner · Granskning), then the
  // transactional flows. employerOnly: aktiebolag or pays_salaries. #782
  { href: '/bookkeeping', labelKey: 'bookkeeping', icon: BookOpen, group: 'arbeta' },
  { href: '/e/general/invoice-inbox', labelKey: 'invoice_inbox', icon: Inbox, group: 'arbeta', requiredCapability: EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox'] },
  { href: '/transactions', labelKey: 'transactions', icon: ArrowLeftRight, group: 'arbeta' },
  { href: '/pending', labelKey: 'review', icon: ClipboardCheck, group: 'arbeta' },
  { href: '/invoices', labelKey: 'invoices', icon: ReceiptText, group: 'arbeta' },
  // Webshop orders: visible only for companies that actually have a webshop
  // hooked up (active WooCommerce/Shopify connection or existing order rows).
  // Deliberately NOT capability-gated: a company whose entitlement lapsed
  // must still reach its already-imported orders (accounting underlag).
  { href: '/orders', labelKey: 'sales_orders', icon: ShoppingCart, group: 'arbeta', requiresWebshop: true, betaBadge: true },
  { href: '/supplier-invoices', labelKey: 'supplier_invoices', icon: Wallet, group: 'arbeta' },
  { href: '/salary', labelKey: 'salary', icon: HandCoins, group: 'arbeta', employerOnly: true },
  // Körjournal: hidden by default (most companies have no car); shows when
  // the settings toggle is on or trips already exist (hybrid gate, same
  // "data stays reachable" reasoning as the Order row above).
  { href: '/mileage', labelKey: 'mileage', icon: Car, group: 'arbeta', requiresMileage: true },
  // Analys: read the numbers.
  { href: '/kpi', labelKey: 'kpi', icon: TrendingUp, group: 'analys' },
  { href: '/reports', labelKey: 'reports', icon: BarChart3, group: 'analys' },
  // Data: the Register fold (master data) + Importera/exportera as its own
  // row. Anställda is a register (you edit an employee rarely, you run
  // payroll monthly), so it lives here while Löner stays in Arbeta.
  { href: '/customers', labelKey: 'customers', icon: Users, group: 'data', fold: 'register' },
  { href: '/suppliers', labelKey: 'suppliers', icon: Building2, group: 'data', fold: 'register' },
  { href: '/articles', labelKey: 'articles', icon: Tag, group: 'data', fold: 'register' },
  { href: '/salary/employees', labelKey: 'employees', icon: Users, group: 'data', fold: 'register', employerOnly: true },
  { href: '/assets', labelKey: 'assets', icon: Package, group: 'data', fold: 'register' },
  { href: '/chart-of-accounts', labelKey: 'chart_of_accounts', icon: ListTree, group: 'data', fold: 'register' },
  { href: '/dimensions', labelKey: 'dimensions', icon: Tags, group: 'data', fold: 'register', requiresDimensions: true },
  { href: '/import', labelKey: 'import', icon: Upload, group: 'data' },
  // Skatt & bokslut: everything submitted to the state; the year-end chain
  // (periodiseringar → årsbokslut → årsredovisning → inkomstdeklaration)
  // lives in the Bokslut fold in workflow order; the last two are
  // entity-gated because the surface only exists for one company form.
  { href: '/reports/vat-declaration', labelKey: 'vat_declaration', icon: Percent, group: 'skatt' },
  { href: '/skattekonto', labelKey: 'skattekonto', icon: Landmark, group: 'skatt' },
  { href: '/deadlines', labelKey: 'deadlines', icon: CalendarClock, group: 'skatt' },
  { href: '/bookkeeping/periodiseringar', labelKey: 'periodiseringar', icon: CalendarRange, group: 'skatt', fold: 'bokslut' },
  { href: '/bookkeeping/year-end', labelKey: 'year_end', icon: FileCheck, group: 'skatt', fold: 'bokslut' },
  { href: '/bookkeeping/year-end/arsredovisning', labelKey: 'annual_report', icon: ScrollText, group: 'skatt', fold: 'bokslut', entityOnly: 'aktiebolag' },
  { href: '/reports/ink2-declaration', labelKey: 'income_declaration', icon: FileSpreadsheet, group: 'skatt', fold: 'bokslut', entityOnly: 'aktiebolag' },
  { href: '/reports/ne-declaration', labelKey: 'income_declaration', icon: FileSpreadsheet, group: 'skatt', fold: 'bokslut', entityOnly: 'enskild_firma' },
]

// Fold header presentation (label + icon). The fold rows themselves come
// from navItems entries carrying the matching `fold` key.
const foldConfig: Record<FoldKey, { labelKey: string; icon: typeof LayoutDashboard }> = {
  register: { labelKey: 'fold_register', icon: Library },
  bokslut: { labelKey: 'fold_bokslut', icon: BookCheck },
}

// Splits a group's items into a render sequence of plain items and fold
// blocks (consecutive same-fold items become one block).
type NavSegment =
  | { type: 'item'; item: NavItem }
  | { type: 'fold'; key: FoldKey; items: NavItem[] }

function segmentItems(items: NavItem[]): NavSegment[] {
  const segments: NavSegment[] = []
  for (const item of items) {
    if (item.fold) {
      const last = segments[segments.length - 1]
      if (last && last.type === 'fold' && last.key === item.fold) {
        last.items.push(item)
      } else {
        segments.push({ type: 'fold', key: item.fold, items: [item] })
      }
    } else {
      segments.push({ type: 'item', item })
    }
  }
  return segments
}

// Map known extension hrefs to nav translation keys so sidebar labels translate.
// Extensions whose manifest label happens to be English-ready can stay null.
function extensionLabelKey(href: string): string | null {
  if (href === '/e/general/tic') return 'ext_tic'
  if (href === '/e/general/invoice-inbox') return 'ext_invoice_inbox'
  return null
}

const groupLabelKey: Record<Exclude<GroupKey, 'top'>, string> = {
  arbeta: 'group_work',
  analys: 'group_analysis',
  data: 'group_data',
  skatt: 'group_tax',
}

export default function DashboardNav({ companyName: _companyName, entityType, paysSalaries = false, dimensionsEnabled = false, hasWebshop = false, hasMileage = false, isSandbox = false, extensionNavItems = [], userName = null, userEmail = null, initialUiState }: DashboardNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = useRealtimeSupabase()
  const { company, capabilities } = useCompany()
  // Agent identity drives the "Assistent" nav icon: when the user has
  // built their assistant we show its chosen avatar instead of the
  // generic Sparkles glyph.
  const { identity: agentIdentity } = useAgentSheet()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Badge counts load client-side after mount (and revalidate via the
  // realtime subscriptions below). They used to arrive as server props, which
  // put two head-count queries on the critical path of every dashboard
  // navigation for numbers nobody needs before first paint.
  const {
    uncategorized: uncategorizedCount,
    pendingOperations: pendingOpsCount,
    refresh: refreshBadges,
  } = useWorklistBadges(company?.id)
  const hasCompany = !!company
  const ALWAYS_ENABLED = new Set(['/settings'])
  const isItemEnabled = (href: string) => hasCompany || ALWAYS_ENABLED.has(href)
  type ExpandableGroup = Exclude<GroupKey, 'top'>

  // Sidebar collapse (64px icon rail). The width is CSS-variable-driven:
  // #dash-shell sets --nav-w inline (server-rendered from ui_state), and
  // both the aside and <main> read it, so one property flip resizes the
  // whole shell in lockstep. The React state only drives which sidebar
  // variant renders.
  const [collapsed, setCollapsed] = useState(initialUiState?.nav_collapsed === true)
  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    document
      .getElementById('dash-shell')
      ?.style.setProperty('--nav-w', next ? '64px' : '248px')
    persistUiState({ nav_collapsed: next })
  }

  // Fold state (Register, Bokslut). Closed by default; an active child
  // route forces its fold open so deep links never land in a hidden row.
  const [foldsOpen, setFoldsOpen] = useState<Record<FoldKey, boolean>>({
    register: initialUiState?.nav_folds?.register ?? false,
    bokslut: initialUiState?.nav_folds?.bokslut ?? false,
  })
  const toggleFold = (key: FoldKey) => {
    setFoldsOpen((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      persistUiState({ nav_folds: { [key]: next[key] } })
      return next
    })
  }
  const isFoldOpen = (key: FoldKey, items: NavItem[]) =>
    foldsOpen[key] || items.some((it) => isActive(it.href))

  const openMobileMenu = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setIsClosing(false)
    setIsMobileMenuOpen(true)
  }

  const handleLogout = async () => {
    resetAnalyticsIdentity()
    await supabase.auth.signOut()
    router.push(isSandbox ? '/sandbox' : '/login')
  }

  const isActive = (href: string) => {
    if (href === '/') {
      return pathname === '/'
    }
    if (href === '/salary') {
      return pathname === '/salary' || pathname.startsWith('/salary/runs')
    }
    // Routes with their own rows under Skatt & bokslut (Bokslut, Moms,
    // Periodiseringar, Årsredovisning, Inkomstdeklaration) are carved out
    // of their parent routes so exactly one row lights up.
    if (href === '/bookkeeping') {
      return (
        pathname.startsWith('/bookkeeping') &&
        !pathname.startsWith('/bookkeeping/year-end') &&
        !pathname.startsWith('/bookkeeping/periodiseringar')
      )
    }
    if (href === '/bookkeeping/year-end') {
      return (
        pathname.startsWith('/bookkeeping/year-end') &&
        !pathname.startsWith('/bookkeeping/year-end/arsredovisning')
      )
    }
    if (href === '/reports') {
      return (
        pathname.startsWith('/reports') &&
        !pathname.startsWith('/reports/vat-declaration') &&
        !pathname.startsWith('/reports/ink2-declaration') &&
        !pathname.startsWith('/reports/ne-declaration')
      )
    }
    return pathname.startsWith(href)
  }

  const closeMobileMenu = () => {
    setIsClosing(true)
    closeTimerRef.current = setTimeout(() => {
      setIsMobileMenuOpen(false)
      setIsClosing(false)
      closeTimerRef.current = null
    }, 200)
  }

  useEffect(() => {
    if (!company?.id) return

    // Realtime keeps the badges live; a trailing debounce collapses event
    // bursts (bulk booking / bulk approvals emit one event per row) into a
    // single SWR revalidation instead of a request stampede.
    let debounce: ReturnType<typeof setTimeout> | null = null
    const queueRefresh = () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => void refreshBadges(), 400)
    }

    const channel = supabase
      .channel(`dashboard-nav:badges:${company.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'transactions',
          filter: `company_id=eq.${company.id}`,
        },
        queueRefresh,
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'pending_operations',
          filter: `company_id=eq.${company.id}`,
        },
        queueRefresh,
      )
      .subscribe()

    return () => {
      if (debounce) clearTimeout(debounce)
      void supabase.removeChannel(channel)
    }
  }, [company?.id, supabase, refreshBadges])

  const hiddenNavHrefs = new Set(getBranding().hiddenNavHrefs)

  // Render a nav item's leading glyph. The "Assistent" entry (/chat) shows
  // the agent's chosen avatar once built; everything else (and the
  // pre-onboarding /chat) uses its lucide icon. The passed className carries
  // size + margin + active color; tailwind-merge lets the explicit h/w win
  // over AgentAvatar's default box size.
  const renderNavIcon = (
    item: { href: string; icon: typeof LayoutDashboard },
    className: string,
  ) => {
    if (item.href === '/chat' && agentIdentity.avatarId) {
      return (
        <AgentAvatar
          avatarId={agentIdentity.avatarId}
          size="xs"
          alt={agentIdentity.displayName ?? 'Assistent'}
          className={className}
        />
      )
    }
    const Icon = item.icon
    return <Icon className={className} />
  }

  const isEmployer = entityType === 'aktiebolag' || paysSalaries

  const filteredItems = navItems.filter(item => {
    if (item.hidden) return false
    if (hiddenNavHrefs.has(item.href)) return false
    // Payroll (employerOnly) is hidden until the company is an employer, an
    // aktiebolag, or any entity that has flagged pays_salaries. #782
    if (item.employerOnly && !isEmployer) return false
    // Dimension surfaces are hidden until the company opts in via the
    // bookkeeping settings toggle (company_settings.dimensions_enabled).
    if (item.requiresDimensions && !dimensionsEnabled) return false
    // Webshop surfaces are hidden until a store is connected (or order rows
    // already exist from a since-disconnected store).
    if (item.requiresWebshop && !hasWebshop) return false
    // Körjournal is hidden until the company opts in via the bookkeeping
    // settings toggle (or trips already exist, e.g. created via MCP).
    if (item.requiresMileage && !hasMileage) return false
    // Paywalled surfaces (e.g. the AI-only Dokumentinkorg) are hidden unless
    // the active company holds the capability. The page + API gates enforce
    // the paywall; this keeps the sidebar from advertising a dead workspace.
    if (item.requiredCapability && !capabilities.includes(item.requiredCapability)) return false
    // Entity-gated statutory surfaces: INK2/ÅR for aktiebolag, NE for
    // enskild firma; the page for the other form doesn't exist.
    if (item.entityOnly && item.entityOnly !== entityType) return false
    // Hide the Assistent (/chat) tab until the agent is built: mirrors the
    // floating AgentTrigger and avoids a nav entry that only bounces to the
    // home checklist (chat/layout redirects unverified users to /).
    if (item.href === '/chat' && !agentIdentity.isVerified) return false
    // Granskning stays in the top nav at all times now: the badge
    // surfaces the count when there are pending ops, but the link is
    // always present so users can navigate there manually.
    return true
  })

  const topItems = filteredItems.filter((i) => i.group === 'top')

  // The TIC workspace (/e/general/tic, labelled "Företagsprofil") surfaces
  // the same Bolagsuppgifter now shown under Inställningar → Företagsprofil.
  // Drop it from the nav so the company profile lives in exactly one place.
  const visibleExtensionNavItems = extensionNavItems.filter(
    (i) => i.href !== '/e/general/tic',
  )

  const sidebarGroups: { key: ExpandableGroup; items: NavItem[] }[] = [
    { key: 'arbeta', items: filteredItems.filter((i) => i.group === 'arbeta') },
    { key: 'analys', items: filteredItems.filter((i) => i.group === 'analys') },
    { key: 'data', items: filteredItems.filter((i) => i.group === 'data') },
    { key: 'skatt', items: filteredItems.filter((i) => i.group === 'skatt') },
  ]

  // Flat leaf list for the collapsed 64px icon rail: fold children render
  // as plain icons (group headers and fold headers disappear).
  const railItems = [...topItems, ...sidebarGroups.flatMap(({ items }) => items)]

  const allMobileNavItems: { href: string; labelKey: NavLabelKey; icon: typeof LayoutDashboard }[] = [
    { href: '/', labelKey: 'home', icon: Home },
    { href: '/chat', labelKey: 'assistant', icon: Sparkles },
    { href: '/transactions', labelKey: 'transactions', icon: ArrowLeftRight },
  ]
  // Same gate as the sidebar: no Assistent tab until the agent is built.
  const mobileNavItems = allMobileNavItems.filter(
    (item) => item.href !== '/chat' || agentIdentity.isVerified,
  )

  const renderBadge = (item: NavItem | { comingSoon?: boolean; devBadge?: boolean; betaBadge?: boolean }, position: 'sidebar' | 'mobile') => {
    const baseClass =
      position === 'sidebar'
        ? 'ml-auto rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5'
        : 'rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5'
    if (item.comingSoon) return <span className={baseClass}>{tNav('badge_coming_soon')}</span>
    if (item.devBadge) return <span className={baseClass}>{tNav('badge_dev')}</span>
    if (item.betaBadge) return <span className={baseClass}>{tNav('badge_beta')}</span>
    return null
  }

  const badgeFor = (href: string): number | null =>
    href === '/transactions' && uncategorizedCount > 0
      ? uncategorizedCount
      : href === '/pending' && pendingOpsCount > 0
        ? pendingOpsCount
        : null

  const countBubble = (badge: number) => (
    <span data-ph-mask className="ml-auto min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold px-1">
      {badge > 99 ? '99+' : badge}
    </span>
  )

  // One sidebar row (expanded sidebar). Fold children render text-indented
  // without an icon behind the fold's hairline (concept PR 2).
  const renderSidebarItem = (item: NavItem, opts?: { child?: boolean }) => {
    const active = isActive(item.href)
    const enabled = isItemEnabled(item.href) && !item.comingSoon
    const badge = badgeFor(item.href)
    const decorBadge = renderBadge(item, 'sidebar')
    const content = (
      <>
        {!opts?.child &&
          renderNavIcon(
            item,
            cn(
              'mr-2.5 h-[15px] w-[15px] flex-shrink-0',
              active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
            ),
          )}
        <span className="flex-1">{tNav(item.labelKey)}</span>
        {decorBadge ? decorBadge : badge !== null && countBubble(badge)}
      </>
    )
    const baseClass = cn(
      'group flex items-center px-3 py-[7px] text-[13px] rounded-lg',
      enabled
        ? cn(
            'transition-colors duration-150',
            active
              ? 'bg-secondary text-foreground font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
          )
        : 'text-muted-foreground/40 cursor-not-allowed',
    )
    return enabled ? (
      <Link key={item.href} href={item.href} className={baseClass}>
        {content}
      </Link>
    ) : (
      <div
        key={item.href}
        className={baseClass}
        aria-disabled="true"
        title={item.comingSoon ? tNav('badge_coming_soon') : tNav('needs_company_tooltip')}
      >
        {content}
      </div>
    )
  }

  // Fold block: header row + grid-rows 0fr/1fr height animation, children
  // indented behind a hairline left edge.
  const renderFold = (segKey: FoldKey, items: NavItem[]) => {
    const open = isFoldOpen(segKey, items)
    const cfg = foldConfig[segKey]
    const FoldIcon = cfg.icon
    return (
      <div key={segKey}>
        <button
          type="button"
          onClick={() => toggleFold(segKey)}
          aria-expanded={open}
          className="group flex w-full items-center px-3 py-[7px] text-[13px] rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors duration-150"
        >
          <FoldIcon className="mr-2.5 h-[15px] w-[15px] flex-shrink-0 text-muted-foreground group-hover:text-foreground" />
          <span className="flex-1 text-left">{tNav(cfg.labelKey)}</span>
          <ChevronRight
            className={cn('h-3 w-3 transition-transform duration-200', open && 'rotate-90')}
          />
        </button>
        <div
          className="grid transition-[grid-template-rows] duration-300 ease-out"
          style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
        >
          <div className="overflow-hidden">
            <div className="ml-[19px] border-l border-border pl-1.5 py-px space-y-px">
              {items.map((item) => renderSidebarItem(item, { child: true }))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Collapsed 64px rail: icon-only rows, native title tooltips, count
  // bubbles pinned to the icon corner.
  const renderRailItem = (
    item: { href: string; labelKey: NavLabelKey; icon: typeof LayoutDashboard; comingSoon?: boolean },
  ) => {
    const active = isActive(item.href)
    const enabled = isItemEnabled(item.href) && !item.comingSoon
    const badge = badgeFor(item.href)
    const label = tNav(item.labelKey)
    const inner = (
      <span className="relative">
        {renderNavIcon(
          item,
          cn('h-[17px] w-[17px]', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'),
        )}
        {badge !== null && (
          <span data-ph-mask className="absolute -top-2 -right-2.5 min-w-[15px] h-[15px] flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-semibold px-0.5">
            {badge > 99 ? '99' : badge}
          </span>
        )}
      </span>
    )
    const baseClass = cn(
      'group flex h-9 w-9 items-center justify-center rounded-lg',
      enabled
        ? cn('transition-colors duration-150', active ? 'bg-secondary' : 'hover:bg-secondary/60')
        : 'opacity-40 cursor-not-allowed',
    )
    return enabled ? (
      <Link key={item.href} href={item.href} className={baseClass} title={label} aria-label={label}>
        {inner}
      </Link>
    ) : (
      <div key={item.href} className={baseClass} title={label} aria-disabled="true">
        {inner}
      </div>
    )
  }

  return (
    <>
      {/* Desktop sidebar */}
      {/* Width, and the panel margin beside it, share the same 300ms
          decelerating curve so collapse reads as one movement. */}
      <aside className="hidden md:fixed md:inset-y-0 md:z-10 md:flex md:w-[var(--nav-w)] md:flex-col md:transition-[width] md:duration-300 md:ease-[cubic-bezier(0.32,0.72,0,1)]">
        {/* Borderless on the frame: the panel next to it carries the border */}
        <div className="flex min-h-0 flex-1 flex-col bg-transparent">
          {/* Sidebar header: brand mark left, collapse toggle right. The
              concept hangs the nav column and the panel from the same top
              line, so this row sits level with the panel's top edge. */}
          <div
            className={cn(
              'flex flex-shrink-0 items-center pt-3 pb-2',
              collapsed
                ? 'flex-col justify-center gap-1'
                : 'justify-between pl-5 pr-3',
            )}
          >
            <Link
              href="/"
              aria-label={getBranding().appName}
              className="flex items-center rounded-lg"
            >
              <Image
                src={getBranding().logoPath}
                alt=""
                width={26}
                height={26}
                className="h-[26px] w-[26px] rounded-lg"
              />
            </Link>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? tNav('expand_nav') : tNav('collapse_nav')}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors duration-150"
            >
              {collapsed ? (
                <PanelLeft className="h-4 w-4" />
              ) : (
                <PanelLeftClose className="h-4 w-4" />
              )}
            </button>
          </div>

          {/* Nav items in their own scroll container so the user block
              below stays sticky (concept PR 2). */}
          <div className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden pt-1 pb-2">
            {/* Both states stay mounted and crossfade past each other while
                the aside width animates: no DOM swap, one continuous motion.
                The inactive layer is absolute (no layout), faded, nudged
                sideways and inert. */}
              {/* data-ph-unmask: nav labels are static i18n chrome; count
                  bubbles inside carry data-ph-mask (nearest tag wins). */}
              <nav
                data-ph-unmask
                aria-hidden={!collapsed}
                inert={!collapsed ? true : undefined}
                className={cn(
                  'flex w-16 flex-col items-center gap-px px-2 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                  collapsed
                    ? 'opacity-100 translate-x-0'
                    : 'pointer-events-none absolute inset-x-0 top-1 opacity-0 -translate-x-3',
                )}
                aria-label={tNav('main_navigation')}
              >
                {railItems.map((item) => renderRailItem(item))}
                {visibleExtensionNavItems.map((item) => {
                  const Icon = resolveIcon(item.icon)
                  const labelTranslationKey = extensionLabelKey(item.href)
                  const label = labelTranslationKey ? tNav(labelTranslationKey) : item.label
                  const active = isActive(item.href)
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={label}
                      aria-label={label}
                      className={cn(
                        'group flex h-9 w-9 items-center justify-center rounded-lg transition-colors duration-150',
                        active ? 'bg-secondary' : 'hover:bg-secondary/60',
                      )}
                    >
                      <Icon
                        className={cn(
                          'h-[17px] w-[17px]',
                          active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
                        )}
                      />
                    </Link>
                  )
                })}
              </nav>
            <nav
              data-ph-unmask
              aria-hidden={collapsed}
              inert={collapsed ? true : undefined}
              className={cn(
                'w-[248px] px-3 transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                collapsed
                  ? 'pointer-events-none absolute inset-x-0 top-1 opacity-0 translate-x-3'
                  : 'opacity-100 translate-x-0',
              )}
              aria-label={tNav('main_navigation')}
            >
              {/* Top section: flat, no header. Hem, Assistent. */}
              <div className="mb-4 space-y-px">
                {topItems.map((item) => renderSidebarItem(item))}
              </div>

              {/* Groups: Arbeta, Analys, Data, Skatt & bokslut. Static
                  headers; only the Register/Bokslut folds collapse. */}
              {sidebarGroups
                .filter(({ items }) => items.length > 0)
                .map(({ key, items }) => (
                  <div key={key} className="mb-4">
                    <div className="px-3 pb-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
                      {tNav(groupLabelKey[key])}
                    </div>
                    <div className="space-y-px">
                      {segmentItems(items).map((seg) =>
                        seg.type === 'item'
                          ? renderSidebarItem(seg.item)
                          : renderFold(seg.key, seg.items),
                      )}
                      {/* Extension nav items land in Arbeta since extension
                          workspaces are work surfaces. Future categorised
                          extensions can opt into a different group via
                          their manifest. */}
                      {key === 'arbeta' &&
                        visibleExtensionNavItems.map((item) => {
                          const Icon = resolveIcon(item.icon)
                          const active = isActive(item.href)
                          const enabled = hasCompany
                          const labelTranslationKey = extensionLabelKey(item.href)
                          const label = labelTranslationKey
                            ? tNav(labelTranslationKey)
                            : item.label
                          const content = (
                            <>
                              <Icon
                                className={cn(
                                  'mr-2.5 h-[15px] w-[15px] flex-shrink-0',
                                  active
                                    ? 'text-primary'
                                    : 'text-muted-foreground group-hover:text-foreground',
                                )}
                              />
                              {label}
                            </>
                          )
                          const baseClass = cn(
                            'group flex items-center px-3 py-[7px] text-[13px] rounded-lg',
                            enabled
                              ? cn(
                                  'transition-colors duration-150',
                                  active
                                    ? 'bg-secondary text-foreground font-medium'
                                    : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
                                )
                              : 'text-muted-foreground/40 cursor-not-allowed',
                          )
                          return enabled ? (
                            <Link key={item.href} href={item.href} className={baseClass}>
                              {content}
                            </Link>
                          ) : (
                            <div
                              key={item.href}
                              className={baseClass}
                              aria-disabled="true"
                              title={tNav('needs_company_tooltip')}
                            >
                              {content}
                            </div>
                          )
                        })}
                    </div>
                  </div>
                ))}
            </nav>
          </div>

          {/* Subscription touchpoint: trial countdown while the trial runs,
              a persistent muted upgrade link once it (or a subscription) has
              lapsed. Hides itself for sandbox/demo and paying companies. */}
          <SubscriptionTouchpoint variant="sidebar" collapsed={collapsed} />

          {/* Sticky user block (bottom-left): avatar, name, active company.
              Opens the upward user menu with the company-switcher flyout,
              account links and logout (concept PR 2). The hairline above is
              inset to the content edges, not edge-to-edge (concept). */}
          <div className="flex-shrink-0">
            <div
              className={cn(
                'border-t border-border/60',
                collapsed ? 'mx-2' : 'mx-3',
              )}
            />
            <div className={cn(collapsed ? 'px-2 py-2' : 'px-3 py-2')}>
              <UserMenu
                userName={userName}
                userEmail={userEmail}
                isSandbox={isSandbox}
                collapsed={collapsed}
                onLogout={() => void handleLogout()}
              />
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile bottom navigation */}
      <nav data-ph-unmask className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card/98 backdrop-blur-sm border-t border-border/40" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label={tNav('mobile_navigation')}>
        <div className="flex items-center justify-around h-16 px-2">
          {mobileNavItems.map((item) => {
            const active = isActive(item.href)
            const enabled = isItemEnabled(item.href)
            const badge = item.href === '/transactions' && uncategorizedCount > 0
              ? uncategorizedCount
              : null

            const content = (
              <>
                <div className="relative">
                  {renderNavIcon(item, cn('h-5 w-5 mb-1', active && 'text-primary'))}
                  {badge !== null && (
                    <span data-ph-mask className="absolute -top-1.5 -right-2.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-semibold px-0.5">
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </div>
                <span className={cn(
                  "truncate",
                  active && "font-medium"
                )}>{tNav(item.labelKey)}</span>
              </>
            )
            const baseClass = cn(
              'relative flex flex-col items-center justify-center flex-1 h-full text-xs',
              enabled
                ? cn(
                    'transition-colors duration-200',
                    active ? 'text-primary' : 'text-muted-foreground'
                  )
                : 'text-muted-foreground/40'
            )

            return enabled ? (
              <Link key={item.href} href={item.href} className={baseClass}>
                {content}
              </Link>
            ) : (
              <div key={item.href} className={baseClass} aria-disabled="true">
                {content}
              </div>
            )
          })}
          {/* Menu button */}
          <button
            onClick={openMobileMenu}
            aria-label={tNav('open_menu')}
            className="flex flex-col items-center justify-center flex-1 h-full text-xs text-muted-foreground transition-colors duration-200"
          >
            <Menu className="h-5 w-5 mb-1" />
            <span>{tNav('menu')}</span>
          </button>
        </div>
      </nav>

      {/* Mobile menu: bottom sheet */}
      {isMobileMenuOpen && (
        <>
          {/* Backdrop */}
          <div
            className={cn(
              "md:hidden fixed inset-0 bg-background/80 backdrop-blur-sm z-50",
              isClosing ? "animate-out fade-out duration-200" : "animate-in fade-in duration-300"
            )}
            onClick={closeMobileMenu}
            aria-hidden="true"
          />
          {/* Bottom sheet */}
          <div
            className={cn(
              "md:hidden fixed inset-x-0 bottom-0 z-50 bg-card rounded-t-xl border-t border-border/40 overflow-y-auto overscroll-contain",
              isClosing
                ? "animate-out slide-out-to-bottom duration-200"
                : "animate-in slide-in-from-bottom duration-300"
            )}
            style={{ maxHeight: '85dvh', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
            role="dialog"
            aria-label={tNav('navigation_menu')}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1 sticky top-0 bg-card rounded-t-xl">
              <div className="w-8 h-1 rounded-full bg-muted-foreground/25" />
            </div>

            {/* Header */}
            <div className="px-4 pb-2 flex items-center justify-between">
              <div className="flex-1 min-w-0 mr-2">
                <CompanySwitcher />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 -mr-1"
                onClick={closeMobileMenu}
                aria-label={tNav('close_menu')}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            {/* Navigation. data-ph-unmask: static i18n labels only; the
                CompanySwitcher above stays outside so it remains masked,
                and count bubbles inside carry data-ph-mask. */}
            <div data-ph-unmask className="px-2">
              {/* Top items (Hem, Assistent) */}
              <div className="space-y-0.5">
                {topItems.map((item) => {
                  const active = isActive(item.href)
                  const enabled = isItemEnabled(item.href)
                  const badge: number | null = null
                  const decorBadge = renderBadge(item, 'mobile')
                  const content = (
                    <>
                      {renderNavIcon(item, cn('h-[18px] w-[18px] flex-shrink-0', active ? 'text-primary' : 'text-muted-foreground'))}
                      <span className="text-sm flex-1">{tNav(item.labelKey)}</span>
                      {decorBadge ? decorBadge : badge !== null && (
                        <span data-ph-mask className="min-w-[20px] h-[20px] flex items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold px-1.5">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
                    </>
                  )
                  const baseClass = cn(
                    'flex items-center gap-3 px-3 min-h-[44px] rounded-lg',
                    enabled
                      ? cn(
                          'transition-colors',
                          active
                            ? 'bg-primary/10 text-primary font-medium'
                            : 'text-foreground active:bg-muted/60'
                        )
                      : 'text-muted-foreground/40'
                  )
                  return enabled ? (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={closeMobileMenu}
                      className={baseClass}
                    >
                      {content}
                    </Link>
                  ) : (
                    <div key={item.href} className={baseClass} aria-disabled="true">
                      {content}
                    </div>
                  )
                })}
              </div>

              {/* Arbeta / Analys / Data / Skatt & bokslut groups (mobile) */}
              {sidebarGroups.filter(({ items }) => items.length > 0).map(({ key, items }) => (
                <div key={key}>
                  <div className="flex items-center gap-3 my-1.5 px-3">
                    <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav(groupLabelKey[key])}</span>
                    <div className="flex-1 h-px bg-border/30" />
                  </div>
                  <div className="space-y-0.5">
                    {items.map((item) => {
                      const Icon = item.icon
                      const active = isActive(item.href)
                      const enabled = isItemEnabled(item.href) && !item.comingSoon
                      const badge = item.href === '/transactions' && uncategorizedCount > 0
                        ? uncategorizedCount
                        : item.href === '/pending' && pendingOpsCount > 0
                          ? pendingOpsCount
                          : null
                      const decorBadge = renderBadge(item, 'mobile')
                      const content = (
                        <>
                          <Icon className={cn("h-[18px] w-[18px] flex-shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                          <span className="text-sm flex-1">{tNav(item.labelKey)}</span>
                          {decorBadge ? decorBadge : badge !== null && (
                            <span data-ph-mask className="min-w-[20px] h-[20px] flex items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold px-1.5">
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                        </>
                      )
                      const baseClass = cn(
                        'flex items-center gap-3 px-3 min-h-[44px] rounded-lg',
                        enabled
                          ? cn(
                              'transition-colors',
                              active
                                ? 'bg-primary/10 text-primary font-medium'
                                : 'text-foreground active:bg-muted/60'
                            )
                          : 'text-muted-foreground/40'
                      )
                      return enabled ? (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={closeMobileMenu}
                          className={baseClass}
                        >
                          {content}
                        </Link>
                      ) : (
                        <div key={item.href} className={baseClass} aria-disabled="true">
                          {content}
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}

              {/* Tillägg (extensions): only when there's at least one */}
              {visibleExtensionNavItems.length > 0 && (
                <>
                  <div className="flex items-center gap-3 my-1.5 px-3">
                    <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav('group_extensions')}</span>
                    <div className="flex-1 h-px bg-border/30" />
                  </div>
                  <div className="space-y-0.5">
                    {visibleExtensionNavItems.map((item) => {
                      const Icon = resolveIcon(item.icon)
                      const active = isActive(item.href)
                      const enabled = hasCompany
                      const labelTranslationKey = extensionLabelKey(item.href)
                      const label = labelTranslationKey ? tNav(labelTranslationKey) : item.label
                      const content = (
                        <>
                          <Icon className={cn("h-[18px] w-[18px] flex-shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                          <span className="text-sm">{label}</span>
                        </>
                      )
                      const baseClass = cn(
                        'flex items-center gap-3 px-3 min-h-[44px] rounded-lg',
                        enabled
                          ? cn(
                              'transition-colors',
                              active
                                ? 'bg-primary/10 text-primary font-medium'
                                : 'text-foreground active:bg-muted/60'
                            )
                          : 'text-muted-foreground/40'
                      )
                      return enabled ? (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={closeMobileMenu}
                          className={baseClass}
                        >
                          {content}
                        </Link>
                      ) : (
                        <div key={item.href} className={baseClass} aria-disabled="true">
                          {content}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Mitt konto divider */}
              <div className="flex items-center gap-3 my-1.5 px-3">
                <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav('mitt_konto')}</span>
                <div className="flex-1 h-px bg-border/30" />
              </div>

              <div className="space-y-0.5">
                {/* Subscription touchpoint: mobile had no trial surface at
                    all before this row (trial countdown or lapsed upgrade
                    link; hides itself for sandbox and paying companies). */}
                <SubscriptionTouchpoint variant="mobile" onNavigate={closeMobileMenu} />
                {([
                  { href: '/settings', labelKey: 'settings' as NavLabelKey, icon: Settings },
                  { href: '/help', labelKey: 'help' as NavLabelKey, icon: HelpCircle },
                ]).map((item) => {
                  const Icon = item.icon
                  const active = isActive(item.href)
                  const enabled = isItemEnabled(item.href)
                  const content = (
                    <>
                      <Icon className={cn("h-[18px] w-[18px] flex-shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                      <span className="text-sm">{tNav(item.labelKey)}</span>
                    </>
                  )
                  const baseClass = cn(
                    'flex items-center gap-3 px-3 min-h-[44px] rounded-lg',
                    enabled
                      ? cn(
                          'transition-colors',
                          active
                            ? 'bg-primary/10 text-primary font-medium'
                            : 'text-foreground active:bg-muted/60'
                        )
                      : 'text-muted-foreground/40'
                  )
                  return enabled ? (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={closeMobileMenu}
                      className={baseClass}
                    >
                      {content}
                    </Link>
                  ) : (
                    <div key={item.href} className={baseClass} aria-disabled="true">
                      {content}
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Support + Logout */}
            <div className="px-2 py-2 mt-1 border-t border-border space-y-1">
              <div className="px-3 py-2">
                <SupportLink variant="muted" />
              </div>
              <Button
                variant="ghost"
                className="w-full justify-start text-muted-foreground active:text-foreground text-sm h-11 px-3"
                onClick={() => {
                  closeMobileMenu()
                  handleLogout()
                }}
              >
                <LogOut className="mr-3 h-[18px] w-[18px]" />
                {isSandbox ? tNav('logout_sandbox') : tCommon('logout')}
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
