'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  LayoutDashboard,
  Home,
  Receipt,
  Users,
  ArrowLeftRight,
  BookOpen,
  BarChart3,
  Settings,
  LogOut,
  Upload,
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
  ChevronsUpDown,
  Sparkles,
} from 'lucide-react'
import { getBranding } from '@/lib/branding/service'
import { ENABLED_EXTENSION_IDS as _ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
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
  | 'supplier_invoices'
  | 'suppliers'
  | 'review'
  | 'transactions'
  | 'bookkeeping'
  | 'assets'
  | 'reports'
  | 'import'
  | 'salary'
  | 'employees'
  | 'help'
  | 'settings'

// New nav layout (May 2026):
//   top-of-sidebar       — CompanySwitcher (active company / org context).
//   top section          — flat, no dropdown: Hem (agent), Underlag,
//                          Transaktioner, Granskning.
//   four dropdowns       — Försäljning, Inköp, Redovisning, Personal.
//   bottom-left popover  — signed-in user's name + initial, opens upward
//                          to Inställningar, Hjälp, Support, Logga ut.
// Help + Settings are NOT in `navItems` anymore; they live in the account
// popover. KPI moved from main to redovisning. Pending stays visible at all
// times — the inline badge carries the count.
type GroupKey = 'top' | 'försäljning' | 'inköp' | 'redovisning' | 'personal'

interface NavItem {
  href: string
  labelKey: NavLabelKey
  icon: typeof LayoutDashboard
  group: GroupKey
  modes?: EntityType[]
  hidden?: boolean
  comingSoon?: boolean
  devBadge?: boolean
  betaBadge?: boolean
}

const navItems: NavItem[] = [
  // Top section — flat list, always visible, no header
  { href: '/', labelKey: 'home', icon: Home, group: 'top' },
  { href: '/chat', labelKey: 'assistant', icon: Sparkles, group: 'top' },
  { href: '/e/general/invoice-inbox', labelKey: 'invoice_inbox', icon: Inbox, group: 'top' },
  { href: '/transactions', labelKey: 'transactions', icon: ArrowLeftRight, group: 'top' },
  { href: '/pending', labelKey: 'review', icon: ClipboardCheck, group: 'top' },
  // Försäljning dropdown
  { href: '/invoices', labelKey: 'invoices', icon: Receipt, group: 'försäljning' },
  { href: '/customers', labelKey: 'customers', icon: Users, group: 'försäljning' },
  // Inköp dropdown
  { href: '/supplier-invoices', labelKey: 'supplier_invoices', icon: Wallet, group: 'inköp' },
  { href: '/suppliers', labelKey: 'suppliers', icon: Building2, group: 'inköp' },
  // Redovisning dropdown
  { href: '/kpi', labelKey: 'kpi', icon: TrendingUp, group: 'redovisning' },
  { href: '/bookkeeping', labelKey: 'bookkeeping', icon: BookOpen, group: 'redovisning' },
  { href: '/assets', labelKey: 'assets', icon: Package, group: 'redovisning' },
  { href: '/reports', labelKey: 'reports', icon: BarChart3, group: 'redovisning' },
  { href: '/import', labelKey: 'import', icon: Upload, group: 'redovisning' },
  // Personal — "Beta" badge while we validate the end-to-end salary + AGI flow.
  { href: '/salary', labelKey: 'salary', icon: HandCoins, group: 'personal', modes: ['aktiebolag'], betaBadge: true },
  { href: '/salary/employees', labelKey: 'employees', icon: Users, group: 'personal', modes: ['aktiebolag'], betaBadge: true },
]

// Map known extension hrefs to nav translation keys so sidebar labels translate.
// Extensions whose manifest label happens to be English-ready can stay null.
function extensionLabelKey(href: string): string | null {
  if (href === '/e/general/tic') return 'ext_tic'
  if (href === '/e/general/invoice-inbox') return 'ext_invoice_inbox'
  return null
}

const groupLabelKey: Record<Exclude<GroupKey, 'top'>, string> = {
  försäljning: 'group_sales',
  inköp: 'group_purchases',
  redovisning: 'group_accounting',
  personal: 'group_personnel',
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

export default function DashboardNav({ companyName: _companyName, entityType, uncategorizedTransactionCount = 0, pendingOperationsCount = 0, isSandbox = false, extensionNavItems = [], userName = null, userEmail = null }: DashboardNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const { company } = useCompany()
  // Agent identity drives the "Assistent" nav icon — when the user has
  // built their assistant we show its chosen avatar instead of the
  // generic Sparkles glyph.
  const { identity: agentIdentity } = useAgentSheet()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasCompany = !!company
  const ALWAYS_ENABLED = new Set(['/settings'])
  const isItemEnabled = (href: string) => hasCompany || ALWAYS_ENABLED.has(href)
  // Per-group collapse state. Default: ALL groups expanded — the user
  // can see every child link without hunting. Clicking the chevron
  // collapses the group; opening it again restores the children.
  // Active route still forces a group expanded even when the user has
  // manually collapsed it (so deep-linking into /salary doesn't leave
  // Personal hidden).
  type ExpandableGroup = Exclude<GroupKey, 'top'>
  const [manualCollapsed, setManualCollapsed] = useState<Record<ExpandableGroup, boolean>>({
    försäljning: false,
    inköp: false,
    redovisning: false,
    personal: false,
  })
  const toggleGroup = (g: ExpandableGroup) =>
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

  const filteredItems = navItems.filter(item => {
    if (item.hidden) return false
    if (hiddenNavHrefs.has(item.href)) return false
    if (item.modes && !item.modes.includes(entityType)) return false
    // Hide the Assistent (/chat) tab until the agent is built — mirrors the
    // floating AgentTrigger and avoids a nav entry that only bounces to the
    // home checklist (chat/layout redirects unverified users to /).
    if (item.href === '/chat' && !agentIdentity.isVerified) return false
    // Granskning stays in the top nav at all times now — the badge
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
    { key: 'försäljning', items: filteredItems.filter((i) => i.group === 'försäljning') },
    { key: 'inköp', items: filteredItems.filter((i) => i.group === 'inköp') },
    { key: 'redovisning', items: filteredItems.filter((i) => i.group === 'redovisning') },
    { key: 'personal', items: filteredItems.filter((i) => i.group === 'personal') },
  ]

  // A group is expanded when the user hasn't manually collapsed it OR
  // an active route lives inside it (the active route always wins so a
  // deep-link to /salary keeps Personal open even if previously collapsed).
  const isGroupExpanded = (g: ExpandableGroup, items: NavItem[]) =>
    !manualCollapsed[g] || items.some((it) => isActive(it.href))

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

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:fixed md:inset-y-0 md:flex md:w-64 md:flex-col">
        <div className="flex min-h-0 flex-1 flex-col border-r border-border bg-background">
          <div className="flex flex-1 flex-col overflow-y-auto pt-7 pb-4">
            {/* Company switcher pinned to the top — the active company is
                the strongest piece of context for everything below it. */}
            <div className="px-5 mb-8">
              <CompanySwitcher />
            </div>
            <nav className="px-3" aria-label={tNav('main_navigation')}>
              {/* Top section: flat, no header. Hem, Underlag, Transaktioner, Granskning. */}
              <div className="mb-4 space-y-px">
                {topItems.map((item) => {
                  const active = isActive(item.href)
                  const enabled = isItemEnabled(item.href)
                  const badge =
                    item.href === '/transactions' && uncategorizedTransactionCount > 0
                      ? uncategorizedTransactionCount
                      : item.href === '/pending' && pendingOperationsCount > 0
                        ? pendingOperationsCount
                        : null
                  const decorBadge = renderBadge(item, 'sidebar')
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
                      {decorBadge ? decorBadge : badge !== null && (
                        <span className="ml-auto min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold px-1">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      )}
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

              {/* Collapsible groups: Försäljning, Inköp, Redovisning, Personal */}
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
                          {items.map((item) => {
                            const Icon = item.icon
                            const active = isActive(item.href)
                            const enabled = isItemEnabled(item.href) && !item.comingSoon
                            const decorBadge = renderBadge(item, 'sidebar')
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
                                <span className="flex-1">{tNav(item.labelKey)}</span>
                                {decorBadge}
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
                                title={
                                  item.comingSoon
                                    ? tNav('badge_coming_soon')
                                    : tNav('needs_company_tooltip')
                                }
                              >
                                {content}
                              </div>
                            )
                          })}
                          {/* Extension nav items land in Redovisning since the
                              current extensions (TIC workspace, etc.) are
                              accounting-adjacent. Future categorised extensions
                              can opt into a different group via their manifest. */}
                          {key === 'redovisning' &&
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

          {/* Account popover (bottom-left). Triggered by the signed-in
              user's name + initial. Holds Inställningar, Hjälp, Support,
              Logga ut. CompanySwitcher lives at the top of the sidebar,
              not in here — different concept ("which company am I working
              with" vs "who am I logged in as"). */}
          <div className="flex-shrink-0 px-3 py-3 border-t border-border">
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
      </aside>

      {/* Mobile bottom navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card/98 backdrop-blur-sm border-t border-border/40" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label={tNav('mobile_navigation')}>
        <div className="flex items-center justify-around h-16 px-2">
          {mobileNavItems.map((item) => {
            const active = isActive(item.href)
            const enabled = isItemEnabled(item.href)
            const badge = item.href === '/transactions' && uncategorizedTransactionCount > 0
              ? uncategorizedTransactionCount
              : null

            const content = (
              <>
                <div className="relative">
                  {renderNavIcon(item, cn('h-5 w-5 mb-1', active && 'text-primary'))}
                  {badge !== null && (
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
              {/* Top items (Hem, Underlag, Transaktioner, Granskning) */}
              <div className="space-y-0.5">
                {topItems.map((item) => {
                  const active = isActive(item.href)
                  const enabled = isItemEnabled(item.href)
                  const badge =
                    item.href === '/transactions' && uncategorizedTransactionCount > 0
                      ? uncategorizedTransactionCount
                      : item.href === '/pending' && pendingOperationsCount > 0
                        ? pendingOperationsCount
                        : null
                  const decorBadge = renderBadge(item, 'mobile')
                  const content = (
                    <>
                      {renderNavIcon(item, cn('h-[18px] w-[18px] flex-shrink-0', active ? 'text-primary' : 'text-muted-foreground'))}
                      <span className="text-sm flex-1">{tNav(item.labelKey)}</span>
                      {decorBadge ? decorBadge : badge !== null && (
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

              {/* AR / AP / Personal / Accounting groups (mobile) */}
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
                      const badge = item.href === '/transactions' && uncategorizedTransactionCount > 0
                        ? uncategorizedTransactionCount
                        : item.href === '/pending' && pendingOperationsCount > 0
                          ? pendingOperationsCount
                          : null
                      const decorBadge = renderBadge(item, 'mobile')
                      const content = (
                        <>
                          <Icon className={cn("h-[18px] w-[18px] flex-shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                          <span className="text-sm flex-1">{tNav(item.labelKey)}</span>
                          {decorBadge ? decorBadge : badge !== null && (
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

              {/* Mitt konto divider */}
              <div className="flex items-center gap-3 my-1.5 px-3">
                <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav('mitt_konto')}</span>
                <div className="flex-1 h-px bg-border/30" />
              </div>

              <div className="space-y-0.5">
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
