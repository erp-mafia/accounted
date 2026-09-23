'use client'

import { useEffect, useState, useRef } from 'react'
import { NavLink } from './NavLink'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  LayoutDashboard,
  Home,
  Receipt,
  ReceiptText,
  FileText,
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
  Wallet,
  TrendingUp,
  ClipboardCheck,
  HandCoins,
  Package,
  Tag,
  Tags,
  Sparkles,
  Percent,
  Landmark,
  Scale,
  CalendarClock,
  CalendarRange,
  FileCheck,
  FileSpreadsheet,
  ScrollText,
  Briefcase,
  ArrowLeft,
  Workflow,
  FolderArchive,
  ShoppingCart,
  Car,
  ClipboardList,
  Truck,
} from 'lucide-react'
import { getBranding } from '@/lib/branding/service'
import { BrandHomeLink } from '@/components/branding/BrandHomeLink'
import { ENABLED_EXTENSION_IDS as _ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { resetAnalyticsIdentity } from '@/lib/analytics/reset'
import { SupportLink } from '@/components/ui/support-link'
import { clearSupportDraft } from '@/lib/support/draft'
import CompanySwitcher from '@/components/dashboard/CompanySwitcher'
import UserMenu from '@/components/dashboard/UserMenu'
import SubscriptionTouchpoint from '@/components/billing/SubscriptionTouchpoint'
import AgentAvatar from '@/components/agent/AgentAvatar'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { useCompany } from '@/contexts/CompanyContext'
import { useRealtimeSupabase } from '@/lib/hooks/use-realtime-supabase'
import { useWorklistBadges } from '@/lib/hooks/use-worklist-badges'
import { EXTENSION_REQUIRED_CAPABILITY, type CapabilityKey } from '@/lib/entitlements/keys'
import type { EntityType } from '@/types'
import { isEntityType, usesPersonnummerAsOrgNumber } from '@/lib/company/entity-type'
import { SidebarV2 } from './SidebarV2'
import { scrubAuthCookies } from '@/lib/auth/browser-session-cookies'
import { NAV_V2_COMPANY, NAV_V2_TOP, type NavGateFlags, type NavV2Item } from './nav-v2'

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
  // Whether kundorder (company_settings.sales_orders_enabled) is switched on.
  // Drives visibility of the Kundorder row: same mechanism as
  // dimensionsEnabled, fetched by the dashboard layout.
  salesOrdersEnabled?: boolean
  // Whether offerter (company_settings.quotes_enabled) is switched on. Same
  // mechanism as salesOrdersEnabled, but default true: quotes are on unless
  // the company switched them off.
  quotesEnabled?: boolean
  // Whether the company has a webshop hooked up (active WooCommerce/Shopify
  // connection, or existing webshop_orders rows). Drives visibility of the
  // Order row: same mechanism as paysSalaries, fetched by the layout.
  hasWebshop?: boolean
  // Whether the Körjournal row shows: the company_settings.mileage_enabled
  // toggle OR existing mileage_trips rows (trips created via API/MCP must
  // stay reachable). Computed by the dashboard layout.
  hasMileage?: boolean
  // Whether the Utlägg row shows: existing expense_claims rows. New utlägg
  // start from the Underlag pane ("Vem betalade?"), so the page only earns a
  // nav row once there is a person to pay out. Computed by the layout.
  hasExpenseClaims?: boolean
  // Whether the company is in the Arkiv rollout (ARKIV_COMPANY_IDS). Computed by the layout.
  arkivEnabled?: boolean
  isSandbox?: boolean
  extensionNavItems?: ExtensionNavItem[]
  // Signed-in user's full name + email: drives the bottom-left account
  // popover trigger so the user can see WHO they're logged in as,
  // distinct from the active COMPANY shown by CompanySwitcher up top.
  userName?: string | null
  userEmail?: string | null
}

