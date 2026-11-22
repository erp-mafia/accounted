import { Suspense } from 'react'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { cookies, headers } from 'next/headers'
import DashboardNav from '@/components/dashboard/DashboardNav'
import DashboardLoading from './loading'
import { navRollouts } from '@/lib/navigation/nav-rollouts'
import { DashboardRouteShell } from '@/components/dashboard/DashboardRouteShell'
import { MainContainer } from '@/components/dashboard/MainContainer'
import CompanyTabSync from '@/components/dashboard/CompanyTabSync'
import AnalyticsIdentify from '@/components/AnalyticsIdentify'
import { computeIdentityHash } from '@/lib/analytics/identity-hash'
import { AgentSheetProvider } from '@/components/agent/AgentSheetProvider'
import AgentTrigger from '@/components/agent/AgentTrigger'
import { SupportDock } from '@/components/support/SupportDock'
import LazyCommandPalette from '@/components/common/LazyCommandPalette'
import { SupportDialogHost } from '@/components/support/SupportDialogHost'
import { SettingsHotkey } from '@/components/settings/SettingsHotkey'
import { SessionTimeoutController } from '@/components/auth/SessionTimeoutController'
import { BrowserSessionGuard } from '@/components/auth/BrowserSessionGuard'
import { SandboxBanner } from '@/components/dashboard/SandboxBanner'
import { SystemNoticeBanner } from '@/components/dashboard/SystemNoticeBanner'
import { parseSystemNoticeUntil } from '@/components/dashboard/system-notice'
import TrialExpiredDialog from '@/components/billing/TrialExpiredDialog'
import { shouldOfferDiscordInvite } from '@/lib/community/discord-invite'
import { flagEnabled } from '@/lib/env/public-flags'
import { resolveDormantCompanyIds } from '@/lib/company/active-company'
import { getExtensionNavItems } from '@/lib/extensions/sectors'
import { CompanyProvider, type ByraTeamRef } from '@/contexts/CompanyContext'
import { ReferenceDataSeed } from '@/components/providers/ReferenceDataSeed'
import { FiscalScopeProvider } from '@/components/providers/FiscalScopeProvider'
import { AllMessagesProvider } from '@/components/providers/AllMessagesProvider'
import OnboardingBackdrop from '@/components/onboarding/OnboardingBackdrop'
import { getCompanyEntitlements } from '@/lib/entitlements/has-capability'
import {
  capabilityInputsFromEntitlements,
  capabilitySurface,
  capabilitySurfaceWithoutCompany,
  readStoredProfile,
  resolveCapabilities,
  switchedOffPackageIds,
} from '@/lib/modules/capabilities'
import { getAiStatus } from '@/lib/ai'
import { assistantChatEnabled, assistantChatEnabledFor, assistantChatUntil } from '@/lib/env/assistant-chat-switch'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getDashboardNavFlags } from '@/lib/dashboard/nav-flags'
import { getBranding } from '@/lib/branding/service'
import { resolveRequestBrand } from '@/lib/branding/request-brand'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { resolveBrandDomainBounce } from '@/lib/auth/brand-signup-gate'
import { INVITE_COOKIE_NAME } from '@/lib/auth/consume-invite-cookie'
import { resolveBrandsForTeams } from '@/lib/branding/team-brands'
import { isNoCompanyDashboardPath } from '@/lib/company/no-company-routes'
import { fetchCompanySettingsNames } from '@/lib/company/settings-names'
import { mayHaveBankIdEngagements } from '@/lib/company-lookup/engagements'
import { addCompanyHref } from '@/components/settings/company-deletion'
import {
  partitionCompaniesByHomeDomain,
  isCompanyHomedOnHost,
  resolveCockpitHref,
} from '@/lib/company/home-domain'
import HomeDomainSignpost from '@/components/dashboard/HomeDomainSignpost'
import { LegalAcceptanceGate } from '@/components/legal/LegalAcceptanceGate'
import { readAcceptanceState } from '@/lib/legal/acceptance'
import type { AccountingFramework, EntityType, CompanyRole, Team } from '@/types'
import { parseEntityType } from '@/lib/company/entity-type'
import { invoicerPageRedirect, isInvoicerRole } from '@/lib/auth/invoicer-role'
import { isSupportAssistantEnabled } from '@/lib/agent/support/rollout'
import { createCompanyScopedClient } from '@/lib/auth/company-scoped-client'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardCompanyMemberships,
  getDashboardFiscalPeriods,
  getDashboardSettings,
  getDashboardTeamMemberships,
  getDashboardUserProfile,
  getResolvedDashboardAgentProfile,
  getDashboardOpenObligations,
} from './request-context'

