'use client'

import { useEffect, useState, useRef, type ComponentType } from 'react'
import { NavLink } from './NavLink'
import { usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ArrowLeftIcon,
  ArrowRightStartOnRectangleIcon,
  ArrowsRightLeftIcon,
  Bars3Icon,
  Cog6ToothIcon,
  DocumentTextIcon,
  HomeIcon,
  QuestionMarkCircleIcon,
  SparklesIcon,
  UsersIcon,
  XMarkIcon,
  type Icon,
} from '@/components/icons'
import { getBranding } from '@/lib/branding/service'
import { BrandHomeLink } from '@/components/branding/BrandHomeLink'
import { ENABLED_EXTENSION_IDS as _ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { SupportLink } from '@/components/ui/support-link'
import CompanySwitcher from '@/components/dashboard/CompanySwitcher'
import UserMenu from '@/components/dashboard/UserMenu'
import SubscriptionTouchpoint from '@/components/billing/SubscriptionTouchpoint'
import AgentAvatar from '@/components/agent/AgentAvatar'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { useCompany } from '@/contexts/CompanyContext'
import { useWorklistBadges } from '@/lib/hooks/use-worklist-badges'
import type { EntityType } from '@/types'
import type { CapabilitySurface } from '@/lib/modules/capabilities'
import { gateNavTree, passesNavGates, type NavGateContext } from '@/lib/navigation/nav-gates'
import { isInvoicerRole } from '@/lib/auth/invoicer-role'
import { SidebarV2 } from './SidebarV2'
import { signOutAndNavigate } from '@/lib/auth/session-client'
import { NAV_V2_COMPANY, NAV_V2_TOP, claimedRowActive, type NavGateFlags, type NavV2Item } from './nav-v2'
import { cockpitNavItems, navItems, type GroupKey, type NavItem, type NavLabelKey } from './nav-phone'
import { useNavRowClaim } from './nav-row-claim'

void _ENABLED_EXTENSION_IDS

interface ExtensionNavItem {
  href: string
  label: string
  icon: string
}

interface DashboardNavProps {
  companyName: string
  entityType: EntityType
  // The company's resolved capabilities as the menu reads them
  // (capabilitySurface in lib/modules/capabilities.ts, resolved by the
  // layout): a module whose package is off or not in the country hides, and
  // so does a module the legal form does not offer, such as payroll for an
  // enskild firma that has not flagged pays_salaries (#782).
  capabilitySurface: CapabilitySurface
  // Whether the dimensions register (company_settings.dimensions_enabled) is
  // switched on. Drives visibility of the Kostnadsställen & projekt row:
  // fetched by the dashboard layout.
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
  // Order row: same mechanism as dimensionsEnabled, fetched by the layout.
  hasWebshop?: boolean
  // Whether the Körjournal row shows: the company_settings.mileage_enabled
  // toggle OR existing mileage_trips rows (trips created via API/MCP must
  // stay reachable). Computed by the dashboard layout.
  hasMileage?: boolean
  // Whether the Utlägg row shows: existing expense_claims rows. New utlägg
  // start from the Underlag pane ("Vem betalade?"), so the page only earns a
  // nav row once there is a person to pay out. Computed by the layout.
  hasExpenseClaims?: boolean
  // Whether the Kassarapporter row shows: a POS connection exists (live or
  // ended, so fetched days stay reachable). Computed by the layout.
  hasPosSales?: boolean
  // Whether the company is in the Arkiv rollout (ARKIV_COMPANY_IDS). Computed by the layout.
  arkivEnabled?: boolean
  // Whether BankID document signing is switched on (the Signeringar page). Computed by the layout.
  signingEnabled?: boolean
  agentsEnabled?: boolean
  // Whether the company is in the new Inkorg page's rollout (INKORG_V2_COMPANY_IDS): Inkorg
  // at the top, Underlag out of Inköp. Computed by the layout.
  inkorgV2Enabled?: boolean
  // Whether the company is in the Autogiro rollout (AUTOGIRO_COMPANY_IDS): the
  // Autogiro row under Fakturering. Computed by the layout.
  autogiroEnabled?: boolean
  /** The Bolaget registers are rolled out to this company (lib/env/bolaget-switch.ts). */
  bolagetEnabled?: boolean
  isSandbox?: boolean
  extensionNavItems?: ExtensionNavItem[]
  // Signed-in user's full name + email: drives the bottom-left account
  // popover trigger so the user can see WHO they're logged in as,
  // distinct from the active COMPANY shown by CompanySwitcher up top.
  userName?: string | null
  userEmail?: string | null
}

// Cockpit routes are byrå-scope, not company-scope: they decide which
// sidebar variant renders and stay enabled without an active company.
const COCKPIT_PATHS = ['/byra', '/clients']
const isCockpitPath = (pathname: string) =>
  COCKPIT_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))