type NavLabelKey =
  | 'dashboard'
  | 'home'
  | 'assistant'
  | 'agent_knowledge'
  | 'kpi'
  | 'invoice_inbox'
  | 'arkiv'
  | 'arkiv_all'
  | 'arkiv_history'
  | 'invoices'
  | 'quotes'
  | 'sales_orders'
  | 'webshop_orders'
  | 'customers'
  | 'articles'
  | 'supplier_invoices'
  | 'suppliers'
  | 'review'
  | 'transactions'
  | 'reconciliation'
  | 'bookkeeping'
  | 'chart_of_accounts'
  | 'dimensions'
  | 'assets'
  | 'reports'
  | 'import'
  | 'salary'
  | 'expenses'
  | 'mileage'
  | 'employees'
  | 'vat_declaration'
  | 'skattekonto'
  | 'deadlines'
  | 'periodiseringar'
  | 'year_end'
  | 'bokslutsbilagor'
  | 'annual_report'
  | 'income_declaration'
  | 'help'
  | 'settings'
  | 'clients'
  | 'automations'
  | 'back_to_clients'

// Two navigations over the same routes. Desktop: SidebarV2, the section
// tree in nav-v2.ts (sub-items under the active section, user block at the
// bottom). Phone: the bottom bar plus the menu sheet, built from `navItems`:
//   top section          : flat, no header: Hem, Assistent.
//   four groups          : static headers (Arbeta, Analys, Data,
//                          Skatt & bokslut).
// Help + Settings are NOT in `navItems`; they live in the user menu and in
// the sheet's Mitt konto rows.
// Pending (Granskning) stays visible at all times: the badge carries the count.
type GroupKey = 'top' | 'arbeta' | 'analys' | 'data' | 'skatt'

interface NavItem {
  href: string
  labelKey: NavLabelKey
  icon: typeof LayoutDashboard
  group: GroupKey
  // Payroll surfaces: visible only to employers: every aktiebolag (unchanged
  // behaviour) plus any company that has registered as an employer via
  // company_settings.pays_salaries (e.g. an enskild firma with staff). #782
  employerOnly?: boolean
  // Dimension surfaces: visible only when the company has opted in via
  // company_settings.dimensions_enabled (UI-visibility gate only; the pages
  // and APIs work regardless, dimensions plan §2).
  requiresDimensions?: boolean
  // Kundorder surfaces: visible only when the company has opted in via
  // company_settings.sales_orders_enabled (UI-visibility gate only; the
  // pages and APIs work regardless).
  requiresSalesOrders?: boolean
  // Offerter: visible while company_settings.quotes_enabled is on (UI
  // visibility only; /quotes and the APIs work regardless).
  requiresQuotes?: boolean
  // Webshop surfaces: visible only when the company has an active
  // WooCommerce/Shopify connection or already-imported order rows.
  // UI-visibility gate only; the page and APIs work regardless.
  requiresWebshop?: boolean
  // Körjournal surfaces: visible only when the company has opted in via the
  // bookkeeping settings toggle (company_settings.mileage_enabled) or already
  // has trips. UI-visibility gate only; the page and APIs work regardless.
  requiresMileage?: boolean
  // Utlägg row: visible only when the company already has expense claims
  // (same "data stays reachable" gate as Körjournal). UI-visibility only.
  requiresExpenses?: boolean
  // Paywall surfaces: hidden unless the active company holds this paid
  // capability. Cosmetic only, the page and API gates are the real
  // enforcement; this just keeps the sidebar honest for non-payers.
  requiredCapability?: CapabilityKey
  // Statutory surfaces that only exist for one company form (INK2 vs
  // NE-bilaga, årsredovisning): hidden for the other entity type.
  entityOnly?: EntityType
  // Byrå cockpit surfaces (WL-14): visible only to byrå team members
  // (teams.kind = 'byra'). The /clients page + API enforce server-side.
  byraOnly?: boolean
  hidden?: boolean
  comingSoon?: boolean
  devBadge?: boolean
  betaBadge?: boolean
}

