'use client'

import { useState, useRef } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  LayoutDashboard,
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
} from 'lucide-react'
import { getBranding } from '@/lib/branding/service'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { SupportLink } from '@/components/ui/support-link'
import CompanySwitcher from '@/components/dashboard/CompanySwitcher'
import { useCompany } from '@/contexts/CompanyContext'
import { clearRecaptIdentity } from '@/lib/recapt'
import type { EntityType } from '@/types'

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

interface NavItem {
  href: string
  label: string
  icon: typeof LayoutDashboard
  group: string
  modes?: EntityType[] // If set, only visible for these entity types. If not set, visible to all.
  hidden?: boolean // Temporarily hide from sidebar
  comingSoon?: boolean // Visible but disabled; shows "Kommer snart" badge
  devBadge?: boolean // Shows a "Dev" badge to indicate dev-only feature
  betaBadge?: boolean // Clickable; shows a "Beta" badge to indicate feature in testing
}

// All nav items for sidebar and mobile drawer
const navItems: NavItem[] = [
  { href: '/', label: 'Översikt', icon: LayoutDashboard, group: 'main' },
  { href: '/kpi', label: 'Nyckeltal', icon: TrendingUp, group: 'main' },
  { href: '/e/general/invoice-inbox', label: 'Dokumentinkorg', icon: Inbox, group: 'main', betaBadge: true },
  // AR — Accounts Receivable
  { href: '/invoices', label: 'Fakturor', icon: Receipt, group: 'försäljning' },
  { href: '/customers', label: 'Kunder', icon: Users, group: 'försäljning' },
  // AP — Accounts Payable
  { href: '/supplier-invoices', label: 'Leverantörsfakturor', icon: Wallet, group: 'inköp' },
  // Temporarily hidden pending module rework (see feedback #49)
  { href: '/suppliers', label: 'Leverantörer', icon: Building2, group: 'inköp', hidden: true },
  // General accounting
  { href: '/pending', label: 'Granskning', icon: ClipboardCheck, group: 'redovisning' },
  { href: '/transactions', label: 'Transaktioner', icon: ArrowLeftRight, group: 'redovisning' },
  { href: '/bookkeeping', label: 'Bokföring', icon: BookOpen, group: 'redovisning' },
  { href: '/reports', label: 'Rapporter', icon: BarChart3, group: 'redovisning' },
  { href: '/import', label: 'Importera', icon: Upload, group: 'redovisning' },
  // Personal — enabled in production with a "Beta" badge while we validate the
  // end-to-end salary + AGI flow with real customers.
  { href: '/salary', label: 'Löner', icon: HandCoins, group: 'personal', modes: ['aktiebolag'], betaBadge: true },
  { href: '/salary/employees', label: 'Anställda', icon: Users, group: 'personal', modes: ['aktiebolag'], betaBadge: true },
  { href: '/help', label: 'Hjälp', icon: HelpCircle, group: 'övrigt' },
  { href: '/settings', label: 'Inställningar', icon: Settings, group: 'övrigt' },
]

const groupLabels: Record<string, string> = {
  main: 'Huvudmeny',
  försäljning: 'Försäljning',
  inköp: 'Inköp',
  personal: 'Personal',
  redovisning: 'Redovisning',
  övrigt: 'Övrigt',
}

