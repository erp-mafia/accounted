'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
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
  BarChart3,
  Settings,
  LogOut,
  Inbox,
  Menu,
  X,
  HelpCircle,
  ChevronDown,
  Building2,
  Wallet,
  TrendingUp,
  ClipboardCheck,
  HandCoins,
  Package,
  Tag,
  ChevronsUpDown,
  Sparkles,
  Percent,
  Landmark,
  CalendarClock,
  FileCheck2,
  Blocks,
  Lock,
} from 'lucide-react'
import { getBranding } from '@/lib/branding/service'
import { ENABLED_EXTENSION_IDS as _ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { clearRecaptIdentity } from '@/lib/recapt'
import { SupportLink } from '@/components/ui/support-link'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import CompanySwitcher from '@/components/dashboard/CompanySwitcher'
import AgentAvatar from '@/components/agent/AgentAvatar'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { useCompany } from '@/contexts/CompanyContext'
import { CAPABILITY, type CapabilityKey } from '@/lib/entitlements/keys'
import { useRealtimeSupabase } from '@/lib/hooks/use-realtime-supabase'
import type { EntityType } from '@/types'

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
  // pays_salaries). Drives visibility of the payroll (Löner) surface for
  // non-aktiebolag — notably an enskild firma that hires staff. See #782.
  paysSalaries?: boolean
  uncategorizedTransactionCount?: number
  pendingOperationsCount?: number
  isSandbox?: boolean
  extensionNavItems?: ExtensionNavItem[]
  // Signed-in user's full name + email — drives the bottom-left account
  // popover trigger so the user can see WHO they're logged in as,
  // distinct from the active COMPANY shown by CompanySwitcher up top.
  userName?: string | null
  userEmail?: string | null
}

type NavLabelKey =
  | 'dashboard'
  | 'home'
  | 'assistant'
  | 'kpi'
  | 'invoice_inbox'
  | 'invoices'
  | 'customers'
  | 'articles'
  | 'supplier_invoices'
  | 'suppliers'
  | 'review'
  | 'transactions'
  | 'bookkeeping'
  | 'assets'
  | 'reports'
  | 'salary'
  | 'moms'
  | 'skattekonto'
  | 'deadlines'
  | 'bokslut'
  | 'moduler'
  | 'help'
  | 'settings'

// Interaction-mode IA (July 2026 — Phase 0 regroup; see dev_docs/nav_ia_redesign.md):
//   top-of-sidebar   — CompanySwitcher (active company / org context).
//   SPINE            — flat, no header: Hem, Anna. Anna is capability-gated (ai):
//                      free tier sees a locked upsell teaser → billing.
//   ATT GÖRA         — the daily-work funnel: Underlag (ai-gated), Transaktioner
//                      (badge), Granskning (badge). Folds into a unified /inbox
//                      in a later phase.
//   ARBETA           — produce: Fakturor, Leverantörsfakturor, Löner, Bokföring.
//   RAPPORTER        — Nyckeltal, Rapporter (merge into a tabbed surface later).
//   REGISTER & ARKIV — Kunder, Leverantörer, Artiklar, Anläggningar
//                      (Kontakter merge + Dokument shelf land later).
//   SKATT & BOKSLUT  — Moms, Skattekonto, Deadlines, Bokslut.
//   META footer      — Moduler (the rescued marketplace; hidden in sandbox).
//   bottom-left      — signed-in user popover: Inställningar, Hjälp, Support, Logga ut.
type RegionKey = 'spine' | 'attgora' | 'arbeta' | 'rapporter' | 'register' | 'skatt'

interface NavItem {
  href: string
  labelKey: NavLabelKey
  icon: typeof LayoutDashboard
  group: RegionKey
  // Payroll surfaces — visible only to employers: every aktiebolag (unchanged
  // behaviour) plus any company that has registered as an employer via
  // company_settings.pays_salaries (e.g. an enskild firma with staff). #782
  employerOnly?: boolean
  // Paid capability required to USE this surface. When the company lacks it the
  // row renders as a calm locked upsell teaser (→ /settings/billing) instead of
  // linking to a feature that would 403. Server-side gating is the source of
  // truth (see lib/entitlements); this only shapes the rail.
  capability?: CapabilityKey
  hidden?: boolean
  comingSoon?: boolean
  devBadge?: boolean
  betaBadge?: boolean
}