// The phone menu's destinations in concept ordering; the desktop sidebar
// applies the same gates to nav-v2.ts.
const navItems: NavItem[] = [
  // Top section: flat list, always visible, no header. (Flöden joins here
  // when the flow engine exists.)
  { href: '/', labelKey: 'home', icon: Home, group: 'top' },
  // Byrå cockpit (WL-14): the client list, byrå team members only.
  { href: '/clients', labelKey: 'clients', icon: Briefcase, group: 'top', byraOnly: true },
  { href: '/chat', labelKey: 'assistant', icon: Sparkles, group: 'top' },
  // Arbeta: everything the user produces, bookkeeping funnel first
  // (Bokföring · Underlag · Transaktioner · Granskning), then the
  // transactional flows. employerOnly: aktiebolag or pays_salaries. #782
  { href: '/bookkeeping', labelKey: 'bookkeeping', icon: BookOpen, group: 'arbeta' },
  { href: '/e/general/invoice-inbox', labelKey: 'invoice_inbox', icon: Inbox, group: 'arbeta', requiredCapability: EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox'] },
  { href: '/transactions', labelKey: 'transactions', icon: ArrowLeftRight, group: 'arbeta' },
  { href: '/reconciliation', labelKey: 'reconciliation', icon: Scale, group: 'arbeta' },
  { href: '/pending', labelKey: 'review', icon: ClipboardCheck, group: 'arbeta' },
  // Kundorder: opt-in via the bookkeeping settings toggle (UI gate only).
  { href: '/sales-orders', labelKey: 'sales_orders', icon: ClipboardList, group: 'arbeta', requiresSalesOrders: true },
  // Offerter: a quote is not an invoice, so its own row above Kundfakturor.
  { href: '/quotes', labelKey: 'quotes', icon: FileText, group: 'arbeta', requiresQuotes: true },
  { href: '/invoices', labelKey: 'invoices', icon: ReceiptText, group: 'arbeta' },
  // Webshop orders: visible only for companies that actually have a webshop
  // hooked up (active WooCommerce/Shopify connection or existing order rows).
  // Deliberately NOT capability-gated: a company whose entitlement lapsed
  // must still reach its already-imported orders (accounting underlag).
  { href: '/orders', labelKey: 'webshop_orders', icon: ShoppingCart, group: 'arbeta', requiresWebshop: true, betaBadge: true },
  { href: '/supplier-invoices', labelKey: 'supplier_invoices', icon: Wallet, group: 'arbeta' },
  // Utlägg: out-of-pocket purchases and their reimbursement batches. Hidden
  // until a claim exists: a receipt paid privately is registered from the
  // Underlag pane, and the person to pay out surfaces in Att göra. The
  // /expenses route previously redirected to supplier invoices; the nav key
  // has existed in the nav namespace since then.
  { href: '/expenses', labelKey: 'expenses', icon: Receipt, group: 'arbeta', requiresExpenses: true },
  { href: '/salary', labelKey: 'salary', icon: HandCoins, group: 'arbeta', employerOnly: true },
  // Körjournal: hidden by default (most companies have no car); shows when
  // the settings toggle is on or trips already exist (hybrid gate, same
  // "data stays reachable" reasoning as the Order row above).
  { href: '/mileage', labelKey: 'mileage', icon: Car, group: 'arbeta', requiresMileage: true },
  // Analys: read the numbers.
  { href: '/kpi', labelKey: 'kpi', icon: TrendingUp, group: 'analys' },
  { href: '/reports', labelKey: 'reports', icon: BarChart3, group: 'analys' },
  // Data: the registers (master data) + Importera/exportera as its own
  // row. Anställda is a register (you edit an employee rarely, you run
  // payroll monthly), so it lives here while Löner stays in Arbeta.
  { href: '/customers', labelKey: 'customers', icon: Users, group: 'data' },
  { href: '/suppliers', labelKey: 'suppliers', icon: Truck, group: 'data' },
  { href: '/articles', labelKey: 'articles', icon: Tag, group: 'data' },
  { href: '/salary/employees', labelKey: 'employees', icon: Users, group: 'data', employerOnly: true },
  { href: '/assets', labelKey: 'assets', icon: Package, group: 'data' },
  { href: '/chart-of-accounts', labelKey: 'chart_of_accounts', icon: ListTree, group: 'data' },
  { href: '/dimensions', labelKey: 'dimensions', icon: Tags, group: 'data', requiresDimensions: true },
  { href: '/import', labelKey: 'import', icon: Upload, group: 'data' },
  // Skatt & bokslut: everything submitted to the state; the year-end chain
  // (periodiseringar → årsbokslut → årsredovisning → inkomstdeklaration)
  // lives in workflow order; the last two are
  // entity-gated because the surface only exists for one company form.
  { href: '/reports/vat-declaration', labelKey: 'vat_declaration', icon: Percent, group: 'skatt' },
  { href: '/skattekonto', labelKey: 'skattekonto', icon: Landmark, group: 'skatt' },
  { href: '/deadlines', labelKey: 'deadlines', icon: CalendarClock, group: 'skatt' },
  { href: '/bookkeeping/periodiseringar', labelKey: 'periodiseringar', icon: CalendarRange, group: 'skatt' },
  { href: '/bookkeeping/year-end', labelKey: 'year_end', icon: FileCheck, group: 'skatt' },
  { href: '/reports/bokslutsbilagor', labelKey: 'bokslutsbilagor', icon: FolderArchive, group: 'skatt' },
  { href: '/bookkeeping/year-end/arsredovisning', labelKey: 'annual_report', icon: ScrollText, group: 'skatt', entityOnly: 'aktiebolag' },
  { href: '/reports/ink2-declaration', labelKey: 'income_declaration', icon: FileSpreadsheet, group: 'skatt', entityOnly: 'aktiebolag' },
  { href: '/reports/ne-declaration', labelKey: 'income_declaration', icon: FileSpreadsheet, group: 'skatt', entityOnly: 'enskild_firma' },
]

// Byrå cockpit sidebar (lean mode): while a byrå team member is on a
// cockpit route (client overview + the /byra pages) the sidebar shows only
// these four byrå-scope entries instead of the full company nav. Entering a
// company (performCompanySwitch from the client list) is a hard navigation
// to a company route, which swaps the full list back in.
const cockpitNavItems: NavItem[] = [
  { href: '/byra', labelKey: 'home', icon: Home, group: 'top' },
  { href: '/clients', labelKey: 'clients', icon: Briefcase, group: 'top' },
  { href: '/byra/automations', labelKey: 'automations', icon: Workflow, group: 'top' },
  { href: '/byra/kpi', labelKey: 'kpi', icon: TrendingUp, group: 'top' },
]

// Cockpit routes are byrå-scope, not company-scope: they decide which
// sidebar variant renders and stay enabled without an active company.
const COCKPIT_PATHS = ['/byra', '/clients']
const isCockpitPath = (pathname: string) =>
  COCKPIT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

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

export default function DashboardNav({ companyName: _companyName, entityType, paysSalaries = false, dimensionsEnabled = false, salesOrdersEnabled = false, quotesEnabled = true, hasWebshop = false, hasMileage = false, hasExpenseClaims = false, arkivEnabled = false, isSandbox = false, extensionNavItems = [], userName = null, userEmail = null }: DashboardNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = useRealtimeSupabase()
  const { company, capabilities, byraTeam } = useCompany()
  // Agent identity drives the "Assistent" nav icon: when the user has
  // built their assistant we show its chosen avatar instead of the
  // generic Sparkles glyph.
  const { identity: agentIdentity } = useAgentSheet()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const tSwitcher = useTranslations('company_switcher')
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
  // Byrå cockpit mode: lean sidebar on cockpit routes, full sidebar (with a
  // back-to-clients link) once the member is inside a company. Settings opens
  // as a modal OVER the current surface (intercepted route), so while the
  // pathname is /settings/* the sidebar keeps the mode of the page underneath
  // instead of flipping to the company nav behind the modal.
  const onSettings = pathname.startsWith('/settings')
  const onCockpitPath = isCockpitPath(pathname)
  // Settings opened from the cockpit carry ?ctx=byra (user menu / mobile
  // nav links, preserved by SettingsRail). It is the signal that SURVIVES a
  // hard refresh, when the previous-surface memory below starts over at
  // false and the sidebar used to flip to the full company nav.
  const ctxByra = useSearchParams().get('ctx') === 'byra'
  // Previous-render memory via the adjust-state-during-render pattern
  // (react.dev: storing information from previous renders); a ref would be
  // simpler but refs must not be read or written during render.
  const [lastNonSettingsCockpit, setLastNonSettingsCockpit] = useState(false)
  if (!onSettings && onCockpitPath !== lastNonSettingsCockpit) {
    setLastNonSettingsCockpit(onCockpitPath)
  }
  const cockpitMode =
    !!byraTeam && (onSettings ? lastNonSettingsCockpit || ctxByra : onCockpitPath)
  // Where "Tillbaka till klienter" points (home-domain rule, WL-01): absolute
  // URL when the byrå cockpit is homed on another host (resolveCockpitHref in
  // the layout), relative '/clients' otherwise. The layout's pre-brand
  // no-company branch leaves cockpitHref unset; there the relative fallback
  // reproduces the pre-cockpitHref link exactly on the cockpit/settings
  // surfaces that branch can render. Cross-host hops render a plain <a>
  // (no client-router prefetch across origins) and carry a "Hanteras via"
  // hint, since the other host will ask for a login (per-host sessions).
  const cockpitHref = byraTeam?.cockpitHref ?? '/clients'
  const cockpitExternal = cockpitHref.startsWith('https://')
  const cockpitHint = cockpitExternal
    ? tSwitcher('managed_via', { domain: new URL(cockpitHref).hostname })
    : null
  // Byrå-scope surfaces, not company surfaces: they must stay reachable even
  // when the active company is unresolved.
  const ALWAYS_ENABLED = new Set(['/settings', '/clients', '/byra', '/byra/automations', '/byra/kpi'])
  const isItemEnabled = (href: string) => {
    // The back-to-clients link may be absolute (cross-host cockpit); judge
    // it by its path so it stays as reachable as the relative form.
    const path = href.startsWith('https://') ? new URL(href).pathname : href
    const base = path.split('?')[0]
    return hasCompany || ALWAYS_ENABLED.has(base) || base.startsWith('/settings')
  }
  type ExpandableGroup = Exclude<GroupKey, 'top'>

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
    // An unsent support draft belongs to this user; never leave it in the tab.
    clearSupportDraft()
    await supabase.auth.signOut()
    // signOut only expires the Path=/ host-only auth cookie; a duplicate
    // written under another Path or Domain would survive and keep the
    // browser signed out of its own reads after the next login (PH 99).
    scrubAuthCookies(document, window.location)
    router.push(isSandbox ? '/sandbox' : '/login')
  }

  const isActive = (href: string) => {
    if (href === '/') {
      return pathname === '/'
    }
    // Cockpit Hem: exact match so /byra/automations and /byra/kpi light up
    // their own rows only.
    if (href === '/byra') {
      return pathname === '/byra'
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

    // Realtime keeps the badges live (bank rows, skattekonto rows, staged
    // operations); a trailing debounce collapses event bursts (bulk booking
    // / bulk approvals emit one event per row) into a single SWR
    // revalidation instead of a request stampede.
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
          table: 'skattekonto_transactions',
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

  // Payroll shows by default for every juridisk person (a company that is a
  // legal person of its own employs people as a matter of course); a form
  // whose org number is the owner's personnummer opts in through
  // pays_salaries. #782
  const isEmployer =
    (isEntityType(entityType) && !usesPersonnummerAsOrgNumber(entityType)) || paysSalaries

  // One gate for both navigations: a surface hides for the same reason in
  // the sidebar tree (nav-v2.ts) and in the phone menu.
  const passesGates = (item: NavGateFlags) => {
    if (item.hidden) return false
    if (hiddenNavHrefs.has(item.href)) return false
    // Payroll (employerOnly) is hidden until the company is an employer by
    // form or has flagged pays_salaries. #782
    if (item.employerOnly && !isEmployer) return false
    // Dimension surfaces are hidden until the company opts in via the
    // bookkeeping settings toggle (company_settings.dimensions_enabled).
    if (item.requiresDimensions && !dimensionsEnabled) return false
    if (item.requiresSalesOrders && !salesOrdersEnabled) return false
    if (item.requiresQuotes && !quotesEnabled) return false
    // Webshop surfaces are hidden until a store is connected (or order rows
    // already exist from a since-disconnected store).
    if (item.requiresWebshop && !hasWebshop) return false
    // Körjournal is hidden until the company opts in via the bookkeeping
    // settings toggle (or trips already exist, e.g. created via MCP).
    if (item.requiresMileage && !hasMileage) return false
    // Utlägg is hidden until a claim exists (registered from Underlag).
    if (item.requiresExpenses && !hasExpenseClaims) return false
    // Arkiv rolls out per company; outside the rollout the pages 404.
    if (item.requiresArkiv && !arkivEnabled) return false
    // Paywalled surfaces (e.g. the AI-only Dokumentinkorg) are hidden unless
    // the active company holds the capability. The page + API gates enforce
    // the paywall; this keeps the sidebar from advertising a dead workspace.
    if (item.requiredCapability && !capabilities.includes(item.requiredCapability)) return false
    // Entity-gated statutory surfaces: INK2/ÅR for aktiebolag, NE for
    // enskild firma; the page for the other form doesn't exist.
    if (item.entityOnly && item.entityOnly !== entityType) return false
    // Byrå cockpit: the Klienter entry lives in the lean cockpit sidebar
    // (cockpitNavItems); in company mode the pinned back-to-clients link
    // replaces it, and non-byrå users never see it (WL-14).
    if (item.byraOnly) return false
    // Hide the Assistent (/chat) tab until the agent is built: mirrors the
    // floating AgentTrigger and avoids a nav entry that only bounces to the
    // home checklist (chat/layout redirects unverified users to /).
    if (item.href === '/chat' && !agentIdentity.isVerified) return false
    // Granskning stays in the top nav at all times now: the badge
    // surfaces the count when there are pending ops, but the link is
    // always present so users can navigate there manually.
    return true
  }
  const filteredItems = (cockpitMode ? cockpitNavItems : navItems).filter(passesGates)

  const topItems = filteredItems.filter((i) => i.group === 'top')

  // The TIC workspace (/e/general/tic, labelled "Företagsprofil") surfaces
  // the same Bolagsuppgifter now shown under Inställningar → Företagsprofil.
  // Drop it from the nav so the company profile lives in exactly one place.
  // Extension workspaces are company surfaces: none in cockpit mode.
  const visibleExtensionNavItems = cockpitMode
    ? []
    : extensionNavItems.filter((i) => i.href !== '/e/general/tic')

  const sidebarGroups: { key: ExpandableGroup; items: NavItem[] }[] = cockpitMode
    ? []
    : [
        { key: 'arbeta', items: filteredItems.filter((i) => i.group === 'arbeta') },
        { key: 'analys', items: filteredItems.filter((i) => i.group === 'analys') },
        { key: 'data', items: filteredItems.filter((i) => i.group === 'data') },
        { key: 'skatt', items: filteredItems.filter((i) => i.group === 'skatt') },
      ]

  // Nav tree: the same gates applied to sections and their sub-items.
  // In cockpit mode the lean cockpit list is the whole sidebar.
  const gateTree = (items: NavV2Item[]): NavV2Item[] =>
    items.filter(passesGates).map((i) => ({ ...i, sub: i.sub?.filter(passesGates) }))
  const v2Top: NavV2Item[] = cockpitMode
    ? cockpitNavItems.filter(passesGates).map(({ href, labelKey, icon }) => ({ href, labelKey, icon }))
    : gateTree(NAV_V2_TOP)
  const v2Company = cockpitMode ? [] : gateTree(NAV_V2_COMPANY)
  // Att göra carries the whole queue (unbooked rows + staged operations);
  // Transaktioner and Assistentens förslag keep their own share.
  const v2BadgeFor = (href: string): number | null => {
    if (href === '/' && !cockpitMode) {
      const n = uncategorizedCount + pendingOpsCount
      return n > 0 ? n : null
    }
    return badgeFor(href)
  }

  const allMobileNavItems: { href: string; labelKey: NavLabelKey; icon: typeof LayoutDashboard }[] = cockpitMode
    ? cockpitNavItems.map(({ href, labelKey, icon }) => ({ href, labelKey, icon }))
    : [
        // The phone bar names the page the way the sidebar does: Att göra.
        { href: '/', labelKey: 'v2_todo' as NavLabelKey, icon: Home },
        { href: '/chat', labelKey: 'assistant', icon: Sparkles },
        { href: '/transactions', labelKey: 'transactions', icon: ArrowLeftRight },
      ]
  // Same gate as the sidebar: no Assistent tab until the agent is built.
  const mobileNavItems = allMobileNavItems.filter(
    (item) => item.href !== '/chat' || agentIdentity.isVerified,
  )

  const renderBadge = (item: { comingSoon?: boolean; devBadge?: boolean; betaBadge?: boolean; newBadge?: boolean }) => {
    const baseClass =
      'rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5'
    if (item.comingSoon) return <span className={baseClass}>{tNav('badge_coming_soon')}</span>
    if (item.devBadge) return <span className={baseClass}>{tNav('badge_dev')}</span>
    if (item.betaBadge) return <span className={baseClass}>{tNav('badge_beta')}</span>
    if (item.newBadge) return <span className={baseClass}>{tNav('badge_new')}</span>
    return null
  }

  const badgeFor = (href: string): number | null =>
    href === '/transactions' && uncategorizedCount > 0
      ? uncategorizedCount
      : href === '/pending' && pendingOpsCount > 0
        ? pendingOpsCount
        : null

  return (
    <>
      {/* Desktop sidebar; under md the mobile nav below takes over. */}
      <SidebarV2
        top={v2Top}
        company={v2Company}
        groupLabel={cockpitMode ? '' : tNav('v2_group_company')}
        label={(key) => tNav(key as NavLabelKey)}
        isActive={isActive}
        isEnabled={isItemEnabled}
        badgeFor={v2BadgeFor}
        renderIcon={(item, className) => (item.icon ? renderNavIcon({ href: item.href, icon: item.icon }, className) : null)}
        needsCompanyTitle={tNav('needs_company_tooltip')}
        betaLabel={tNav('badge_beta')}
        mainNavLabel={tNav('main_navigation')}
        brand={<BrandHomeLink showLabel />}
        backLink={
          byraTeam && !cockpitMode ? (
            <div className="mb-2">
              {cockpitExternal ? (
                <a
                  href={cockpitHref}
                  title={cockpitHint ?? undefined}
                  className="group flex items-center rounded-lg px-3 py-[7px] text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground"
                >
                  <ArrowLeft className="mr-2.5 h-[15px] w-[15px] flex-shrink-0" />
                  <span className="flex-1 min-w-0">
                    <span className="block">{tNav('back_to_clients')}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{cockpitHint}</span>
                  </span>
                </a>
              ) : (
                <NavLink
                  href={cockpitHref}
                  className="group flex items-center rounded-lg px-3 py-[7px] text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground"
                >
                  <ArrowLeft className="mr-2.5 h-[15px] w-[15px] flex-shrink-0" />
                  <span className="flex-1">{tNav('back_to_clients')}</span>
                </NavLink>
              )}
              <div className="mx-3 mt-2 border-t border-border/60" />
            </div>
          ) : null
        }
        userBlock={
          <div className="flex-shrink-0">
            <SubscriptionTouchpoint variant="sidebar" />
            <div className="mx-3 border-t border-border/60" />
            <div className="px-3 py-2">
              <UserMenu
                userName={userName}
                userEmail={userEmail}
                isSandbox={isSandbox}
                cockpitMode={cockpitMode}
                onLogout={() => void handleLogout()}
              />
            </div>
          </div>
        }
      />

      {/* Mobile bottom navigation. data-mobile-nav is the brand-style hook:
          on branded hosts the brand style block re-tints the bar's tokens
          (--card/--border/--primary...) to the deep chrome, mirroring the
          sidebar; on default hosts the attribute matches nothing.
          Height is --bottom-nav-h (globals.css): the tab row plus the safe
          area inset, the same token every bottom-pinned bar offsets by, so
          the nav and the bars cannot drift apart (#2738). */}
      <nav data-mobile-nav="" data-ph-unmask className="md:hidden fixed bottom-0 left-0 right-0 z-50 h-[var(--bottom-nav-h)] bg-card/98 backdrop-blur-sm border-t border-border/40" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label={tNav('mobile_navigation')}>
        <div className="flex items-center justify-around h-full px-2">
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
              <NavLink key={item.href} href={item.href} className={baseClass}>
                {content}
              </NavLink>
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
              {/* Byrå members inside a company: route back to the cockpit. */}
              {byraTeam && !cockpitMode && (
                <div className="mb-1.5">
                  {cockpitExternal ? (
                    <a
                      href={cockpitHref}
                      onClick={closeMobileMenu}
                      className="flex items-center gap-3 px-3 min-h-[44px] rounded-lg text-foreground active:bg-muted/60 transition-colors"
                    >
                      <ArrowLeft className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm">{tNav('back_to_clients')}</span>
                        {/* Visible cross-host hint: touch has no title tooltip. */}
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {cockpitHint}
                        </span>
                      </span>
                    </a>
                  ) : (
                    <NavLink
                      href={cockpitHref}
                      onClick={closeMobileMenu}
                      className="flex items-center gap-3 px-3 min-h-[44px] rounded-lg text-foreground active:bg-muted/60 transition-colors"
                    >
                      <ArrowLeft className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
                      <span className="text-sm flex-1">{tNav('back_to_clients')}</span>
                    </NavLink>
                  )}
                  <div className="mx-3 mt-1.5 h-px bg-border/30" />
                </div>
              )}
              {/* Top items (Hem, Assistent) */}
              <div className="space-y-0.5">
                {topItems.map((item) => {
                  const active = isActive(item.href)
                  const enabled = isItemEnabled(item.href)
                  const badge: number | null = null
                  const decorBadge = renderBadge(item)
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
                    <NavLink
                      key={item.href}
                      href={item.href}
                      onClick={closeMobileMenu}
                      className={baseClass}
                    >
                      {content}
                    </NavLink>
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
                      const active = isActive(item.href)
                      const enabled = isItemEnabled(item.href) && !item.comingSoon
                      const badge = item.href === '/transactions' && uncategorizedCount > 0
                        ? uncategorizedCount
                        : item.href === '/pending' && pendingOpsCount > 0
                          ? pendingOpsCount
                          : null
                      const decorBadge = renderBadge(item)
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
                        <NavLink
                          key={item.href}
                          href={item.href}
                          onClick={closeMobileMenu}
                          className={baseClass}
                        >
                          {content}
                        </NavLink>
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
                        <NavLink
                          key={item.href}
                          href={item.href}
                          onClick={closeMobileMenu}
                          className={baseClass}
                        >
                          {content}
                        </NavLink>
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
                  // Cockpit: settings open in byrå scope (account-level
                  // sections only), same as the desktop user menu.
                  { href: cockpitMode ? '/settings/account?ctx=byra' : '/settings', labelKey: 'settings' as NavLabelKey, icon: Settings },
                  { href: '/help', labelKey: 'help' as NavLabelKey, icon: HelpCircle },
                ]).map((item) => {
                  const active = isActive(item.href)
                  const enabled = isItemEnabled(item.href)
                  const content = (
                    <>
                      {renderNavIcon(item, cn('h-[18px] w-[18px] flex-shrink-0', active ? 'text-primary' : 'text-muted-foreground'))}
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
                    <NavLink
                      key={item.href}
                      href={item.href}
                      onClick={closeMobileMenu}
                      className={baseClass}
                    >
                      {content}
                    </NavLink>
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
