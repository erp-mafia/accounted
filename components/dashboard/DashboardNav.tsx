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
} from 'lucide-react'
import { getBranding } from '@/lib/branding/service'
import { ENABLED_EXTENSION_IDS as _ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { SupportLink } from '@/components/ui/support-link'
import CompanySwitcher from '@/components/dashboard/CompanySwitcher'
import { useCompany } from '@/contexts/CompanyContext'
import { clearRecaptIdentity } from '@/lib/recapt'
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
}

type NavLabelKey =
  | 'dashboard'
  | 'home'
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

type GroupKey = 'main' | 'försäljning' | 'inköp' | 'redovisning' | 'personal' | 'övrigt'

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
  // Home points to the agent chat — the agent IS the entry point on this build.
  // labelKey 'home' resolves to "Hem" / "Home"; keeping the i18n primitive even
  // though the underlying route changed.
  { href: '/chat', labelKey: 'home', icon: Home, group: 'main' },
  { href: '/kpi', labelKey: 'kpi', icon: TrendingUp, group: 'main' },
  { href: '/e/general/invoice-inbox', labelKey: 'invoice_inbox', icon: Inbox, group: 'main', betaBadge: true },
  // AR — Accounts Receivable
  { href: '/invoices', labelKey: 'invoices', icon: Receipt, group: 'försäljning' },
  { href: '/customers', labelKey: 'customers', icon: Users, group: 'försäljning' },
  // AP — Accounts Payable
  { href: '/supplier-invoices', labelKey: 'supplier_invoices', icon: Wallet, group: 'inköp' },
  { href: '/suppliers', labelKey: 'suppliers', icon: Building2, group: 'inköp', hidden: true },
  // General accounting
  { href: '/pending', labelKey: 'review', icon: ClipboardCheck, group: 'redovisning' },
  { href: '/transactions', labelKey: 'transactions', icon: ArrowLeftRight, group: 'redovisning' },
  { href: '/bookkeeping', labelKey: 'bookkeeping', icon: BookOpen, group: 'redovisning' },
  { href: '/assets', labelKey: 'assets', icon: Package, group: 'redovisning' },
  { href: '/reports', labelKey: 'reports', icon: BarChart3, group: 'redovisning' },
  { href: '/import', labelKey: 'import', icon: Upload, group: 'redovisning' },
  // Personal — enabled in production with a "Beta" badge while we validate the
  // end-to-end salary + AGI flow with real customers.
  { href: '/salary', labelKey: 'salary', icon: HandCoins, group: 'personal', modes: ['aktiebolag'], betaBadge: true },
  { href: '/salary/employees', labelKey: 'employees', icon: Users, group: 'personal', modes: ['aktiebolag'], betaBadge: true },
  { href: '/help', labelKey: 'help', icon: HelpCircle, group: 'övrigt' },
  { href: '/settings', labelKey: 'settings', icon: Settings, group: 'övrigt' },
]

// Map known extension hrefs to nav translation keys so sidebar labels translate.
// Extensions whose manifest label happens to be English-ready can stay null.
function extensionLabelKey(href: string): string | null {
  if (href === '/e/general/tic') return 'ext_tic'
  if (href === '/e/general/invoice-inbox') return 'ext_invoice_inbox'
  return null
}

const groupLabelKey: Record<GroupKey, string> = {
  main: 'group_main',
  försäljning: 'group_sales',
  inköp: 'group_purchases',
  redovisning: 'group_accounting',
  personal: 'group_personnel',
  övrigt: 'group_other',
}

