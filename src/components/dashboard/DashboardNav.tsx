'use client'

import { useEffect, useState, useRef, type ComponentProps, type ComponentType, type ReactNode } from 'react'
import { NavLink } from './NavLink'
import { isCurrentPageHref } from './nav-prefetch'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ArrowLeftIcon,
  ArrowRightStartOnRectangleIcon,
  Bars3Icon,
  ChevronDownIcon,
  Cog6ToothIcon,
  DocumentTextIcon,
  QuestionMarkCircleIcon,
  UsersIcon,
  XMarkIcon,
  type Icon,
} from '@/components/icons'
import { getBranding } from '@/lib/branding/service'
import { useBranding } from '@/lib/branding/brand-context'
import { BrandHomeLink } from '@/components/branding/BrandHomeLink'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { resolveIcon } from '@/lib/extensions/icon-resolver'
import { SupportLink } from '@/components/ui/support-link'
import CompanySwitcher, { CompanyTile } from '@/components/dashboard/CompanySwitcher'
import UserMenu from '@/components/dashboard/UserMenu'
import SubscriptionTouchpoint from '@/components/billing/SubscriptionTouchpoint'
import DiscordInviteCard from '@/components/community/DiscordInviteCard'
import AgentAvatar from '@/components/agent/AgentAvatar'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { useCompany } from '@/contexts/CompanyContext'
import { useWorklistBadges } from '@/lib/hooks/use-worklist-badges'
import { SidebarFiscalYear } from './SidebarFiscalYear'
import { passesNavGates, type NavGateContext, type ShellNavGate } from '@/lib/navigation/nav-gates'
import { resolveFavorites } from '@/lib/navigation/favorites'
import { isInvoicerPagePath, isInvoicerRole } from '@/lib/auth/invoicer-role'
import { signOutAndNavigate } from '@/lib/auth/session-client'
import { SettingsRail } from '@/components/settings/SettingsRail'
import NewClientCompanyDialog from './NewClientCompanyDialog'
import { AreaSidebar, type AreaRow, type AreaRowGroup } from './AreaSidebar'
import { ShellRail, type RailCreate, type RailEntry } from './ShellRail'
import { useNeedCount } from './need-count'
import { useInboxUpload } from '@/components/inkorg/UploadButton'
import { NAV_ROW_ICON_CLASS } from './nav-row-class'
import type { NavGateFlags } from './nav-v2'
import { NAV_V3_AREAS, areaCreate, areaCreatePage, areaItems, createOpenForRole, gateAreas, hrefPath, resolveNavPlace, type NavAreaId, type NavV3Area, type NavV3Item } from './nav-v3'
import { useNavRowClaim } from './nav-row-claim'
import { useNavFavorites } from './use-nav-favorites'
import { openCommandPalette } from '@/components/common/open-command-palette'

/** The phone bar's areas beside "Mer" (the prototype's phone shell). */
const PHONE_BAR_AREAS: readonly NavAreaId[] = ['todo', 'money', 'sales']

interface ExtensionNavItem {
  href: string
  label: string
  icon: string
}

interface DashboardNavProps {
  /**
   * What the layout resolves for the menu's gates (lib/navigation/nav-gates.ts):
   * the legal form, the resolved capabilities and the company's switches and
   * rollouts. The command palette is handed the same object. A shell with no
   * company open names only the form and the surface.
   */
  navGate: Pick<ShellNavGate, 'entityType' | 'surface'> & Partial<ShellNavGate>
  isSandbox?: boolean
  extensionNavItems?: ExtensionNavItem[]
  // Signed-in user's full name + email: drives the bottom-left account
  // popover trigger so the user can see WHO they're logged in as,
  // distinct from the active COMPANY shown by CompanySwitcher up top.
  userName?: string | null
  userEmail?: string | null
  /** One-time Discord invite above the user menu; the layout decides who
   *  gets it (lib/community/discord-invite.ts). */
  showDiscordInvite?: boolean
  /**
   * The person's favourite menu rows as stored (ui_state.nav_favorites), read
   * by the layout so the Favoriter group is there on first paint. Per person,
   * not per company: the sidebar draws the ones the menu shows right now.
   */
  navFavorites?: readonly string[]
  /**
   * The page panel's content (the layout's <main>). The shell draws the rail
   * on the frame and the area sidebar and the page inside one panel, so the
   * page is the shell's child rather than its sibling.
   */
  children?: ReactNode
}