// The segment's loading fallback (./loading.tsx) is a sibling of the pages,
// so the top bar it draws was bundled for it and again for each page. Naming
// it here puts it in this layout's chunk group, which the pages reuse
// (scripts/perf/README.md, "Page budgets").
void DashboardLoading

/**
 * Frame layout: on desktop the window is the warm frame (bg-frame), a column
 * of the banners (sandbox, system notice) and under them the shell
 * (DashboardNav): the icon rail on the frame and ONE rounded panel, 10px
 * from the frame's edges, that holds the area sidebar and the page. The
 * frame is exactly the window (h-dvh), so a banner takes its height from the
 * panel instead of pushing it out of view. The page (<main>) is the panel's
 * right column and its own scroll container. On mobile the panel dissolves:
 * full-width document flow with the bottom nav.
 */
const SHELL_FRAME_CLASS = 'min-h-dvh bg-frame md:flex md:h-dvh md:flex-col md:overflow-hidden'
const MAIN_PANEL_CLASS =
  'safe-area-main-padding md:!pb-0 relative bg-background min-h-dvh ' +
  'md:min-h-0 md:min-w-0 md:flex-1 md:overflow-y-auto'

/**
 * The browser tab names the active company (crm#1279): a byrå with several
 * clients open in several windows tells them apart, and a report beside its
 * huvudbok shows whose books both are. A page title of its own goes first.
 */
export async function generateMetadata(): Promise<Metadata> {
  const [{ data: settings }, brand] = await Promise.all([getDashboardSettings(), resolveRequestBrand()])
  const companyName = settings?.company_name?.trim()
  if (!companyName) return {}
  const appName = brand?.appName ?? getBranding().appName
  return { title: { default: `${companyName} · ${appName}`, template: `%s · ${companyName}` } }
}