const navItems: NavItem[] = [
  // Spine — flat list, always visible, no header
  { href: '/', labelKey: 'home', icon: Home, group: 'spine' },
  { href: '/chat', labelKey: 'assistant', icon: Sparkles, group: 'spine', capability: CAPABILITY.ai },
  // Att göra — the daily funnel
  { href: '/e/general/invoice-inbox', labelKey: 'invoice_inbox', icon: Inbox, group: 'attgora', capability: CAPABILITY.ai },
  { href: '/transactions', labelKey: 'transactions', icon: ArrowLeftRight, group: 'attgora' },
  { href: '/pending', labelKey: 'review', icon: ClipboardCheck, group: 'attgora' },
  // Arbeta — produce (sälj → köp → bokför)
  { href: '/invoices', labelKey: 'invoices', icon: ReceiptText, group: 'arbeta' },
  { href: '/supplier-invoices', labelKey: 'supplier_invoices', icon: Wallet, group: 'arbeta' },
  // Löner — "Beta" while we validate the end-to-end salary + AGI flow.
  // employerOnly: shown to aktiebolag and to any employer (pays_salaries). #782
  { href: '/salary', labelKey: 'salary', icon: HandCoins, group: 'arbeta', employerOnly: true, betaBadge: true },
  { href: '/bookkeeping', labelKey: 'bookkeeping', icon: BookOpen, group: 'arbeta' },
  // Rapporter — the numbers (Nyckeltal + Rapporter merge into one tabbed surface later)
  { href: '/kpi', labelKey: 'kpi', icon: TrendingUp, group: 'rapporter' },
  { href: '/reports', labelKey: 'reports', icon: BarChart3, group: 'rapporter' },
  // Register & arkiv — master data (Kontakter merge + Dokument shelf land later)
  { href: '/customers', labelKey: 'customers', icon: Users, group: 'register' },
  { href: '/suppliers', labelKey: 'suppliers', icon: Building2, group: 'register' },
  { href: '/articles', labelKey: 'articles', icon: Tag, group: 'register' },
  { href: '/assets', labelKey: 'assets', icon: Package, group: 'register' },
  // Skatt & bokslut — comply
  { href: '/reports/vat-declaration', labelKey: 'moms', icon: Percent, group: 'skatt' },
  { href: '/skattekonto', labelKey: 'skattekonto', icon: Landmark, group: 'skatt' },
  { href: '/deadlines', labelKey: 'deadlines', icon: CalendarClock, group: 'skatt' },
  { href: '/bookkeeping/year-end', labelKey: 'bokslut', icon: FileCheck2, group: 'skatt' },
]

// Map known extension hrefs to nav translation keys so sidebar labels translate.
// Extensions whose manifest label happens to be English-ready can stay null.
function extensionLabelKey(href: string): string | null {
  if (href === '/e/general/tic') return 'ext_tic'
  if (href === '/e/general/invoice-inbox') return 'ext_invoice_inbox'
  return null
}

const groupLabelKey: Record<Exclude<RegionKey, 'spine'>, string> = {
  attgora: 'group_att_gora',
  arbeta: 'group_arbeta',
  rapporter: 'group_reports',
  register: 'group_register',
  skatt: 'group_skatt',
}

// Best single-character initial we can show in the bottom-left account
// trigger. Prefers the first letter of the user's full name; falls back
// to the email's first character; falls back to "?" so the avatar never
// renders empty.
function accountInitial(name: string | null, email: string | null): string {
  const trimmedName = name?.trim()
  if (trimmedName && trimmedName.length > 0) return trimmedName[0]!.toUpperCase()
  const trimmedEmail = email?.trim()
  if (trimmedEmail && trimmedEmail.length > 0) return trimmedEmail[0]!.toUpperCase()
  return '?'
}