/** The switches of a shell with no company open: all off but offerter, which is on unless a company switches it off. */
const NAV_GATE_DEFAULTS = {
  dimensionsEnabled: false, salesOrdersEnabled: false, quotesEnabled: true, hasWebshop: false, hasMileage: false, hasExpenseClaims: false,
  hasPosSales: false, arkivEnabled: false, agentsEnabled: false, inkorgV2Enabled: false, autogiroEnabled: false,
}

/**
 * The page panel (frame layout): one rounded panel on the frame holding the
 * area sidebar and the page, 10px from the frame's edges, the rail to its
 * left. The docked assistant claims --agent-dock-w on its right. On a phone
 * the panel dissolves: the page is plain document flow over the bottom nav.
 */
const SHELL_PANEL_CLASS =
  'md:flex md:min-h-0 md:min-w-0 md:flex-1 md:my-[10px] md:mr-[var(--agent-dock-w)] md:overflow-hidden md:rounded-xl md:bg-background md:shadow-panel ' +
  'md:transition-[margin-right] md:duration-300 md:ease-drawer'

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

/** A phone nav target: a link while it can be opened, else the same row inert. */
function PhoneNavRow({ enabled, className, children, ...link }: ComponentProps<typeof NavLink> & { enabled: boolean }) {
  return enabled ? (
    <NavLink className={className} {...link}>
      {children}
    </NavLink>
  ) : (
    <div className={className} aria-disabled="true">
      {children}
    </div>
  )
}

/** The look of a row in the phone's "Mer" sheet. */
const sheetRowClass = (enabled: boolean, active: boolean) =>
  cn(
    'flex items-center gap-3 px-3 min-h-[44px] rounded-lg',
    enabled
      ? cn('transition-colors duration-150', active ? 'bg-secondary text-strong font-medium' : 'text-foreground active:bg-muted/60')
      : 'text-muted-foreground',
  )