export default function DashboardNav({ companyName: _companyName, entityType, uncategorizedTransactionCount = 0, pendingOperationsCount = 0, isSandbox = false, extensionNavItems = [] }: DashboardNavProps) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const { company } = useCompany()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // When the user has no active company (e.g. just archived their last
  // one), every company-scoped route is unreachable. We keep them visible
  // so the sidebar doesn't collapse, but render them as disabled.
  // Only /settings remains navigable — from there the user can either
  // create a new company or delete their account.
  const hasCompany = !!company
  const ALWAYS_ENABLED = new Set(['/settings'])
  const isItemEnabled = (href: string) => hasCompany || ALWAYS_ENABLED.has(href)
  // Auto-expand Övrigt when the user is on one of its pages, or when manually toggled
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
    // For parent routes that have a sibling sub-route in the nav (e.g. /salary vs /salary/employees),
    // only match the parent for exact or non-overlapping sub-paths
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

  // Filter nav items by entity type, hidden flag, and conditional visibility
  const filteredItems = navItems.filter(item => {
    if (item.hidden) return false
    if (hiddenNavHrefs.has(item.href)) return false
    if (item.modes && !item.modes.includes(entityType)) return false
    // Only show Granskning when there are pending operations
    if (item.href === '/pending' && pendingOperationsCount === 0) return false
    return true
  })

  const mainItems = filteredItems.filter(i => i.group === 'main')
  const övrigtItems = filteredItems.filter(i => i.group === 'övrigt')

  // Groups rendered as distinct sidebar sections (AR, AP, Accounting)
  const sidebarGroups = [
    { key: 'försäljning', items: filteredItems.filter(i => i.group === 'försäljning'), spacing: 'mb-4' },
    { key: 'inköp', items: filteredItems.filter(i => i.group === 'inköp'), spacing: 'mb-4' },
    { key: 'redovisning', items: filteredItems.filter(i => i.group === 'redovisning'), spacing: 'mb-4' },
    { key: 'personal', items: filteredItems.filter(i => i.group === 'personal'), spacing: 'mb-6' },
  ] as const

  const mobileNavItems = [
    { href: '/', label: 'Översikt', icon: LayoutDashboard },
    { href: '/invoices', label: 'Fakturor', icon: Receipt },
    { href: '/transactions', label: 'Transaktioner', icon: ArrowLeftRight },
  ]

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
            <nav className="px-3" aria-label="Huvudnavigation">
              {/* Huvudmeny group */}
              <div className="mb-6">
                <p className="px-3 mb-1.5 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
                  {groupLabels.main}
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
                        <span className="flex-1">{item.label}</span>
                        {item.comingSoon ? (
                          <span className="ml-auto rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                            Kommer snart
                          </span>
                        ) : item.devBadge ? (
                          <span className="ml-auto rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                            Dev
                          </span>
                        ) : item.betaBadge ? (
                          <span className="ml-auto rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                            Beta
                          </span>
                        ) : null}
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
                        title="Lägg till ett företag för att aktivera"
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
                    {groupLabels[key]}
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
                      const content = (
                        <>
                          <Icon className={cn(
                            "mr-2.5 h-[15px] w-[15px] flex-shrink-0",
                            active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                          )} />
                          <span className="flex-1">{item.label}</span>
                          {item.comingSoon ? (
                            <span className="ml-auto rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                              Kommer snart
                            </span>
                          ) : item.devBadge ? (
                            <span className="ml-auto rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                              Dev
                            </span>
                          ) : item.betaBadge ? (
                            <span className="ml-auto rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                              Beta
                            </span>
                          ) : badge !== null && (
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
                          title={item.comingSoon ? 'Kommer snart' : 'Lägg till ett företag för att aktivera'}
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
                  <span>{groupLabels.övrigt}</span>
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
                      // Extension nav items are always company-scoped.
                      const enabled = hasCompany
                      const content = (
                        <>
                          <Icon className={cn(
                            "mr-2.5 h-[15px] w-[15px] flex-shrink-0",
                            active ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                          )} />
                          {item.label}
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
                          title="Lägg till ett företag för att aktivera"
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
                          {item.label}
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
                          title="Lägg till ett företag för att aktivera"
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
              {isSandbox ? 'Avsluta sandbox' : 'Logga ut'}
            </Button>
          </div>
        </div>
      </aside>

      {/* Mobile bottom navigation */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-card/98 backdrop-blur-sm border-t border-border/40" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label="Mobilnavigation">
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
                )}>{item.label}</span>
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
            aria-label="Öppna meny"
            className="flex flex-col items-center justify-center flex-1 h-full text-xs text-muted-foreground transition-colors duration-200"
          >
            <Menu className="h-5 w-5 mb-1" />
            <span>Meny</span>
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
            aria-label="Navigeringsmeny"
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
                aria-label="Stäng meny"
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
                      <span className="text-sm flex-1">{item.label}</span>
                      {item.comingSoon ? (
                        <span className="rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                          Kommer snart
                        </span>
                      ) : item.devBadge ? (
                        <span className="rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                          Dev
                        </span>
                      ) : item.betaBadge ? (
                        <span className="rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                          Beta
                        </span>
                      ) : null}
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
                    <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{groupLabels[key]}</span>
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
                      const content = (
                        <>
                          <Icon className={cn("h-[18px] w-[18px] flex-shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                          <span className="text-sm flex-1">{item.label}</span>
                          {item.comingSoon ? (
                            <span className="rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                              Kommer snart
                            </span>
                          ) : item.devBadge ? (
                            <span className="rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                              Dev
                            </span>
                          ) : item.betaBadge ? (
                            <span className="rounded-full bg-muted/60 text-muted-foreground/70 text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5">
                              Beta
                            </span>
                          ) : badge !== null && (
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
                <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">Övrigt</span>
                <div className="flex-1 h-px bg-border/30" />
              </div>

              {/* Other items */}
              <div className="space-y-0.5">
                {extensionNavItems.map((item) => {
                  const Icon = resolveIcon(item.icon)
                  const active = isActive(item.href)
                  const enabled = hasCompany
                  const content = (
                    <>
                      <Icon className={cn("h-[18px] w-[18px] flex-shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                      <span className="text-sm">{item.label}</span>
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
                      <span className="text-sm">{item.label}</span>
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
                {isSandbox ? 'Avsluta sandbox' : 'Logga ut'}
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