export default function DashboardNav({ companyName: _companyName, entityType, paysSalaries = false, uncategorizedTransactionCount = 0, pendingOperationsCount = 0, isSandbox = false, extensionNavItems = [], userName = null, userEmail = null }: DashboardNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = useRealtimeSupabase()
  const { company, capabilities } = useCompany()
  // Agent identity drives the "Anna" nav icon — when the user has built their
  // assistant we show its chosen avatar instead of the generic Sparkles glyph.
  const { identity: agentIdentity } = useAgentSheet()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [liveUncategorizedTransactionCount, setLiveUncategorizedTransactionCount] = useState(
    uncategorizedTransactionCount,
  )
  const refreshInFlightRef = useRef(false)
  const refreshQueuedRef = useRef(false)

  // Capability axis (paid tier). Self-hosted resolves to all-on server-side, so
  // capabilities already includes 'ai' there — no special-casing needed here.
  const hasAi = capabilities.includes(CAPABILITY.ai)
  // A paid surface is LOCKED (upsell teaser, not a working link) when the
  // company doesn't hold its capability.
  const isLocked = (item: NavItem) => item.capability != null && !capabilities.includes(item.capability)

  const hasCompany = !!company
  const ALWAYS_ENABLED = new Set(['/settings'])
  const isItemEnabled = (href: string) => hasCompany || ALWAYS_ENABLED.has(href)
  // Per-region collapse state. Default: all expanded — the user can see every
  // child link without hunting. Clicking the chevron collapses; the active
  // route still forces its region expanded (so a deep-link into /salary keeps
  // Arbeta open even when manually collapsed).
  type ExpandableRegion = Exclude<RegionKey, 'spine'>
  const [manualCollapsed, setManualCollapsed] = useState<Record<ExpandableRegion, boolean>>({
    attgora: false,
    arbeta: false,
    rapporter: false,
    register: false,
    skatt: false,
  })
  const toggleGroup = (g: ExpandableRegion) =>
    setManualCollapsed((prev) => ({ ...prev, [g]: !prev[g] }))

  const openMobileMenu = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setIsClosing(false)
    setIsMobileMenuOpen(true)
  }

  const handleLogout = async () => {
    clearRecaptIdentity()
    await supabase.auth.signOut()
    router.push(isSandbox ? '/sandbox' : '/login')
  }

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/'
    if (href === '/salary') return pathname.startsWith('/salary')
    // Bokföring vs Bokslut — year-end is a sub-path, must not light up Bokföring.
    if (href === '/bookkeeping') return pathname.startsWith('/bookkeeping') && !pathname.startsWith('/bookkeeping/year-end')
    if (href === '/bookkeeping/year-end') return pathname.startsWith('/bookkeeping/year-end')
    // Rapporter vs Moms — vat-declaration is a sub-path of /reports.
    if (href === '/reports') return pathname.startsWith('/reports') && !pathname.startsWith('/reports/vat-declaration')
    if (href === '/reports/vat-declaration') return pathname.startsWith('/reports/vat-declaration')
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

    let cancelled = false

    const refreshUncategorizedCount = async () => {
      if (!company?.id || cancelled) return
      if (refreshInFlightRef.current) {
        refreshQueuedRef.current = true
        return
      }

      refreshInFlightRef.current = true
      try {
        do {
          refreshQueuedRef.current = false
          const { count, error } = await supabase
            .from('transactions')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', company.id)
            .is('is_business', null)
            .eq('is_ignored', false)

          if (error) {
            console.error('Failed to refresh uncategorized transaction count:', error)
            break
          }

          setLiveUncategorizedTransactionCount(count ?? 0)
        } while (refreshQueuedRef.current && !cancelled)
      } finally {
        refreshInFlightRef.current = false
        refreshQueuedRef.current = false
      }
    }

    void refreshUncategorizedCount()

    const channel = supabase
      .channel(`dashboard-nav:transactions:${company.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'transactions',
          filter: `company_id=eq.${company.id}`,
        },
        () => {
          void refreshUncategorizedCount()
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [company?.id, supabase])

  const hiddenNavHrefs = new Set(getBranding().hiddenNavHrefs)

  // Render a nav item's leading glyph. The "Anna" entry (/chat) shows the
  // agent's chosen avatar once built; everything else uses its lucide icon.
  const renderNavIcon = (
    item: { href: string; icon: typeof LayoutDashboard },
    className: string,
  ) => {
    if (item.href === '/chat' && agentIdentity.avatarId && hasAi) {
      return (
        <AgentAvatar
          avatarId={agentIdentity.avatarId}
          size="xs"
          alt={agentIdentity.displayName ?? 'Anna'}
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
    // Payroll (employerOnly) is hidden until the company is an employer.
    if (item.employerOnly && !isEmployer) return false
    // Anna (/chat): when ENTITLED but not yet built, hide it (building happens
    // via onboarding). When NOT entitled we keep the row as a locked upsell
    // teaser (handled in render), so the free tier discovers the AI value.
    if (item.href === '/chat' && hasAi && !agentIdentity.isVerified) return false
    return true
  })

  const spineItems = filteredItems.filter((i) => i.group === 'spine')

  // The TIC workspace (/e/general/tic) and any extension whose href we already
  // hardcode as a core nav item are dropped so nothing double-lists.
  const coreHrefs = new Set(navItems.map((i) => i.href))
  const visibleExtensionNavItems = extensionNavItems.filter(
    (i) => i.href !== '/e/general/tic' && !coreHrefs.has(i.href),
  )

  const sidebarGroups: { key: ExpandableRegion; items: NavItem[] }[] = [
    { key: 'attgora', items: filteredItems.filter((i) => i.group === 'attgora') },
    { key: 'arbeta', items: filteredItems.filter((i) => i.group === 'arbeta') },
    { key: 'rapporter', items: filteredItems.filter((i) => i.group === 'rapporter') },
    { key: 'register', items: filteredItems.filter((i) => i.group === 'register') },
    { key: 'skatt', items: filteredItems.filter((i) => i.group === 'skatt') },
  ]

  // A region is expanded when the user hasn't manually collapsed it OR an active
  // route lives inside it (the active route always wins so a deep-link keeps its
  // region open even if previously collapsed).
  const isGroupExpanded = (g: ExpandableRegion, items: NavItem[]) =>
    !manualCollapsed[g] || items.some((it) => isActive(it.href))

  // Mobile bottom tabs — the spine, verbatim (Hem, Anna when shown), plus
  // Transaktioner as the highest-frequency daily action. Anna follows the same
  // gate as the sidebar (locked teaser when unentitled, hidden when entitled-
  // but-unbuilt).
  const mobileNavItems: NavItem[] = [
    navItems.find((i) => i.href === '/')!,
    ...(spineItems.some((i) => i.href === '/chat') ? [navItems.find((i) => i.href === '/chat')!] : []),
    navItems.find((i) => i.href === '/transactions')!,
  ]

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

  // Count badge for an item (uncategorized transactions / pending review).
  const countBadgeFor = (href: string): number | null => {
    if (href === '/transactions' && liveUncategorizedTransactionCount > 0) return liveUncategorizedTransactionCount
    if (href === '/pending' && pendingOperationsCount > 0) return pendingOperationsCount
    return null
  }

  // Trailing element for a sidebar row: a lock (paid, unentitled), else a
  // decorative badge (Beta), else a count badge. Locked wins so the free tier
  // reads "upgrade" rather than a work count on a feature it can't use.
  const trailingSidebar = (item: NavItem) => {
    if (isLocked(item)) {
      return <Lock className="ml-auto h-3.5 w-3.5 text-muted-foreground/60" aria-hidden="true" />
    }
    const decor = renderBadge(item, 'sidebar')
    if (decor) return decor
    const count = countBadgeFor(item.href)
    if (count !== null) {
      return (
        <span className="ml-auto min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold px-1">
          {count > 99 ? '99+' : count}
        </span>
      )
    }
    return null
  }

  // A desktop sidebar row. Locked paid rows route to billing; everything else
  // links to its route (or renders disabled when there's no active company).
  const renderSidebarRow = (item: NavItem) => {
    const locked = isLocked(item)
    const active = !locked && isActive(item.href)
    const enabled = isItemEnabled(item.href) && !item.comingSoon
    const href = locked ? '/settings/billing' : item.href
    const content = (
      <>
        {renderNavIcon(
          item,
          cn(
            'mr-2.5 h-[15px] w-[15px] flex-shrink-0',
            active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
          ),
        )}
        <span className="flex-1">{tNav(item.labelKey)}</span>
        {trailingSidebar(item)}
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
    if (!enabled) {
      return (
        <div key={item.href} className={baseClass} aria-disabled="true" title={tNav('needs_company_tooltip')}>
          {content}
        </div>
      )
    }
    return (
      <Link
        key={item.href}
        href={href}
        className={baseClass}
        title={locked ? tNav('upgrade_for_ai') : undefined}
      >
        {content}
      </Link>
    )
  }

  // A mobile drawer row — mirrors renderSidebarRow with touch sizing + the
  // drawer's active styling.
  const renderMobileRow = (item: NavItem) => {
    const locked = isLocked(item)
    const active = !locked && isActive(item.href)
    const enabled = isItemEnabled(item.href) && !item.comingSoon
    const href = locked ? '/settings/billing' : item.href
    const badge = locked ? null : countBadgeFor(item.href)
    const decor = renderBadge(item, 'mobile')
    const content = (
      <>
        {renderNavIcon(item, cn('h-[18px] w-[18px] flex-shrink-0', active ? 'text-primary' : 'text-muted-foreground'))}
        <span className="text-sm flex-1">{tNav(item.labelKey)}</span>
        {locked ? (
          <Lock className="h-3.5 w-3.5 text-muted-foreground/60" aria-hidden="true" />
        ) : decor ? decor : badge !== null && (
          <span className="min-w-[20px] h-[20px] flex items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold px-1.5">
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
        href={href}
        onClick={closeMobileMenu}
        className={baseClass}
        title={locked ? tNav('upgrade_for_ai') : undefined}
      >
        {content}
      </Link>
    ) : (
      <div key={item.href} className={baseClass} aria-disabled="true">
        {content}
      </div>
    )
  }

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:fixed md:inset-y-0 md:flex md:w-64 md:flex-col">
        <div className="flex min-h-0 flex-1 flex-col border-r border-border bg-background">
          <div className="flex flex-1 flex-col overflow-y-auto pt-7 pb-4">
            {/* Company switcher pinned to the top — the active company is the
                strongest piece of context for everything below it. */}
            <div className="px-5 mb-8">
              <CompanySwitcher />
            </div>
            <nav className="px-3" aria-label={tNav('main_navigation')}>
              {/* Spine: flat, no header. Hem, Anna. */}
              <div className="mb-4 space-y-px">
                {spineItems.map((item) => renderSidebarRow(item))}
              </div>

              {/* Regions: Att göra, Arbeta, Rapporter, Register & arkiv, Skatt & bokslut */}
              {sidebarGroups
                .filter(({ items }) => items.length > 0)
                .map(({ key, items }) => {
                  const expanded = isGroupExpanded(key, items)
                  return (
                    <div key={key} className="mb-1">
                      <button
                        onClick={() => toggleGroup(key)}
                        className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] hover:text-foreground transition-colors rounded-lg"
                      >
                        <span>{tNav(groupLabelKey[key])}</span>
                        <ChevronDown
                          className={cn(
                            'h-3 w-3 transition-transform duration-200',
                            expanded && 'rotate-180',
                          )}
                        />
                      </button>
                      {expanded && (
                        <div className="space-y-px animate-fade-in mb-2">
                          {items.map((item) => renderSidebarRow(item))}
                          {/* Extension nav items land in Register & arkiv for now
                              (accounting-adjacent). Future categorised extensions
                              declare their own slot via the manifest. */}
                          {key === 'register' &&
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
                      )}
                    </div>
                  )
                })}
            </nav>
          </div>

          {/* Meta footer: Moduler (rescued marketplace) + account popover.
              Moduler is hidden in the sandbox (nothing to install there). */}
          <div className="flex-shrink-0 border-t border-border">
            {!isSandbox && hasCompany && (
              <div className="px-3 pt-3">
                <Link
                  href="/extensions"
                  className={cn(
                    'group flex items-center px-3 py-[7px] text-[13px] rounded-lg transition-colors duration-150',
                    isActive('/extensions')
                      ? 'bg-secondary text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60',
                  )}
                >
                  <Blocks
                    className={cn(
                      'mr-2.5 h-[15px] w-[15px] flex-shrink-0',
                      isActive('/extensions') ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground',
                    )}
                  />
                  <span className="flex-1">{tNav('moduler')}</span>
                </Link>
              </div>
            )}

            {/* Account popover (bottom-left). Triggered by the signed-in user's
                name + initial. Holds Inställningar, Hjälp, Support, Logga ut. */}
            <div className="px-3 py-3">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors duration-150"
                  >
                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold uppercase text-foreground">
                      {accountInitial(userName, userEmail)}
                    </span>
                    <span className="flex-1 truncate font-medium text-foreground">
                      {userName?.trim() || userEmail || tNav('mitt_konto')}
                    </span>
                    <ChevronsUpDown className="h-3.5 w-3.5 opacity-50 group-hover:opacity-100" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-60">
                  {(userName || userEmail) && (
                    <>
                      <DropdownMenuLabel className="font-normal">
                        <div className="flex flex-col gap-0.5">
                          {userName && (
                            <span className="text-sm font-medium text-foreground truncate">
                              {userName}
                            </span>
                          )}
                          {userEmail && (
                            <span className="text-xs text-muted-foreground truncate">
                              {userEmail}
                            </span>
                          )}
                        </div>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  <DropdownMenuItem asChild>
                    <Link href="/settings" className="cursor-pointer">
                      <Settings className="mr-2 h-4 w-4" />
                      {tNav('settings')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/help" className="cursor-pointer">
                      <HelpCircle className="mr-2 h-4 w-4" />
                      {tNav('help')}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <SupportLink variant="muted" className="cursor-pointer" />
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault()
                      void handleLogout()
                    }}
                    className="cursor-pointer text-muted-foreground focus:text-foreground"
                  >
                    <LogOut className="mr-2 h-4 w-4" />
                    {isSandbox ? tNav('logout_sandbox') : tCommon('logout')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile bottom navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card/98 backdrop-blur-sm border-t border-border/40" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label={tNav('mobile_navigation')}>
        <div className="flex items-center justify-around h-16 px-2">
          {mobileNavItems.map((item) => {
            const locked = isLocked(item)
            const active = !locked && isActive(item.href)
            const enabled = isItemEnabled(item.href)
            const badge = locked ? null : countBadgeFor(item.href)
            const href = locked ? '/settings/billing' : item.href

            const content = (
              <>
                <div className="relative">
                  {renderNavIcon(item, cn('h-5 w-5 mb-1', active && 'text-primary'))}
                  {locked && (
                    <span className="absolute -top-1.5 -right-2 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted">
                      <Lock className="h-2.5 w-2.5 text-muted-foreground" aria-hidden="true" />
                    </span>
                  )}
                  {!locked && badge !== null && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-semibold px-0.5">
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
              <Link key={item.href} href={href} className={baseClass}>
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

      {/* Mobile menu — bottom sheet */}
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
              "md:hidden fixed inset-x-0 bottom-0 z-50 bg-card rounded-t-2xl border-t border-border/40 overflow-y-auto overscroll-contain",
              isClosing
                ? "animate-out slide-out-to-bottom duration-200"
                : "animate-in slide-in-from-bottom duration-300"
            )}
            style={{ maxHeight: '85dvh', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
            role="dialog"
            aria-label={tNav('navigation_menu')}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1 sticky top-0 bg-card rounded-t-2xl">
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

            {/* Navigation */}
            <div className="px-2">
              {/* Spine (Hem, Anna) */}
              <div className="space-y-0.5">
                {spineItems.map((item) => renderMobileRow(item))}
              </div>

              {/* Regions */}
              {sidebarGroups.filter(({ items }) => items.length > 0).map(({ key, items }) => (
                <div key={key}>
                  <div className="flex items-center gap-3 my-1.5 px-3">
                    <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav(groupLabelKey[key])}</span>
                    <div className="flex-1 h-px bg-border/30" />
                  </div>
                  <div className="space-y-0.5">
                    {items.map((item) => renderMobileRow(item))}
                  </div>
                </div>
              ))}

              {/* Tillägg (extensions) — only when there's at least one */}
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

              {/* Meta (Moduler) + Mitt konto */}
              <div className="flex items-center gap-3 my-1.5 px-3">
                <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav('mitt_konto')}</span>
                <div className="flex-1 h-px bg-border/30" />
              </div>

              <div className="space-y-0.5">
                {(
                  [
                    ...(!isSandbox && hasCompany
                      ? [{ href: '/extensions', labelKey: 'moduler' as NavLabelKey, icon: Blocks }]
                      : []),
                    { href: '/settings', labelKey: 'settings' as NavLabelKey, icon: Settings },
                    { href: '/help', labelKey: 'help' as NavLabelKey, icon: HelpCircle },
                  ]
                ).map((item) => {
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