export default function DashboardNav({ companyName: _companyName, entityType, uncategorizedTransactionCount = 0, pendingOperationsCount = 0, isSandbox = false, extensionNavItems = [] }: DashboardNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const { company } = useCompany()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const hasCompany = !!company
  const ALWAYS_ENABLED = new Set(['/settings'])
  const isItemEnabled = (href: string) => hasCompany || ALWAYS_ENABLED.has(href)
  const isOnOvrigtPage = ['/help', '/settings', '/e/'].some(p => pathname.startsWith(p))
  const [manualOvrigtExpanded, setManualOvrigtExpanded] = useState(false)
  const isOvrigtExpanded = isOnOvrigtPage || manualOvrigtExpanded

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

  const filteredItems = navItems.filter(item => {
    if (item.hidden) return false
    if (hiddenNavHrefs.has(item.href)) return false
    if (item.modes && !item.modes.includes(entityType)) return false
    if (item.href === '/pending' && pendingOperationsCount === 0) return false
    return true
  })

  const mainItems = filteredItems.filter(i => i.group === 'main')
  const övrigtItems = filteredItems.filter(i => i.group === 'övrigt')

  const sidebarGroups: { key: GroupKey; items: NavItem[]; spacing: string }[] = [
    { key: 'försäljning', items: filteredItems.filter(i => i.group === 'försäljning'), spacing: 'mb-4' },
    { key: 'inköp', items: filteredItems.filter(i => i.group === 'inköp'), spacing: 'mb-4' },
    { key: 'redovisning', items: filteredItems.filter(i => i.group === 'redovisning'), spacing: 'mb-4' },
    { key: 'personal', items: filteredItems.filter(i => i.group === 'personal'), spacing: 'mb-6' },
  ]

  const mobileNavItems: { href: string; labelKey: NavLabelKey; icon: typeof LayoutDashboard }[] = [
    { href: '/chat', labelKey: 'home', icon: Home },
    { href: '/invoices', labelKey: 'invoices', icon: Receipt },
    { href: '/transactions', labelKey: 'transactions', icon: ArrowLeftRight },
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

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden md:fixed md:inset-y-0 md:flex md:w-64 md:flex-col">
        <div className="flex min-h-0 flex-1 flex-col border-r border-border bg-background">
          <div className="flex flex-1 flex-col overflow-y-auto pt-7 pb-4">
            {/* Company switcher */}
            <div className="px-5 mb-8">
              <CompanySwitcher />
            </div>

            {/* Navigation with group headers */}
            <nav className="px-3" aria-label={tNav('main_navigation')}>
              {/* Main group */}
              <div className="mb-6">
                <p className="px-3 mb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
                  {tNav('group_main')}
                </p>
                <div className="space-y-px">
                  {mainItems.map((item) => {
                    const Icon = item.icon
                    const active = isActive(item.href)
                    const enabled = isItemEnabled(item.href)
                    const content = (
                      <>
                        <Icon className={cn(
                          "mr-2.5 h-[15px] w-[15px] flex-shrink-0",
                          active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                        )} />
                        <span className="flex-1">{tNav(item.labelKey)}</span>
                        {renderBadge(item, 'sidebar')}
                      </>
                    )
                    const baseClass = cn(
                      'group flex items-center px-3 py-[7px] text-[13px] rounded-lg',
                      enabled
                        ? cn(
                            'transition-colors duration-150',
                            active
                              ? 'bg-secondary text-foreground font-medium'
                              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                          )
                        : 'text-muted-foreground/40 cursor-not-allowed'
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

              {/* AR / AP / Personal / Accounting groups */}
              {sidebarGroups.filter(({ items }) => items.length > 0).map(({ key, items, spacing }) => (
                <div key={key} className={spacing}>
                  <p className="px-3 mb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
                    {tNav(groupLabelKey[key])}
                  </p>
                  <div className="space-y-px">
                    {items.map((item) => {
                      const Icon = item.icon
                      const active = isActive(item.href)
                      const enabled = isItemEnabled(item.href) && !item.comingSoon
                      const badge = item.href === '/transactions' && uncategorizedTransactionCount > 0
                        ? uncategorizedTransactionCount
                        : item.href === '/pending' && pendingOperationsCount > 0
                          ? pendingOperationsCount
                          : null
                      const decorBadge = renderBadge(item, 'sidebar')
                      const content = (
                        <>
                          <Icon className={cn(
                            "mr-2.5 h-[15px] w-[15px] flex-shrink-0",
                            active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                          )} />
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
                                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                            )
                          : 'text-muted-foreground/40 cursor-not-allowed'
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
                    })}
                  </div>
                </div>
              ))}

              {/* Övrigt group - collapsible */}
              <div className="mb-4">
                <button
                  onClick={() => setManualOvrigtExpanded(!isOvrigtExpanded)}
                  className="w-full flex items-center justify-between px-3 mb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] hover:text-muted-foreground transition-colors"
                >
                  <span>{tNav('group_other')}</span>
                  <ChevronDown className={cn(
                    "h-3 w-3 transition-transform duration-200",
                    isOvrigtExpanded && "rotate-180"
                  )} />
                </button>
                {isOvrigtExpanded && (
                  <div className="space-y-px animate-fade-in">
                    {extensionNavItems.map((item) => {
                      const Icon = resolveIcon(item.icon)
                      const active = isActive(item.href)
                      const enabled = hasCompany
                      const labelTranslationKey = extensionLabelKey(item.href)
                      const label = labelTranslationKey ? tNav(labelTranslationKey) : item.label
                      const content = (
                        <>
                          <Icon className={cn(
                            "mr-2.5 h-[15px] w-[15px] flex-shrink-0",
                            active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                          )} />
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
                                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                            )
                          : 'text-muted-foreground/40 cursor-not-allowed'
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
                    {övrigtItems.map((item) => {
                      const Icon = item.icon
                      const active = isActive(item.href)
                      const enabled = isItemEnabled(item.href)
                      const content = (
                        <>
                          <Icon className={cn(
                            "mr-2.5 h-[15px] w-[15px] flex-shrink-0",
                            active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                          )} />
                          {tNav(item.labelKey)}
                        </>
                      )
                      const baseClass = cn(
                        'group flex items-center px-3 py-[7px] text-[13px] rounded-lg',
                        enabled
                          ? cn(
                              'transition-colors duration-150',
                              active
                                ? 'bg-secondary text-foreground font-medium'
                                : 'text-muted-foreground hover:text-foreground hover:bg-secondary/60'
                            )
                          : 'text-muted-foreground/40 cursor-not-allowed'
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
            </nav>
          </div>

          {/* Support + Logout */}
          <div className="flex-shrink-0 px-3 py-3 border-t border-border space-y-1">
            <div className="px-3 py-1.5">
              <SupportLink variant="muted" />
            </div>
            <Button
              variant="ghost"
              className="w-full justify-start text-muted-foreground hover:text-foreground text-[13px] h-9 px-3"
              onClick={handleLogout}
            >
              <LogOut className="mr-2.5 h-[15px] w-[15px]" />
              {isSandbox ? tNav('logout_sandbox') : tCommon('logout')}
            </Button>
          </div>
        </div>
      </aside>

      {/* Mobile bottom navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card/98 backdrop-blur-sm border-t border-border/40" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label={tNav('mobile_navigation')}>
        <div className="flex items-center justify-around h-16 px-2">
          {mobileNavItems.map((item) => {
            const Icon = item.icon
            const active = isActive(item.href)
            const enabled = isItemEnabled(item.href)
            const badge = item.href === '/transactions' && uncategorizedTransactionCount > 0
              ? uncategorizedTransactionCount
              : null

            const content = (
              <>
                <div className="relative">
                  <Icon className={cn(
                    "h-5 w-5 mb-1",
                    active && "text-primary"
                  )} />
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
              {/* Main items */}
              <div className="space-y-0.5">
                {mainItems.map((item) => {
                  const Icon = item.icon
                  const active = isActive(item.href)
                  const enabled = isItemEnabled(item.href)
                  const content = (
                    <>
                      <Icon className={cn("h-[18px] w-[18px] flex-shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                      <span className="text-sm flex-1">{tNav(item.labelKey)}</span>
                      {renderBadge(item, 'mobile')}
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

              {/* Övrigt divider */}
              <div className="flex items-center gap-3 my-1.5 px-3">
                <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav('group_other')}</span>
                <div className="flex-1 h-px bg-border/30" />
              </div>

              {/* Other items */}
              <div className="space-y-0.5">
                {extensionNavItems.map((item) => {
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
                {övrigtItems.map((item) => {
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