// Every branch renders inside AllMessagesProvider: the root layout hands
// client components only the public and auth namespaces
// (src/i18n/root-client-namespaces.ts), the dashboard needs the full catalog.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { supabase, user } = await getDashboardAuthContext()

  if (!user) {
    redirect('/login')
  }

  // Deployment-level: can the in-app assistant (the tool-loop runtime behind
  // /api/agent/invoke) run here at all? Env reads only. Handed to every
  // CompanyProvider below so the entry points that open that runtime can hide
  // instead of leading the user into its 503 (#2204).
  const assistantAvailable = getAiStatus().assistantAvailable
  // Installation-level too: is the built-in chat switched on
  // (ASSISTANT_CHAT_ENABLED, on unless switched off)? Handed to the
  // CompanyProviders of the shells without an active company; the company
  // shell asks for its own company below (some companies keep the chat while
  // it is switched off), and the menu row follows the same answer through
  // navRollouts.
  const assistantChatOn = assistantChatEnabled()

  // Resolve active company from user_preferences (authoritative). The
  // `gnubok-company-id` cookie is intentionally no longer consulted here:
  // `getActiveCompanyId` reads from user_preferences, matching what RLS
  // sees via `current_active_company_id()`. Keeping both sides on the same
  // source avoids cross-tab / cookie divergence.
  // Team memberships come from the request-cached getDashboardTeamMemberships
  // (ALL rows: multi-team is the supported shape after WL-08) so the home
  // page's byrå landing redirect reuses the same single query.
  // Wave 1: everything keyed on the user alone runs alongside the company
  // resolution. The memberships join carries the active company's row and
  // role too, so wave 2 no longer re-reads companies / company_members.
  const [
    companyId,
    headerStore,
    teamMemberships,
    { data: userProfile },
    { data: userPrefs },
    { data: allMemberships },
    acceptance,
    bankIdEnrichment,
  ] = await Promise.all([
    getDashboardCompanyId(),
    // Read the pathname forwarded by middleware so we can branch on it.
    headers(),
    getDashboardTeamMemberships(),
    // The signed-in user's profile, shown in the bottom-left account
    // popover (full_name + initial) so it's clear which user is logged
    // in, distinct from the active company shown at the top. Request-cached:
    // Hem reads the same row for its greeting.
    getDashboardUserProfile(),
    // Per-user UI state (assistant panel geometry, trial acknowledgement),
    // server-rendered so both are right on first paint, plus the
    // hide-assistant-FAB preference (Inställningar → Assistenten).
    supabase.from('user_preferences').select('ui_state, hide_assistant_fab').eq('user_id', user.id).maybeSingle(),
    // Request-cached: a page's invoicer check reads the role from these rows.
    getDashboardCompanyMemberships(),
    // Which legal documents the person still has to accept, and their
    // analytics choice: the acceptance prompt and whether PostHog may start.
    // Its own reads, so a failure never touches the ones above.
    readAcceptanceState(supabase, user.id),
    // The BankID engagements behind "Lägg till företag" (addCompanyHref
    // below). Read only for an account that has been through BankID, the
    // only way the row gets written: nobody else pays for the request.
    mayHaveBankIdEngagements(user.app_metadata)
      ? supabase.from('bankid_enrichment').select('company_roles').eq('user_id', user.id).maybeSingle()
      : null,
  ])

  // "Lägg till företag" (user menu, switcher, Företag settings, ⌘K): straight
  // into the journey when the BankID picker would be empty, instead of via
  // /select-company's redirect. A failed read keeps the picker door, which
  // decides for itself.
  const companyAddHref = addCompanyHref(
    bankIdEnrichment === null ? null : bankIdEnrichment.error ? undefined : (bankIdEnrichment.data?.company_roles ?? null),
    (allMemberships ?? []).map((m) => {
      const c = m.companies as { org_number?: string | null; archived_at?: string | null } | null
      return c && !c.archived_at ? c.org_number : null
    }),
  )

  const pathname = headerStore.get('x-pathname') ?? ''
  // Dashboard pages that stay reachable without an active company (Profil
  // and the delete-account page): the same list the middleware lets through.
  const isNoCompanyAllowed = isNoCompanyDashboardPath(pathname)

  // Operator-set system notice (NEXT_PUBLIC_SYSTEM_NOTICE_UNTIL): null when
  // unset or expired, so the banner is not even rendered outside its window.
  // Computed before the shell branches below so every signed-in user sees it,
  // byrå consultants and stale-cookie sessions included.
  const systemNoticeUntil = parseSystemNoticeUntil(process.env.NEXT_PUBLIC_SYSTEM_NOTICE_UNTIL)
  const systemNoticeBanner =
    systemNoticeUntil !== null ? <SystemNoticeBanner until={systemNoticeUntil} /> : null

  // Team now carries `kind` directly (types/index.ts, WL-08).
  const membershipRows = teamMemberships
  const byraMembership = membershipRows.find((m) => m.teams?.kind === 'byra') ?? null
  // Byrå team membership gates the cockpit ("Klienter" nav + /clients).
  const byraTeam: ByraTeamRef | null = byraMembership?.teams
    ? {
        id: byraMembership.teams.id,
        name: byraMembership.teams.name,
        role:
          byraMembership.role === 'owner' || byraMembership.role === 'admin'
            ? byraMembership.role
            : 'member',
      }
    : null
  // Legacy single-team fields: the byrå team when present (the one consumers
  // care about), else the first membership: same value as before for
  // single-team users.
  const team: Team | null =
    (byraMembership?.teams as Team | null) ??
    (membershipRows[0]?.teams as Team | null) ??
    null
  const isTeamMember = membershipRows.length > 0

  // Invite-only brand-domain gate (2026-08-27): on a gated brand host, a
  // session with no tie to the brand (team, company, allowlist entry, or
  // pending invite) is sent to the canonical domain instead of getting a
  // branded shell. Runs before the zero-company branch below, because that
  // branch would otherwise walk a stranger into /onboarding under the
  // partner's brand. Navigation-level like WL-01; RLS is the data boundary.
  const hostHeader =
    headerStore.get('x-forwarded-host') ?? headerStore.get('host') ?? ''
  const bounceUrl = await resolveBrandDomainBounce({
    host: hostHeader,
    userEmail: user.email,
    teamIds: membershipRows
      .map((m) => m.teams?.id)
      .filter((id): id is string => typeof id === 'string'),
    companyTeamIds: (allMemberships || []).map(
      (m) => (m.companies as { team_id?: string | null } | null)?.team_id,
    ),
    hasPendingInviteCookie:
      (await cookies()).get(INVITE_COOKIE_NAME)?.value != null,
    canonicalAppUrl: getBranding().appUrl,
  })
  if (bounceUrl) {
    redirect(bounceUrl)
  }

  // No companies: redirect to onboarding, except for allowed escape-hatch
  // routes (so the user can still reach /settings/account to delete their
  // account after archiving their last company) and byrå team members (any
  // role, product call 2026-08-05), whose home is the EMPTY cockpit (mirrors
  // the middleware's byrå exception): they render the no-company shell on
  // cockpit routes and are steered to /byra everywhere else, never to the
  // company wizard.
  if (!companyId) {
    const isByraMember = !!byraTeam
    const isByraShellPath =
      pathname.startsWith('/byra') ||
      pathname.startsWith('/clients') ||
      pathname.startsWith('/settings')
    if (!isNoCompanyAllowed && !(isByraMember && isByraShellPath)) {
      if (isByraMember) {
        redirect('/byra')
      }
      redirect('/onboarding')
    }

    return (
      <AllMessagesProvider>
      <CompanyProvider
        value={{
          company: null,
          role: null,
          companies: [],
          isTeamMember,
          team,
          byraTeam,
          foreignCompanies: [],
          isSandbox: false,
          capabilities: [],
          assistantAvailable,
          assistantChatEnabled: assistantChatOn,
          trialEndsAt: null,
          entitlementState: 'none' as const,
          trialExpiredAt: null,
          addCompanyHref: companyAddHref,
        }}
      >
        <SessionTimeoutController />
        <BrowserSessionGuard />
        <FiscalScopeProvider>
        <AgentSheetProvider>
          <CompanyTabSync />
          <div className={SHELL_FRAME_CLASS}>
            {systemNoticeBanner}
            <DashboardNav
              navGate={{ entityType: 'enskild_firma', surface: capabilitySurfaceWithoutCompany('enskild_firma') }}
              extensionNavItems={getExtensionNavItems()}
            >
            <main
              id="main-content"
              className={MAIN_PANEL_CLASS}
              role="main"
            >
              <MainContainer companyId={null}>
                {children}
              </MainContainer>
            </main>
            </DashboardNav>
            <SettingsHotkey />
          <Suspense fallback={null}>
            <SupportDialogHost />
          </Suspense>
          <LegalAcceptanceGate state={acceptance} pathname={pathname} company={null} role={null} isAnonymous={user.is_anonymous} />
          </div>
        </AgentSheetProvider>
        </FiscalScopeProvider>
      </CompanyProvider>
      </AllMessagesProvider>
    )
  }

  // The active company's row and role come from the memberships join above
  // (a company the user is not a member of resolves to null, same as the old
  // .single() reads did).
  const activeMembership = (allMemberships || []).find((m) => m.company_id === companyId) ?? null
  const companyRow = (activeMembership?.companies as unknown as import('@/types').Company | null) ?? null
  const memberRow = activeMembership ? { role: activeMembership.role } : null

  // The invoicing-only role opens only the invoicing pages
  // (lib/auth/invoicer-role.ts); every other page sends it to the invoices.
  // Pages with server reads of their own redirect too
  // (redirectInvoicerOffPage): this one does not stop them running.
  const isInvoicer = isInvoicerRole(memberRow?.role)
  const invoicerRedirect = invoicerPageRedirect(memberRow?.role, pathname)
  if (invoicerRedirect) {
    redirect(invoicerRedirect)
  }

  // Home-domain rule (WL-01): which brand serves this host, and which brand
  // (if any) each membership company's team owns. Both resolvers are ~60s
  // cached (the domain-gate lookup above already warmed the host entry);
  // unknown hosts and brandless teams resolve to null/absent, so the
  // canonical no-brands hot path stays byte-identical.

  // Wave 2: everything keyed on the company. Nav badge counts are NOT fetched
  // here: DashboardNav loads them client-side after mount
  // (lib/hooks/use-worklist-badges). The four nav-visibility probes
  // (webshop connections/orders, mileage trips) collapsed into one RPC.
  const [
    { data: settings, error: settingsError },
    agentProfileIdentity,
    entitlements,
    allSettingsNames,
    navFlags,
    { data: seedFiscalPeriods, error: seedFiscalPeriodsError },
    { data: seedCashAccounts, error: seedCashAccountsError },
    hostBrand,
    brandByTeam,
    storedProfile,
  ] = await Promise.all([
    getDashboardSettings(),
    // Agent identity, name + avatar, surfaced on the FAB and chat
    // surfaces. Null when no agent_profile exists yet (banner CTA path).
    getResolvedDashboardAgentProfile(),
    // teamId comes from the membership join, so the entitlements read is one
    // wave (grants in parallel with config + subscription).
    // The invoicer's own session reads no plan rows, so the plan it works
    // under is read for it through the company-scoped client.
    getCompanyEntitlements(
      isInvoicer && companyId && user ? createCompanyScopedClient({ companyId, userId: user.id }) : supabase,
      companyId,
      { teamId: companyRow?.team_id ?? null },
    ),
    // Current display names for ALL the user's companies (the switcher list),
    // so non-active rows show company_settings.company_name instead of the
    // frozen companies.name. The companies are named from the memberships read
    // above: a bare select scoped by RLS alone returns the same rows by reading
    // every company's settings (lib/company/settings-names.ts).
    fetchCompanySettingsNames(
      supabase,
      (allMemberships ?? []).map((m) => m.company_id),
    ),
    getDashboardNavFlags(supabase, companyId),
    // Reference-data seed (lib/reference-data/seed.ts): the two small lists
    // that gate almost every form, fetched once here so the first picker a
    // user opens renders populated with zero client round trips. Same
    // ordering as period.list and listForCompany so the seed and the client
    // refetch agree. The chart of accounts is deliberately NOT seeded: it
    // can be hundreds of KB for large companies. The periods are
    // request-cached: the report and reconciliation pages reuse them.
    getDashboardFiscalPeriods(),
    // The embed carries each account's bank for the Konto label; same select
    // as fetchCashAccounts (lib/cash-accounts/labels.ts CashAccountWithBank).
    supabase
      .from('cash_accounts')
      .select('*, bank_connection:bank_connections(bank_name, status)')
      .eq('company_id', companyId)
      .order('is_primary', { ascending: false })
      .order('ledger_account', { ascending: true }),
    hostHeader ? resolveBrandByHost(hostHeader) : Promise.resolve(null),
    resolveBrandsForTeams(
      // The byrå team's own id rides along so its brand resolves even when
      // none of the user's companies belong to it (pre-byrå companies have
      // team_id null; a fresh byrå may have zero clients). Batched and
      // cached, so this is free on the common path.
      (allMemberships || [])
        .map(
          (m) => (m.companies as { team_id?: string | null } | null)?.team_id ?? null,
        )
        .concat(byraTeam ? [byraTeam.id] : []),
    ),
    // The company's profile, in a read of its own that resolves to Standard
    // when it fails, so the membership join above never carries the column.
    readStoredProfile(supabase, companyId),
  ])
  const canonicalDomain = (() => {
    try {
      return new URL(getBranding().appUrl).hostname
    } catch {
      return ''
    }
  })()

  // company_id -> current display name for every company the user belongs to.
  const nameByCompany = new Map(
    allSettingsNames.map((s) => [s.company_id, s.company_name]),
  )

  // Where "Tillbaka till klienter" points: the byrå cockpit's home domain
  // (WL-01), relative when this host already is that home. The no-company
  // branch above renders before brands resolve, so only these two branches
  // carry the href; DashboardNav falls back to '/clients'.
  const byraTeamWithHref: ByraTeamRef | null = byraTeam
    ? {
        ...byraTeam,
        cockpitHref: resolveCockpitHref({
          byraTeamId: byraTeam.id,
          brandByTeam,
          hostBrandTeamId: hostBrand?.teamId ?? null,
          canonicalDomain,
        }),
      }
    : null

  if (!companyRow || !memberRow) {
    // Stale cookie pointing to a deleted/inaccessible company.
    // Render the empty-state dashboard so user can switch or create a company.
    const companyContextValue = {
      company: null,
      role: null,
      companies: (allMemberships || []).filter(m => m.companies).map((m) => {
        const c = m.companies as unknown as import('@/types').Company
        return {
          company: { ...c, name: nameByCompany.get(c.id) || c.name },
          role: m.role as CompanyRole,
        }
      }),
      isTeamMember,
      team,
      byraTeam: byraTeamWithHref,
      foreignCompanies: [],
      isSandbox: false,
      capabilities: [],
      assistantAvailable,
      assistantChatEnabled: assistantChatOn,
      trialEndsAt: null,
      entitlementState: 'none' as const,
      trialExpiredAt: null,
      addCompanyHref: companyAddHref,
    }

    return (
      <AllMessagesProvider>
      <CompanyProvider value={companyContextValue}>
        <SessionTimeoutController />
        <BrowserSessionGuard />
        <FiscalScopeProvider>
        <AgentSheetProvider>
          <CompanyTabSync />
          <div className={SHELL_FRAME_CLASS}>
            {systemNoticeBanner}
            <DashboardNav
              navGate={{ entityType: 'enskild_firma', surface: capabilitySurfaceWithoutCompany('enskild_firma') }}
              extensionNavItems={getExtensionNavItems()}
            >
            <main id="main-content" className={MAIN_PANEL_CLASS} role="main">
              <MainContainer companyId={null}>
                {children}
              </MainContainer>
            </main>
            </DashboardNav>
            <SettingsHotkey />
            <Suspense fallback={null}>
              <SupportDialogHost />
            </Suspense>
            <LegalAcceptanceGate state={acceptance} pathname={pathname} company={null} role={null} isAnonymous={user.is_anonymous} />
          </div>
        </AgentSheetProvider>
        </FiscalScopeProvider>
      </CompanyProvider>
      </AllMessagesProvider>
    )
  }

  // If onboarding incomplete, still render the dashboard: the page component
  // will show the inline onboarding card instead of the normal dashboard content.

  // Use company_name from settings as the display name (companies.name may be stale)
  const displayName = settings?.company_name || companyRow.name

  // Resolve entity type the same way the report engines and
  // getCompanyEntityType do: company_settings is read-primary, companies is the
  // canonical (NOT NULL) fallback; never a guessed default. Mirroring it onto
  // the active company keeps the settings rail (useSettingsNavItems, which
  // reads context) and the sidebar in agreement on who is an employer. #782
  const entityType: EntityType = parseEntityType(settings?.entity_type ?? companyRow.entity_type)
  const paysSalaries = settings?.pays_salaries ?? false
  // Dimensions register visibility (Kostnadsställen & projekt nav row). Same
  // mechanism as paysSalaries: UI gate only, never load-bearing for
  // correctness (dimensions plan §2).
  const dimensionsEnabled = settings?.dimensions_enabled ?? false
  // Kundorder visibility: same UI-only gate as dimensionsEnabled.
  const salesOrdersEnabled = settings?.sales_orders_enabled ?? false
  // Offerter row: UI-only gate, default on (a fresh settings row has it true).
  const quotesEnabled = settings?.quotes_enabled ?? true
  // Körjournal visibility: the settings toggle is the normal way in, existing
  // trips force the row on so already-created data stays reachable.
  const hasMileage = (settings?.mileage_enabled ?? false) || navFlags.hasMileageTrips
  const companyWithName = {
    ...companyRow,
    name: displayName,
    entity_type: entityType,
    pays_salaries: paysSalaries,
  }
  // The resolved capabilities the menu reads (lib/modules/capabilities.ts),
  // from the company row and the entitlements read above: no read of its own.
  // A package switched off with obligations still open winds down and keeps
  // its menu row: the probes run only when a package is switched off, so a
  // company with every package on reads nothing more.
  const navInputs = capabilityInputsFromEntitlements(
    {
      jurisdiction: companyRow.jurisdiction,
      ledgerCurrency: companyRow.ledger_currency,
      entityType,
      paysSalaries,
      profileId: storedProfile?.id,
      profileVersion: storedProfile?.version,
    },
    entitlements,
  )
  let navCapabilities = resolveCapabilities(navInputs)
  const switchedOff = switchedOffPackageIds(navCapabilities)
  if (switchedOff.length > 0) {
    navCapabilities = resolveCapabilities({
      ...navInputs,
      openObligations: await getDashboardOpenObligations(switchedOff.join(',')),
    })
  }
  // The menu's gates, resolved once: the sidebar and the command palette are
  // handed the same object, so the two list the same pages.
  const navGate = {
    entityType,
    surface: capabilitySurface(navCapabilities),
    dimensionsEnabled,
    salesOrdersEnabled,
    quotesEnabled,
    hasWebshop: navFlags.hasWebshop,
    hasMileage,
    hasExpenseClaims: navFlags.hasExpenseClaims,
    hasPosSales: navFlags.hasPosSales,
    ...navRollouts(companyId, { bolagetRegisters: (companyRow as { bolaget_registers_enabled?: boolean }).bolaget_registers_enabled === true }),
  }

  const isSandbox = settings?.is_sandbox === true

  // The built-in chat for this company: on unless switched off, and then only
  // for the companies that keep it (ASSISTANT_CHAT_COMPANY_IDS).
  const companyChatOn = assistantChatEnabledFor(companyId, todayIsoStockholm())

  // Multi-user seat gate, switcher side: which of the user's OTHER companies
  // are frozen for them (non-owner membership, multi_user lapsed past grace).
  // Zero queries for the common owner-of-everything user; the grants read
  // runs only when a non-owner membership exists.
  const dormantCompanyIds = await resolveDormantCompanyIds(
    supabase,
    (allMemberships || [])
      .filter((m) => m.companies)
      .map((m) => ({
        company_id: m.company_id,
        role: m.role as string,
        companies: {
          team_id: ((m.companies as { team_id?: string | null } | null)?.team_id ?? null),
        },
      })),
  )

  // Client-driven UI preferences (assistant panel geometry, trial
  // acknowledgement), read here so the first paint matches what the client
  // persists via /api/user/ui-state.
  const uiState = (userPrefs?.ui_state ?? {}) as import('@/types').UserUiState

  // One-time Discord invite above the sidebar's user menu. Who sees it
  // (hosted app only, once per user) is decided here so a dismissed card
  // never mounts.
  const showDiscordInvite = shouldOfferDiscordInvite({
    dismissedAt: uiState.discord_invite_dismissed_at,
    isSandbox,
    isAnonymous: user.is_anonymous,
    onBrandHost: hostBrand != null,
    selfHosted: flagEnabled(process.env.NEXT_PUBLIC_SELF_HOSTED),
  })

  const allCompanyEntries = (allMemberships || [])
    .filter((m) => m.companies)
    .map((m) => {
      const c = m.companies as unknown as import('@/types').Company
      // Current display name for every company (company_settings.company_name,
      // falling back to the frozen companies.name) so non-active switcher rows
      // are current too. For the active company this equals `displayName`.
      return {
        company: { ...c, name: nameByCompany.get(c.id) || c.name },
        role: m.role as CompanyRole,
      }
    })

  // Home-domain rule (WL-01): the switcher offers only companies homed on
  // THIS host; companies homed elsewhere become "Hanteras via <domain>"
  // signpost entries. With no brands anywhere both lists reduce to
  // visible = everything, foreign = [] : the additive guarantee.
  const homePartition = partitionCompaniesByHomeDomain({
    companies: allCompanyEntries,
    getTeamId: (entry) => entry.company.team_id ?? null,
    brandByTeam,
    hostBrandTeamId: hostBrand?.teamId ?? null,
    canonicalDomain,
    canonicalAppName: getBranding().appName,
  })
  const foreignCompanies = homePartition.foreign.map((f) => ({
    id: f.item.company.id,
    name: f.item.company.name,
    domain: f.domain,
  }))

  const companyContextValue = {
    company: companyWithName,
    role: memberRow.role as CompanyRole,
    companies: homePartition.visible,
    isTeamMember,
    team,
    byraTeam: byraTeamWithHref,
    foreignCompanies,
    isSandbox,
    capabilities: entitlements.capabilities,
    // The assistant reads the whole company: never offered to the invoicer.
    assistantAvailable: assistantAvailable && !isInvoicer,
    assistantChatEnabled: companyChatOn,
    assistantChatUntil: assistantChatUntil(),
    trialEndsAt: entitlements.trialEndsAt,
    entitlementState: entitlements.entitlementState,
    trialExpiredAt: entitlements.trialExpiredAt,
    lockedCompanyIds: [...dormantCompanyIds],
    addCompanyHref: companyAddHref,
    // The AI assistant in the support dialog: for the companies it is
    // switched on for, where an AI backend is configured. It reads the whole
    // company, so never for the invoicing-only role, and never in the sandbox.
    supportAssistant:
      isSupportAssistantEnabled(companyId) && getAiStatus().configured && !isInvoicer && !isSandbox,
  }

  // Signpost gate (WL-01): a company is opened ONLY on its home domain. When
  // the active company is homed elsewhere, the dashboard body is replaced by
  // the signpost (never the wrong company's data), except on account-level
  // and byrå-cockpit routes, which are not company surfaces. Navigation rule
  // only: RLS/membership remain the security boundary, and middleware is
  // untouched (the layout is the clean seam: brand lookups don't belong on
  // the Edge hot path).
  const activeCompanyHomed = isCompanyHomedOnHost({
    companyTeamId: (companyRow.team_id as string | null) ?? null,
    brandByTeam,
    hostBrandTeamId: hostBrand?.teamId ?? null,
  })
  const SIGNPOST_ALLOWED_PATHS = ['/settings/account', '/clients', '/byra']
  const showSignpost =
    !activeCompanyHomed &&
    !SIGNPOST_ALLOWED_PATHS.some((p) => pathname.startsWith(p))

  return (
    <AllMessagesProvider>
    <CompanyProvider value={companyContextValue}>
      <ReferenceDataSeed
        companyId={companyId}
        // A read that failed is not seeded: an empty list would stand as the
        // answer ("no fiscal years") for every consumer until a reload, where
        // an unseeded key is read by the browser as before.
        fiscalPeriods={seedFiscalPeriodsError ? undefined : (seedFiscalPeriods ?? [])}
        cashAccounts={seedCashAccountsError ? undefined : (seedCashAccounts ?? [])}
        settings={settingsError ? undefined : settings}
      >
      <SessionTimeoutController />
      <BrowserSessionGuard />
      <FiscalScopeProvider>
      <DashboardRouteShell
        onboarding={
          <div className="relative min-h-dvh bg-background">
            <OnboardingBackdrop />
            <main id="main-content" className="relative z-10">
              {showSignpost ? (
                <HomeDomainSignpost
                  activeCompanyName={displayName}
                  homedCompanies={homePartition.visible.map((entry) => ({ id: entry.company.id, name: entry.company.name }))}
                  foreignCompanies={foreignCompanies}
                />
              ) : children}
            </main>
          </div>
        }
      >
      <AgentSheetProvider
        identity={{
          displayName: agentProfileIdentity?.display_name ?? null,
          avatarId: agentProfileIdentity?.avatar_id ?? null,
          isVerified: Boolean(agentProfileIdentity?.verified_at),
        }}
        // Server-seeded panel geometry (docked width / floating rect / mode)
        // so the assistant opens at the user's persisted size without a jump.
        initialPanelPrefs={uiState.agent_panel}
      >
        <CompanyTabSync />
        <div
          id="dash-shell"
          className={SHELL_FRAME_CLASS}
        >
          {/* Skip to content link for keyboard/screen reader users */}
          <a
            data-ph-unmask
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:px-4 focus:py-2 focus:bg-primary focus:text-primary-foreground focus:rounded-lg focus:text-sm focus:font-medium"
          >
            Hoppa till innehåll
          </a>
          {isSandbox && <SandboxBanner />}
          {systemNoticeBanner}
          <DashboardNav
            navGate={navGate}
            isSandbox={isSandbox}
            extensionNavItems={getExtensionNavItems()}
            userName={userProfile?.full_name ?? null}
            userEmail={user.email ?? null}
            showDiscordInvite={showDiscordInvite}
          >
          <main id="main-content" className={MAIN_PANEL_CLASS} role="main">
            <MainContainer companyId={companyId}>
              {showSignpost ? (
                <HomeDomainSignpost
                  activeCompanyName={displayName}
                  homedCompanies={homePartition.visible.map((entry) => ({
                    id: entry.company.id,
                    name: entry.company.name,
                  }))}
                  foreignCompanies={foreignCompanies}
                />
              ) : (
                children
              )}
            </MainContainer>
          </main>
          </DashboardNav>
          {/* One-time post-trial invitation. Sandbox/anonymous demo users have
              no billing (their companies carry trial grants too), so the gate
              lives here where both flags are known. Acknowledgement persists
              per user AND company in user_preferences.ui_state, read here
              server-side so an acked dialog never flashes. */}
          {!isSandbox && !user.is_anonymous && (
            <TrialExpiredDialog
              state={entitlements.entitlementState}
              companyId={companyId}
              initialAcknowledged={!!uiState.trial_expired_ack?.[companyId]}
            />
          )}
          {/* The palette lists the shell's own rows, gated as the sidebar gates them. */}
          <LazyCommandPalette navGate={navGate} />
          <SettingsHotkey />
          {/* ?support=1, the link in the "we have answered" mail. Every shell
              mounts it: this one lacked it, so the link opened nothing for
              anyone with a company (crm#1393). */}
          <Suspense fallback={null}>
            <SupportDialogHost />
          </Suspense>
          <LegalAcceptanceGate
            state={acceptance}
            pathname={pathname}
            company={{ id: companyId, name: displayName }}
            role={memberRow.role}
            isSandbox={isSandbox}
            isAnonymous={user.is_anonymous}
          />
        </div>
        {/* Outside #dash-shell on purpose: non-modal dialogs (booking,
            invoice) set `inert` on the shell while open, and the assistant
            entry point must stay clickable then, like the sheet itself.
            Where the company has no chat, the corner is the support's: the
            panel every door to the AI assistant opens, and its floating
            button. */}
        {companyChatOn ? (
          <AgentTrigger hidden={userPrefs?.hide_assistant_fab === true} />
        ) : companyContextValue.supportAssistant ? (
          <SupportDock pillHidden={uiState.support_fab_hidden === true} />
        ) : null}
        {!isSandbox && (
          <AnalyticsIdentify
            user={{
              userId: user.id,
              email: user.email,
              fullName: userProfile?.full_name ?? null,
              role: memberRow.role as CompanyRole,
            }}
            identityHash={computeIdentityHash(user.id)}
            analyticsConsent={acceptance.analyticsConsent !== false}
            company={{
              id: companyId,
              name: displayName,
              entityType,
              accountingFramework: companyRow.accounting_framework as AccountingFramework,
              paysSalaries,
              trialEndsAt: entitlements.trialEndsAt,
              capabilities: entitlements.capabilities,
            }}
          />
        )}
      </AgentSheetProvider>
      </DashboardRouteShell>
      </FiscalScopeProvider>
      </ReferenceDataSeed>
    </CompanyProvider>
    </AllMessagesProvider>
  )
}