export default function DashboardNav({ navGate, isSandbox = false, extensionNavItems = [], userName = null, userEmail = null, showDiscordInvite = false, navFavorites, children }: DashboardNavProps) {
  const pathname = usePathname()
  const navRowClaim = useNavRowClaim(pathname)
  const favorites = useNavFavorites(navFavorites)
  const { company, capabilities, byraTeam, role } = useCompany()
  // Agent identity drives the "Assistent" nav icon: when the user has
  // built their assistant we show its chosen avatar instead of the
  // generic sparkles glyph.
  const { identity: agentIdentity } = useAgentSheet()
  const { brand } = useBranding()
  const tNav = useTranslations('nav')
  const tSettings = useTranslations('settings_nav')
  const tCommon = useTranslations('common')
  const tSwitcher = useTranslations('company_switcher')
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [isClosing, setIsClosing] = useState(false)
  // The area whose rows are folded open in the phone's "Mer" sheet.
  const [openPhoneArea, setOpenPhoneArea] = useState<NavAreaId | null>(null)
  const [clientDialogOpen, setClientDialogOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Badge counts load client-side after mount (and refresh as described in
  // lib/hooks/use-worklist-badges). They used to arrive as server props, which
  // put two head-count queries on the critical path of every dashboard
  // navigation for numbers nobody needs before first paint.
  const {
    pendingOperations: pendingOpsCount,
    inbox: inboxCount,
    nudge: nudgeBadges,
    // The invoicing-only role has none of the counted rows and its session
    // may not call the counts route (lib/auth/invoicer-role.ts): it never polls.
  } = useWorklistBadges(isInvoicerRole(role) ? null : company?.id)
  const hasCompany = !!company
  // Behöver dig's count: the number Hem's "Visa alla N som lista" shows,
  // published by the page that builds the rows (need-count.ts).
  const needCount = useNeedCount(company?.id)
  const router = useRouter()
  // "Ladda upp underlag": files land in the inbox; the page showing re-reads so its counts follow.
  const inboxUpload = useInboxUpload(async () => router.refresh())
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
  const searchParams = useSearchParams()
  const ctxByra = searchParams.get('ctx') === 'byra'
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

  const openMobileMenu = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
    setIsClosing(false)
    // The sheet opens on the area the user is in.
    setOpenPhoneArea(shownArea?.id ?? null)
    setIsMobileMenuOpen(true)
  }

  // The server revokes the session and deletes the HttpOnly cookie; the
  // helper then clears what the browser held (token, storage including an
  // unsent support draft, analytics identity, stray legacy auth cookies)
  // and leaves with a full page load.
  const handleLogout = () => void signOutAndNavigate(isSandbox ? '/sandbox' : '/login')

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
  // the area sidebar and in the phone menu, which are drawn from one tree
  // (nav-v3.ts). The gate itself lives in lib/navigation/nav-gates.ts so the
  // assistant's UI map applies the same one. Rutin (/pending) stays in the
  // menu at all times: the count shows when proposals wait, the link always.
  const gateContext: NavGateContext = {
    ...NAV_GATE_DEFAULTS,
    ...navGate,
    mcpExtensionEnabled: ENABLED_EXTENSION_IDS.has('mcp-server'),
    capabilities,
    hiddenNavHrefs,
    role,
  }
  const passesGates = (item: NavGateFlags) => passesNavGates(item, gateContext)

  // Extension workspaces are company surfaces: none in cockpit mode.
  const visibleExtensionNavItems = cockpitMode ? [] : extensionNavItems

  // The shell's areas (nav-v3.ts), gated row by row. An area with no row
  // left hides from the rail. Inställningar always shows (its rows are the
  // settings sections); Byrå shows to byrå team members only. In the cockpit
  // the shell is lean, as before: the cockpit is above the companies, so
  // only Byrå and Inställningar are offered until a client is entered.
  const gatedAreas = gateAreas(NAV_V3_AREAS, passesGates)
  const visibleAreas = gatedAreas.filter((area) =>
    area.id === 'settings'
      ? true
      : area.id === 'byra'
        ? !!byraTeam
        : !cockpitMode && areaItems(area).length > 0,
  )

  // Where the URL belongs (longest matching row; a row the page claims wins).
  // Settings in byrå scope stay Inställningar whatever the section, because
  // the cockpit has no Agenter area for /settings/api to belong to.
  const place = resolveNavPlace(pathname, searchParams, navRowClaim)
  const activeAreaId: NavAreaId | null = cockpitMode
    ? onSettings
      ? 'settings'
      : 'byra'
    : onSettings && ctxByra && byraTeam
      ? 'settings'
      : (place?.area ?? null)
  const activeRowHref = place && place.area === activeAreaId ? place.href : null
  // The area whose sidebar shows. A page outside every visible area (a
  // route no area owns, or an area gated away) keeps the first area's menu
  // in reach without lighting anything.
  const shownArea: NavV3Area | undefined =
    visibleAreas.find((area) => area.id === activeAreaId) ??
    visibleAreas.find((area) => (cockpitMode ? area.id === 'byra' : area.id !== 'settings' && area.id !== 'byra')) ??
    visibleAreas[0]
  const isActive = (href: string) => href === activeRowHref

  // The invoicing-only role opens one settings page, its own account.
  const settingsHref = cockpitMode ? '/settings/account?ctx=byra' : isInvoicerRole(role) ? '/settings/account' : '/settings'
  /** Where an area's rail button lands: its first row that can be opened. */
  const areaLanding = (area: NavV3Area): string | null => {
    if (area.id === 'settings') return settingsHref
    if (area.id === 'byra' && !cockpitMode) return cockpitHref
    return areaItems(area).find((item) => isItemEnabled(item.href))?.href ?? null
  }

  const byraArea = visibleAreas.find((area) => area.id === 'byra')
  const mobileNavItems: { href: string; label: string; icon: Icon; active: boolean }[] = cockpitMode
    ? (byraArea ? areaItems(byraArea) : []).map((item) => ({
        href: item.href,
        label: tNav(item.labelKey as never),
        icon: item.icon,
        active: isActive(item.href),
      }))
    : isInvoicerRole(role)
      ? [
          // The invoicing-only role opens only the invoicing pages.
          { href: '/invoices', label: tNav('v3_invoices'), icon: DocumentTextIcon, active: isActive('/invoices') },
          { href: '/customers', label: tNav('customers'), icon: UsersIcon, active: isActive('/customers') },
        ]
      : PHONE_BAR_AREAS.flatMap((id) => {
          // The phone bar follows the areas: Att göra, Pengar, Försäljning,
          // each landing on its first row; every other area is under "Mer".
          const area = visibleAreas.find((a) => a.id === id)
          const href = area ? areaLanding(area) : null
          return area && href
            ? [{ href, label: tNav(area.labelKey as never), icon: area.icon, active: activeAreaId === id }]
            : []
        })

  const rowTag = (item: { betaBadge?: boolean; newBadge?: boolean }): string | undefined =>
    item.betaBadge ? tNav('badge_beta') : item.newBadge ? tNav('badge_new') : undefined

  // Design convention 18: counts sit only where waiting work is the page's
  // point: Hem (the things it lists), Rutin (the agent's proposals) and
  // Inkommande (the inbox). Every other page shows its own.
  const badgeFor = (href: string): number | null =>
    cockpitMode
      ? null
      : href === '/' && needCount !== null && needCount > 0
        ? needCount
        : href === '/pending' && pendingOpsCount > 0
          ? pendingOpsCount
          : href === '/inkorg' && inboxCount > 0
            ? inboxCount
            : null

  const toRow = (item: NavV3Item): AreaRow => ({
    href: item.href,
    label: tNav(item.labelKey as never),
    icon: renderNavIcon(item, cn(NAV_ROW_ICON_CLASS, isActive(item.href) && 'text-strong')),
    active: isActive(item.href),
    enabled: isItemEnabled(item.href) && !item.comingSoon,
    count: badgeFor(item.href),
    tag: rowTag(item),
  })
  const rowGroups: AreaRowGroup[] = (shownArea?.groups ?? []).map((group, index) => ({
    key: `${shownArea?.id}-${index}`,
    label: group.labelKey ? tNav(group.labelKey as never) : undefined,
    rows: group.items.map(toRow),
  }))

  // Favoriter (lib/navigation/favorites.ts): the stored hrefs that are rows
  // of the menu right now, each drawn as its own menu row. The menu's rows
  // are the gated rows of the areas whose sidebar can show here: Byrå's rows
  // are listed only in the cockpit, and the settings sections are not rows
  // of the tree. A favourite outside them is not drawn and stays stored, and
  // so is one whose row cannot be opened here (a shell with no company, a
  // page that is still coming): the group holds shortcuts, never dead rows.
  const menuRows = visibleAreas.filter((area) => area.id !== 'byra' || cockpitMode).flatMap(areaItems)
  const favoriteRows = resolveFavorites(favorites.stored, menuRows)
    .map(toRow)
    .filter((row) => row.enabled)
  const favoriteHrefs = new Set(favorites.stored)

  // Byrå owner/admin add a client through the "Nytt klientbolag" confirm,
  // the same dialog the user menu opens (NewClientCompanyDialog).
  const canCreateClient = !isSandbox && (byraTeam?.role === 'owner' || byraTeam?.role === 'admin')
  /** An area's create action as the shell offers it; undefined when it cannot be used here. */
  const createFor = (area: NavV3Area | undefined): (RailCreate & { onClick?: () => void }) | undefined => {
    const create = area && areaCreate(area)
    if (!create || !createOpenForRole(create, role)) return undefined
    // A create page under a page the brand hides (/invoices/new under /invoices) goes with it.
    const createPath = hrefPath(create.href)
    if ([...hiddenNavHrefs].some((hidden) => createPath.startsWith(`${hidden}/`))) return undefined
    const base = { key: create.href, label: tNav(create.labelKey as never), symbol: create.symbol }
    if (create.action === 'new-client') return canCreateClient ? { ...base, onClick: () => setClientDialogOpen(true) } : undefined
    if (create.action === 'upload-inbox') {
      // The inbox's own upload, opened from this click; the label counts the files while they go up.
      return hasCompany ? { ...base, key: 'upload-inbox', label: inboxUpload.label ?? base.label, onClick: inboxUpload.pick } : undefined
    }
    return isItemEnabled(create.href) ? { ...base, href: create.href } : undefined
  }
  const shownCreate = createFor(shownArea)
  // The rail's plus: every area's create action, one line per target.
  const railCreates: RailCreate[] = []
  for (const area of visibleAreas) {
    const create = createFor(area)
    if (!create || railCreates.some((c) => c.key === create.key)) continue
    railCreates.push({ ...create, icon: area.icon, onSelect: create.onClick })
  }

  // The area's settings pages, behind its one Inställningar row. Company settings need a
  // company, and the invoicing-only role opens only its own pages.
  const areaSettingsLinks = (shownArea?.settings ?? [])
    .filter((link) => shownArea?.id === 'byra' || (hasCompany && !(isInvoicerRole(role) && !isInvoicerPagePath(hrefPath(link.href)))))
    .map((link) => ({ href: link.href, label: tSettings(link.labelKey as never) }))

  const railEntry = (area: NavV3Area): RailEntry => {
    const AreaIcon = area.icon
    // Outside the cockpit the Byrå button is the way back to the clients.
    const backToClients = area.id === 'byra' && !cockpitMode
    return {
      id: area.id,
      // The area's name, shown under the icon. One source: the sidebar's heading reads the same key.
      label: tNav(area.labelKey as never),
      icon: <AreaIcon className="h-5 w-5" />,
      href: areaLanding(area),
      active: area.id === activeAreaId,
      // The name says "Byrå"; the tooltip says where the button leads.
      tip: backToClients ? tNav('back_to_clients') : null,
      hint: backToClients && cockpitExternal ? cockpitHint : null,
    }
  }
  const railGroups = ([0, 1, 2, 3] as const).map((group) => visibleAreas.filter((area) => area.rail === group).map(railEntry))
  // In the cockpit Byrå is the one area, so it leads the rail; inside a
  // company it sits at the foot with Agenter and Inställningar.
  if (cockpitMode && byraArea) railGroups[0] = [railEntry(byraArea)]
  const railFoot = visibleAreas.filter((area) => area.rail === 'foot' && !(cockpitMode && area.id === 'byra')).map(railEntry)

  return (
    <>
      {/* Desktop shell: the icon rail on the frame, and one panel holding the
          active area's sidebar and the page. Under md the rail and the
          sidebar are hidden and the mobile nav below takes over. */}
      <div className="md:flex md:min-h-0 md:flex-1">
        <ShellRail
          ariaLabel={tNav('main_navigation')}
          creates={railCreates}
          createLabel={tNav('v3_create')}
          searchLabel={tNav('v3_search')}
          onSearch={openCommandPalette}
          groups={railGroups}
          foot={railFoot}
          disabledTitle={tNav('needs_company_tooltip')}
        />
        <div data-shell-panel="" className={SHELL_PANEL_CLASS}>
          <AreaSidebar
            // A byrå's own logo (usually a wide wordmark) heads the sidebar.
            // The default mark has no place in the shell: the browser tab
            // and the sign-in page carry the brand.
            brand={brand ? <BrandHomeLink showLabel /> : undefined}
            areaLabel={shownArea ? tNav(shownArea.labelKey as never) : ''}
            // The sidebar is headed by the company it acts on, so a byrå moving
            // between clients sees which books it is in (crm#1279). The cockpit
            // is above the companies: it names the byrå, and a client is
            // entered through Klienter.
            companyRow={
              cockpitMode ? (
                <div className="flex h-7.5 items-center gap-2 px-2">
                  <CompanyTile name={byraTeam?.name ?? ''} />
                  <span data-ph-mask className="min-w-0 flex-1 truncate text-[13px] font-medium text-strong">
                    {byraTeam?.name ?? ''}
                  </span>
                </div>
              ) : (
                <CompanySwitcher variant="row" trailing={company ? <SidebarFiscalYear /> : undefined} />
              )
            }
            create={shownCreate}
            groups={rowGroups}
            favorites={{
              label: tNav('v3_favorites'),
              rows: favoriteRows,
              hrefs: favoriteHrefs,
              addLabel: tNav('v3_favorite_add'),
              removeLabel: tNav('v3_favorite_remove'),
              onToggle: favorites.toggle,
            }}
            settingsLabel={tNav('settings')}
            settingsLinks={areaSettingsLinks}
            disabledTitle={tNav('needs_company_tooltip')}
            userBlock={
              <div className="flex-shrink-0">
                {showDiscordInvite && <DiscordInviteCard />}
                <SubscriptionTouchpoint variant="sidebar" />
                <div className="border-t-hairline px-2.5 py-1.5">
                  <UserMenu
                    userName={userName}
                    userEmail={userEmail}
                    isSandbox={isSandbox}
                    cockpitMode={cockpitMode}
                    onLogout={handleLogout}
                  />
                </div>
              </div>
            }
          >
            {shownArea?.id === 'settings' ? <SettingsRail display="rail" /> : undefined}
          </AreaSidebar>
          {children}
        </div>
      </div>
      {inboxUpload.input}
      {canCreateClient && <NewClientCompanyDialog open={clientDialogOpen} onOpenChange={setClientDialogOpen} />}

      {/* Mobile bottom navigation. data-mobile-nav is the brand-style hook:
          on branded hosts the brand style block re-tints the bar's tokens
          (--card/--border/--primary...) to the deep chrome, mirroring the
          sidebar; on default hosts the attribute matches nothing.
          Height is --bottom-nav-h (globals.css): the tab row plus the safe
          area inset, the same token every bottom-pinned bar offsets by, so
          the nav and the bars cannot drift apart (#2738). */}
      <nav data-mobile-nav="" data-ph-unmask className="md:hidden fixed bottom-0 left-0 right-0 z-50 h-[var(--bottom-nav-h)] border-t-hairline bg-[var(--material)] backdrop-blur-xl backdrop-saturate-[1.8] reduced-transparency:bg-background reduced-transparency:backdrop-blur-none" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }} aria-label={tNav('mobile_navigation')}>
        <div className="flex items-center justify-around h-full px-2">
          {mobileNavItems.map((item) => {
            const enabled = isItemEnabled(item.href)
            return (
              <PhoneNavRow
                key={item.href}
                enabled={enabled}
                href={item.href}
                aria-current={item.active ? 'page' : undefined}
                onClick={(e) => {
                  // A tap on the tab of the page already showing, scrolled
                  // down: back to the top (the phone tab-bar convention)
                  // instead of a refresh that changes nothing visible. At the
                  // top, NavLink refreshes and the tab dims while it runs.
                  if (window.scrollY < 8) return
                  if (!isCurrentPageHref(item.href, window.location.pathname, window.location.search)) return
                  e.preventDefault()
                  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
                  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
                }}
                className={cn(
                  'relative flex flex-col items-center justify-center flex-1 min-w-0 h-full text-xs',
                  enabled
                    ? cn('transition-[color,opacity] duration-150 data-[refreshing]:opacity-50', item.active ? 'text-strong' : 'text-muted-foreground')
                    : 'text-muted-foreground',
                )}
              >
                {renderNavIcon(item, cn('h-5 w-5 mb-1', item.active && 'text-strong'))}
                <span className={cn('truncate', item.active && 'font-medium')}>{item.label}</span>
              </PhoneNavRow>
            )
          })}
          {/* Menu button */}
          <button
            onClick={openMobileMenu}
            aria-label={tNav('open_menu')}
            className="flex flex-col items-center justify-center flex-1 h-full text-xs text-muted-foreground transition-colors duration-150"
          >
            <Bars3Icon className="h-5 w-5 mb-1" />
            <span>{tNav('v3_more')}</span>
          </button>
        </div>
      </nav>

      {/* Mobile menu: bottom sheet */}
      {isMobileMenuOpen && (
        <>
          {/* Backdrop */}
          <div
            className={cn(
              "md:hidden fixed inset-0 bg-veil z-50",
              isClosing ? "animate-out fade-out duration-150" : "animate-in fade-in duration-300"
            )}
            onClick={closeMobileMenu}
            aria-hidden="true"
          />
          {/* Bottom sheet */}
          <div
            className={cn(
              "md:hidden fixed inset-x-0 bottom-0 z-50 bg-popover rounded-t-xl shadow-float overflow-y-auto overscroll-contain",
              isClosing
                ? "animate-out slide-out-to-bottom duration-150"
                : "animate-in slide-in-from-bottom duration-300"
            )}
            style={{ maxHeight: '85dvh', paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
            role="dialog"
            aria-label={tNav('navigation_menu')}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1 sticky top-0 bg-popover rounded-t-xl">
              <div className="w-8 h-1 rounded-full bg-muted-foreground/25" />
            </div>

            {/* Header */}
            <div className="px-4 pb-2 flex items-center justify-between">
              <div className="flex-1 min-w-0 mr-2">
                <CompanySwitcher />
              </div>
              {/* The fiscal year is app-wide and its picker heads the sidebar;
                  a phone has no sidebar, so the sheet carries it. */}
              {company && (
                <div className="mr-1 flex-shrink-0">
                  <SidebarFiscalYear placement="sheet" />
                </div>
              )}
              <Button
                variant="ghost"
                size="icon"
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
                        <span className="block truncate text-xs text-muted-foreground">
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
              {/* Every area and its menu ("Mer" lists them all): an area
                  folds open to its rows, the one the user is in first. */}
              <div className="space-y-0.5">
                {visibleAreas
                  .filter((area) => area.id !== 'settings' && (area.id !== 'byra' || cockpitMode))
                  .map((area) => {
                    const AreaIcon = area.icon
                    const open = openPhoneArea === area.id
                    const current = area.id === activeAreaId
                    const panelId = `phone-area-${area.id}`
                    const createPage = areaCreatePage(area)
                    return (
                      <div key={area.id}>
                        <button
                          type="button"
                          aria-expanded={open}
                          aria-controls={panelId}
                          onClick={() => setOpenPhoneArea(open ? null : area.id)}
                          className={cn(
                            'flex w-full items-center gap-3 rounded-lg px-3 min-h-[44px] text-left text-sm transition-colors duration-150 active:bg-muted/60',
                            current ? 'font-medium text-strong' : 'text-foreground',
                          )}
                        >
                          <AreaIcon className={cn('h-[18px] w-[18px] flex-shrink-0', current ? 'text-strong' : 'text-muted-foreground')} />
                          <span className="flex-1">{tNav(area.labelKey as never)}</span>
                          <ChevronDownIcon
                            className={cn('h-4 w-4 text-muted-foreground transition-transform duration-150', open && 'rotate-180')}
                          />
                        </button>
                        {open && (
                          <div id={panelId} className="mb-1 ml-[21px] space-y-0.5 border-l-hairline pl-2.5">
                            {/* The phone has no create button: the page an area's create opens (Koppla en agent) is listed last. */}
                            {[...areaItems(area), ...(createPage ? [createPage] : [])].map((item) => {
                              const active = isActive(item.href) || (item === createPage && current && pathname === hrefPath(item.href))
                              const enabled = isItemEnabled(item.href) && !item.comingSoon
                              const badge = badgeFor(item.href)
                              const tag = rowTag(item)
                              return (
                                <PhoneNavRow
                                  key={item.href}
                                  enabled={enabled}
                                  href={item.href}
                                  onClick={closeMobileMenu}
                                  aria-current={active ? 'page' : undefined}
                                  className={sheetRowClass(enabled, active)}
                                >
                                  <span className="text-sm flex-1">{tNav(item.labelKey as never)}</span>
                                  {tag ? (
                                    <span className="rounded-md bg-muted/60 px-1.5 py-0.5 text-xs font-medium text-muted-foreground">{tag}</span>
                                  ) : (
                                    badge !== null && (
                                      <span data-ph-mask className="text-[12px] tabular-nums text-muted-foreground">
                                        {badge > 99 ? '99+' : badge}
                                      </span>
                                    )
                                  )}
                                </PhoneNavRow>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
              </div>

              {/* Tillägg (extensions): only when there's at least one */}
              {visibleExtensionNavItems.length > 0 && (
                <>
                  <div className="flex items-center gap-3 my-1.5 px-3">
                    <span className="text-xs font-semibold text-muted-foreground">{tNav('group_extensions')}</span>
                    <div className="flex-1 h-px bg-border/30" />
                  </div>
                  <div className="space-y-0.5">
                    {visibleExtensionNavItems.map((item) => {
                      const Icon = resolveIcon(item.icon)
                      const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
                      const labelTranslationKey = extensionLabelKey(item.href)
                      return (
                        <PhoneNavRow key={item.href} enabled={hasCompany} href={item.href} onClick={closeMobileMenu} className={sheetRowClass(hasCompany, active)}>
                          <Icon className={cn("h-[18px] w-[18px] flex-shrink-0", active ? "text-strong" : "text-muted-foreground")} />
                          <span className="text-sm">{labelTranslationKey ? tNav(labelTranslationKey) : item.label}</span>
                        </PhoneNavRow>
                      )
                    })}
                  </div>
                </>
              )}

              {/* Mitt konto divider */}
              <div className="flex items-center gap-3 my-1.5 px-3">
                <span className="text-xs font-semibold text-muted-foreground">{tNav('mitt_konto')}</span>
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
                    href: settingsHref,
                    labelKey: cockpitMode ? ('account_settings' as const) : ('settings' as const),
                    icon: Cog6ToothIcon,
                  },
                  { href: '/help', labelKey: 'help' as const, icon: QuestionMarkCircleIcon },
                ]).map((item) => {
                  const active = pathname.startsWith(hrefPath(item.href))
                  const enabled = isItemEnabled(item.href)
                  return (
                    <PhoneNavRow key={item.href} enabled={enabled} href={item.href} onClick={closeMobileMenu} className={sheetRowClass(enabled, active)}>
                      {renderNavIcon(item, cn('h-[18px] w-[18px] flex-shrink-0', active ? 'text-strong' : 'text-muted-foreground'))}
                      <span className="text-sm">{tNav(item.labelKey)}</span>
                    </PhoneNavRow>
                  )
                })}
              </div>
            </div>

            {/* Support + Logout */}
            <div className="px-2 py-2 mt-1 border-t-hairline space-y-1">
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