// Map known extension hrefs to nav translation keys so sidebar labels translate.
// Extensions whose manifest label happens to be English-ready can stay null.
function extensionLabelKey(href: string): string | null {
  if (href === '/e/general/invoice-inbox') return 'ext_invoice_inbox'
  return null
}

const groupLabelKey: Record<Exclude<GroupKey, 'top'>, string> = {
  arbeta: 'group_work',
  analys: 'group_analysis',
  data: 'group_data',
  skatt: 'group_tax',
}

export default function DashboardNav({ companyName: _companyName, entityType, capabilitySurface, dimensionsEnabled = false, salesOrdersEnabled = false, quotesEnabled = true, hasWebshop = false, hasMileage = false, hasExpenseClaims = false, hasPosSales = false, arkivEnabled = false, signingEnabled = false, agentsEnabled = false, inkorgV2Enabled = false, autogiroEnabled = false, bolagetEnabled = false, isSandbox = false, extensionNavItems = [], userName = null, userEmail = null }: DashboardNavProps) {
  const pathname = usePathname()
  const navRowClaim = useNavRowClaim(pathname)
  const { company, capabilities, byraTeam, role } = useCompany()
  // Agent identity drives the "Assistent" nav icon: when the user has
  // built their assistant we show its chosen avatar instead of the
  // generic sparkles glyph.
  const { identity: agentIdentity } = useAgentSheet()
  const tNav = useTranslations('nav')
  const tCommon = useTranslations('common')
  const tSwitcher = useTranslations('company_switcher')
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Badge counts load client-side after mount (and refresh as described in
  // lib/hooks/use-worklist-badges). They used to arrive as server props, which
  // put two head-count queries on the critical path of every dashboard
  // navigation for numbers nobody needs before first paint.
  const {
    uncategorized: uncategorizedCount,
    pendingOperations: pendingOpsCount,
    nudge: nudgeBadges,
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
    // The server revokes the session and deletes the HttpOnly cookie; the
    // helper then clears what the browser held (token, storage including an
    // unsent support draft, analytics identity, stray legacy auth cookies)
    // and leaves with a full page load.
    await signOutAndNavigate(isSandbox ? '/sandbox' : '/login')
  }

  const isActive = (href: string) => {
    // A page that names its own row (an offert in the invoice editor) wins
    // over the URL's prefix match.
    const claimed = claimedRowActive(href, pathname, navRowClaim)
    if (claimed !== undefined) return claimed
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
    // One account's reconciliation (/reconciliation?account=) is opened from
    // the Konton list and has no row of its own.
    if (href === '/accounts') {
      return pathname.startsWith('/accounts') || pathname.startsWith('/reconciliation')
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
        !pathname.startsWith('/reports/ne-declaration') &&
        !pathname.startsWith('/reports/ink3-declaration')
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
    }, 150)
  }

  // The badges refresh on return to the tab and on a slow backstop
  // (lib/hooks/use-worklist-badges). A navigation re-reads them too when the
  // last answer is stale, so a change made in a dialog on one page shows on
  // the next. No realtime channel here: one per open tab kept the Realtime
  // WAL poller (the biggest database consumer) running around the clock.
  useEffect(() => {
    nudgeBadges()
  }, [pathname, nudgeBadges])

  const hiddenNavHrefs = new Set(getBranding().hiddenNavHrefs)

  // Render a nav item's leading glyph. The "Assistent" entry (/chat) shows
  // the agent's chosen avatar once built; everything else (and the
  // pre-onboarding /chat) uses its menu icon. The passed className carries
  // size + margin + active color; tailwind-merge lets the explicit h/w win
  // over AgentAvatar's default box size.
  const renderNavIcon = (
    item: { href: string; icon: ComponentType<{ className?: string }> },
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

  // One gate for both navigations: a surface hides for the same reason in
  // the sidebar tree (nav-v2.ts) and in the phone menu. The gate itself lives
  // in lib/navigation/nav-gates.ts so the assistant's UI map applies the same
  // one. Granskning stays in the top nav at all times: the badge surfaces the
  // count when there are pending ops, but the link is always present.
  const gateContext: NavGateContext = {
    entityType,
    // The resolved capabilities: payroll shows for every juridisk person and
    // for a form whose org number is the owner's personnummer once it opts in
    // through pays_salaries, by the rule the MCP capabilities report shares.
    // #782
    surface: capabilitySurface,
    dimensionsEnabled,
    salesOrdersEnabled,
    quotesEnabled,
    hasWebshop,
    hasMileage,
    hasExpenseClaims,
    hasPosSales,
    arkivEnabled,
    signingEnabled,
    agentsEnabled,
    inkorgV2Enabled,
    autogiroEnabled,
    bolagetEnabled,
    capabilities,
    hiddenNavHrefs,
    role,
  }
  const passesGates = (item: NavGateFlags) => passesNavGates(item, gateContext)
  const filteredItems = (cockpitMode ? cockpitNavItems : navItems).filter(passesGates)

  const topItems = filteredItems.filter((i) => i.group === 'top')

  // Extension workspaces are company surfaces: none in cockpit mode.
  const visibleExtensionNavItems = cockpitMode ? [] : extensionNavItems

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
  const v2Top: NavV2Item[] = cockpitMode
    ? cockpitNavItems.filter(passesGates).map(({ href, module, labelKey, icon }) => ({ href, module, labelKey, icon }))
    : gateNavTree(NAV_V2_TOP, gateContext)
  const v2Company = cockpitMode ? [] : gateNavTree(NAV_V2_COMPANY, gateContext)
  // Att göra carries the whole queue (unbooked rows + staged operations);
  // Transaktioner and Assistentens förslag keep their own share.
  const v2BadgeFor = (href: string): number | null => {
    if (href === '/' && !cockpitMode) {
      const n = uncategorizedCount + pendingOpsCount
      return n > 0 ? n : null
    }
    return badgeFor(href)
  }

  const mobileNavItems: { href: string; labelKey: NavLabelKey; icon: Icon }[] = cockpitMode
    ? cockpitNavItems.map(({ href, labelKey, icon }) => ({ href, labelKey, icon }))
    : isInvoicerRole(role)
      ? [
          // The invoicing-only role opens only the invoicing pages.
          { href: '/invoices', labelKey: 'invoices', icon: DocumentTextIcon },
          { href: '/customers', labelKey: 'customers', icon: UsersIcon },
        ]
      : [
        // The phone bar names the page the way the sidebar does: Att göra.
        { href: '/', labelKey: 'v2_todo' as NavLabelKey, icon: HomeIcon },
        { href: '/chat', labelKey: 'assistant', icon: SparklesIcon },
        { href: '/transactions', labelKey: 'transactions', icon: ArrowsRightLeftIcon },
      ]

  const renderBadge = (item: { comingSoon?: boolean; devBadge?: boolean; betaBadge?: boolean; newBadge?: boolean }) => {
    const baseClass =
      'rounded-full bg-muted/60 text-muted-foreground/70 text-[11px] font-medium uppercase tracking-wider px-1.5 py-0.5'
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
        // The group is headed by the company it acts on, so a byrå moving
        // between clients sees which books it is in (crm#1279).
        groupLabel={cockpitMode ? '' : company?.name || tNav('v2_group_company')}
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
                  <ArrowLeftIcon className="mr-2.5 h-[15px] w-[15px] flex-shrink-0" />
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
                  <ArrowLeftIcon className="mr-2.5 h-[15px] w-[15px] flex-shrink-0" />
                  <span className="flex-1">{tNav('back_to_clients')}</span>
                </NavLink>
              )}
              <div className="mx-3 mt-2 border-t border-border" />
            </div>
          ) : null
        }
        userBlock={
          <div className="flex-shrink-0">
            <SubscriptionTouchpoint variant="sidebar" />
            <div className="mx-3 border-t border-border" />
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
      <nav data-mobile-nav="" data-ph-unmask className="md:hidden fixed bottom-0 left-0 right-0 z-50 h-[var(--bottom-nav-h)] bg-card/98 backdrop-blur-sm border-t border-border" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label={tNav('mobile_navigation')}>
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
                    <span data-ph-mask className="absolute -top-1.5 -right-2.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[11px] font-semibold px-0.5">
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
                    'transition-colors duration-150',
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
            className="flex flex-col items-center justify-center flex-1 h-full text-xs text-muted-foreground transition-colors duration-150"
          >
            <Bars3Icon className="h-5 w-5 mb-1" />
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
              isClosing ? "animate-out fade-out duration-150" : "animate-in fade-in duration-300"
            )}
            onClick={closeMobileMenu}
            aria-hidden="true"
          />
          {/* Bottom sheet */}
          <div
            className={cn(
              "md:hidden fixed inset-x-0 bottom-0 z-50 bg-card rounded-t-xl border-t border-border overflow-y-auto overscroll-contain",
              isClosing
                ? "animate-out slide-out-to-bottom duration-150"
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
                size="icon-sm"
                className="-mr-1"
                onClick={closeMobileMenu}
                aria-label={tNav('close_menu')}
              >
                <XMarkIcon className="h-4 w-4" />
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
                      <ArrowLeftIcon className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
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
                      <ArrowLeftIcon className="h-[18px] w-[18px] flex-shrink-0 text-muted-foreground" />
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
                        <span data-ph-mask className="min-w-[20px] h-[20px] flex items-center justify-center rounded-full bg-primary/15 text-primary text-[11px] font-semibold px-1.5">
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
                    <span className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav(groupLabelKey[key])}</span>
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
                            <span data-ph-mask className="min-w-[20px] h-[20px] flex items-center justify-center rounded-full bg-primary/15 text-primary text-[11px] font-semibold px-1.5">
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
                    <span className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav('group_extensions')}</span>
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
                <span className="text-[11px] font-semibold text-muted-foreground/60 uppercase tracking-[0.08em]">{tNav('mitt_konto')}</span>
                <div className="flex-1 h-px bg-border/30" />
              </div>

              <div className="space-y-0.5">
                {/* Subscription touchpoint: mobile had no trial surface at
                    all before this row (trial countdown or lapsed upgrade
                    link; hides itself for sandbox and paying companies). */}
                <SubscriptionTouchpoint variant="mobile" onNavigate={closeMobileMenu} />
                {([
                  // Cockpit: settings open in byrå scope (account-level
                  // sections only) and say so, same as the desktop user menu.
                  {
                    href: cockpitMode ? '/settings/account?ctx=byra' : '/settings',
                    labelKey: (cockpitMode ? 'account_settings' : 'settings') as NavLabelKey,
                    icon: Cog6ToothIcon,
                  },
                  { href: '/help', labelKey: 'help' as NavLabelKey, icon: QuestionMarkCircleIcon },
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
                size="lg"
                className="w-full justify-start text-muted-foreground active:text-foreground text-sm px-3"
                onClick={() => {
                  closeMobileMenu()
                  handleLogout()
                }}
              >
                <ArrowRightStartOnRectangleIcon className="mr-3 h-[18px] w-[18px]" />
                {isSandbox ? tNav('logout_sandbox') : tCommon('logout')}
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  )
}
