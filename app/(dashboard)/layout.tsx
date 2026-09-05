import { redirect } from 'next/navigation'
import { cookies, headers } from 'next/headers'
import DashboardNav from '@/components/dashboard/DashboardNav'
import { MainContainer } from '@/components/dashboard/MainContainer'
import CompanyTabSync from '@/components/dashboard/CompanyTabSync'
import AnalyticsIdentify from '@/components/AnalyticsIdentify'
import { computeIdentityHash } from '@/lib/analytics/identity-hash'
import { AgentSheetProvider } from '@/components/agent/AgentSheetProvider'
import AgentTrigger from '@/components/agent/AgentTrigger'
import LazyCommandPalette from '@/components/common/LazyCommandPalette'
import { SettingsHotkey } from '@/components/settings/SettingsHotkey'
import { SessionTimeoutController } from '@/components/auth/SessionTimeoutController'
import { SandboxBanner } from '@/components/dashboard/SandboxBanner'
import TrialExpiredDialog from '@/components/billing/TrialExpiredDialog'
import MultiUserGraceBanner from '@/components/billing/MultiUserGraceBanner'
import { resolveDormantCompanyIds } from '@/lib/company/active-company'
import { getMultiUserState } from '@/lib/entitlements/multi-user'
import { createServiceClient } from '@/lib/supabase/server'
import { getExtensionNavItems } from '@/lib/extensions/sectors'
import { CompanyProvider, type ByraTeamRef } from '@/contexts/CompanyContext'
import { ReferenceDataSeed } from '@/components/providers/ReferenceDataSeed'
import { getCompanyEntitlements } from '@/lib/entitlements/has-capability'
import { getDashboardNavFlags } from '@/lib/dashboard/nav-flags'
import { getBranding } from '@/lib/branding/service'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { resolveBrandDomainBounce } from '@/lib/auth/brand-signup-gate'
import { INVITE_COOKIE_NAME } from '@/lib/auth/consume-invite-cookie'
import { resolveBrandsForTeams } from '@/lib/branding/team-brands'
import {
  partitionCompaniesByHomeDomain,
  isCompanyHomedOnHost,
  resolveCockpitHref,
} from '@/lib/company/home-domain'
import HomeDomainSignpost from '@/components/dashboard/HomeDomainSignpost'
import type { AccountingFramework, EntityType, CompanyRole, Team } from '@/types'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardSettings,
  getDashboardTeamMemberships,
  getResolvedDashboardAgentProfile,
} from './request-context'

/**
 * Routes inside the dashboard group that must remain reachable when the
 * user has no active company. Keep in sync with the middleware's
 * no-company allowlist.
 */
const NO_COMPANY_ALLOWED_PATHS = ['/settings/account']

/**
 * Frame layout: on desktop the page is a rounded panel floating on the
 * warm-toned frame (bg-frame on the wrapper div), with its own inner
 * scroll. 10px margin against the frame; height is the remaining
 * viewport. The sidebar (fixed, w-64) sits borderless on the frame, so
 * the panel starts at ml-64. On mobile the panel dissolves: full-width
 * document flow with the bottom nav, exactly as before.
 */
const MAIN_PANEL_CLASS =
  'safe-area-main-padding md:!pb-0 relative bg-background min-h-dvh ' +
  'md:min-h-0 md:ml-[var(--nav-w)] md:mt-[10px] md:mr-[var(--agent-dock-w)] md:h-[calc(100vh-20px)] ' +
  'md:overflow-y-auto md:rounded-xl md:border md:border-border ' +
  'md:transition-[margin-left,margin-right] md:duration-300 md:ease-[cubic-bezier(0.32,0.72,0,1)]'

export default async function DashboardLayout({
  children,
  settingsModal,
}: {
  children: React.ReactNode
  // `@settingsModal` parallel slot: renders the routed settings modal over the
  // current page on in-app navigation to /settings/*; null otherwise.
  settingsModal: React.ReactNode
}) {
  const { supabase, user } = await getDashboardAuthContext()

  if (!user) {
    redirect('/login')
  }

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
  ] = await Promise.all([
    getDashboardCompanyId(),
    // Read the pathname forwarded by middleware so we can branch on it.
    headers(),
    getDashboardTeamMemberships(),
    // The signed-in user's profile, shown in the bottom-left account
    // popover (full_name + initial) so it's clear which user is logged
    // in, distinct from the active company shown at the top.
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
    // Per-user UI state (nav collapse/fold state), server-rendered so the
    // sidebar width is right on first paint, plus the hide-assistant-FAB
    // preference (Inställningar → Assistenten).
    supabase.from('user_preferences').select('ui_state, hide_assistant_fab').eq('user_id', user.id).maybeSingle(),
    supabase.from('company_members').select('company_id, role, companies:company_id(id, name, org_number, entity_type, accounting_framework, created_by, team_id, archived_at, created_at, updated_at)').eq('user_id', user.id),
  ])

  const pathname = headerStore.get('x-pathname') ?? ''
  const isNoCompanyAllowed = NO_COMPANY_ALLOWED_PATHS.some((p) =>
    pathname.startsWith(p)
  )

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
  // role, founder call 2026-08-05), whose home is the EMPTY cockpit (mirrors
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
          trialEndsAt: null,
          entitlementState: 'none' as const,
          trialExpiredAt: null,
        }}
      >
        <SessionTimeoutController />
        <AgentSheetProvider>
          <CompanyTabSync />
          <div className="min-h-dvh bg-frame md:flex md:flex-col">
            <DashboardNav
              companyName={getBranding().appName.toLowerCase()}
              entityType="enskild_firma"
              isSandbox={false}
              extensionNavItems={getExtensionNavItems()}
            />
            <main
              id="main-content"
              className={MAIN_PANEL_CLASS}
              role="main"
            >
              <div className="max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10">
                {children}
              </div>
            </main>
            {settingsModal}
            <SettingsHotkey />
          </div>
        </AgentSheetProvider>
      </CompanyProvider>
    )
  }

  // The active company's row and role come from the memberships join above
  // (a company the user is not a member of resolves to null, same as the old
  // .single() reads did).
  const activeMembership = (allMemberships || []).find((m) => m.company_id === companyId) ?? null
  const companyRow = (activeMembership?.companies as unknown as import('@/types').Company | null) ?? null
  const memberRow = activeMembership ? { role: activeMembership.role } : null

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
    { data: allSettingsNames },
    navFlags,
    { data: seedFiscalPeriods },
    { data: seedCashAccounts },
    hostBrand,
    brandByTeam,
  ] = await Promise.all([
    getDashboardSettings(),
    // Agent identity, name + avatar, surfaced on the FAB and chat
    // surfaces. Null when no agent_profile exists yet (banner CTA path).
    getResolvedDashboardAgentProfile(),
    // teamId comes from the membership join, so the entitlements read is one
    // wave (grants in parallel with config + subscription).
    getCompanyEntitlements(supabase, companyId, { teamId: companyRow?.team_id ?? null }),
    // Current display names for ALL the user's companies (the switcher list).
    // RLS scopes company_settings SELECT to user_company_ids(), so this bare
    // select returns exactly the caller's companies, letting non-active rows
    // show company_settings.company_name instead of the frozen companies.name.
    supabase.from('company_settings').select('company_id, company_name'),
    getDashboardNavFlags(supabase, companyId),
    // Reference-data seed (lib/reference-data/seed.ts): the two small lists
    // that gate almost every form, fetched once here so the first picker a
    // user opens renders populated with zero client round trips. Same
    // ordering as period.list and listForCompany so the seed and the client
    // refetch agree. The chart of accounts is deliberately NOT seeded: it
    // can be hundreds of KB for large companies.
    supabase
      .from('fiscal_periods')
      .select('*')
      .eq('company_id', companyId)
      .order('period_start', { ascending: false }),
    supabase
      .from('cash_accounts')
      .select('*')
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
  ])
  const hasWebshop = navFlags.hasWebshop
  const hasMileageTrips = navFlags.hasMileageTrips
  const hasExpenseClaims = navFlags.hasExpenseClaims

  const canonicalDomain = (() => {
    try {
      return new URL(getBranding().appUrl).hostname
    } catch {
      return ''
    }
  })()

  // company_id -> current display name for every company the user belongs to.
  const nameByCompany = new Map(
    (allSettingsNames || []).map((s) => [s.company_id, s.company_name as string | null]),
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
      trialEndsAt: null,
      entitlementState: 'none' as const,
      trialExpiredAt: null,
    }

    return (
      <CompanyProvider value={companyContextValue}>
        <SessionTimeoutController />
        <AgentSheetProvider>
          <CompanyTabSync />
          <div className="min-h-dvh bg-frame md:flex md:flex-col">
            <DashboardNav
              companyName={getBranding().appName.toLowerCase()}
              entityType="enskild_firma"
              isSandbox={false}
              extensionNavItems={getExtensionNavItems()}
            />
            <main id="main-content" className={MAIN_PANEL_CLASS} role="main">
              <div className="max-w-5xl mx-auto px-5 py-8 md:px-8 md:py-10">
                {children}
              </div>
            </main>
            {settingsModal}
            <SettingsHotkey />
          </div>
        </AgentSheetProvider>
      </CompanyProvider>
    )
  }

  // If onboarding incomplete, still render the dashboard: the page component
  // will show the inline onboarding card instead of the normal dashboard content.

  // Use company_name from settings as the display name (companies.name may be stale)
  const displayName = settings?.company_name || companyRow.name

  // Resolve entity type the same way the report engines and
  // getCompanyEntityType do: company_settings is read-primary, companies is the
  // canonical fallback, then default to enskild_firma. Mirroring it onto the
  // active company keeps the settings rail (useSettingsNavItems, which reads
  // context) and the sidebar in agreement on who is an employer. #782
  const entityType =
    (settings?.entity_type as EntityType) ||
    (companyRow.entity_type as EntityType) ||
    'enskild_firma'
  const paysSalaries = settings?.pays_salaries ?? false
  // Dimensions register visibility (Kostnadsställen & projekt nav row). Same
  // mechanism as paysSalaries: UI gate only, never load-bearing for
  // correctness (dimensions plan §2).
  const dimensionsEnabled = settings?.dimensions_enabled ?? false
  // Kundorder visibility: same UI-only gate as dimensionsEnabled.
  const salesOrdersEnabled = settings?.sales_orders_enabled ?? false
  // Körjournal visibility: the settings toggle is the normal way in, existing
  // trips force the row on so already-created data stays reachable.
  const hasMileage = (settings?.mileage_enabled ?? false) || hasMileageTrips
  const companyWithName = {
    ...companyRow,
    name: displayName,
    entity_type: entityType,
    pays_salaries: paysSalaries,
  }

  const isSandbox = settings?.is_sandbox === true

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

  // The entitlements-derived multiUser state is computed from the grant rows
  // the CALLER can see, and RLS hides team-scoped grants from users outside
  // the team (byrå clients): re-verify any non-entitled answer through the
  // SECURITY DEFINER state RPC before acting on it. One extra round trip only
  // in the rare non-entitled case.
  const activeMultiUser =
    entitlements.multiUser.state === 'entitled'
      ? entitlements.multiUser
      : await getMultiUserState(supabase, companyId)

  // Grace countdown banner data: only while the ACTIVE company is in its
  // 20-day window AND actually has affected people (>= 1 non-owner member).
  // Service client because other members' emails are not readable through
  // the caller's RLS (same reason as GET /api/company/members).
  let graceBanner: { graceEndsAt: string; affectedEmails: string[]; isAffectedUser: boolean } | null =
    null
  if (!isSandbox && activeMultiUser.state === 'grace' && activeMultiUser.graceEndsAt) {
    const serviceClient = await createServiceClient()
    const { data: memberRows } = await serviceClient
      .from('company_members')
      .select('user_id, role')
      .eq('company_id', companyId)
    const affected = (memberRows || []).filter((m) => m.role !== 'owner')
    if (affected.length > 0) {
      const { data: affectedProfiles } = await serviceClient
        .from('profiles')
        .select('id, email')
        .in('id', affected.map((a) => a.user_id))
      const emailById = new Map((affectedProfiles || []).map((p) => [p.id, p.email as string | null]))
      graceBanner = {
        graceEndsAt: activeMultiUser.graceEndsAt,
        affectedEmails: affected
          .map((a) => emailById.get(a.user_id))
          .filter((e): e is string => !!e),
        isAffectedUser: affected.some((a) => a.user_id === user.id),
      }
    }
  }

  // Client-driven UI preferences (sidebar collapse + fold state). Read here
  // so the shell renders at the right width on first paint; the nav toggles
  // flip the data attribute client-side and persist via /api/user/ui-state.
  const uiState = (userPrefs?.ui_state ?? {}) as import('@/types').UserUiState
  const navCollapsed = uiState.nav_collapsed === true

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
    trialEndsAt: entitlements.trialEndsAt,
    entitlementState: entitlements.entitlementState,
    trialExpiredAt: entitlements.trialExpiredAt,
    multiUser: activeMultiUser,
    lockedCompanyIds: [...dormantCompanyIds],
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
    <CompanyProvider value={companyContextValue}>
      <ReferenceDataSeed
        companyId={companyId}
        fiscalPeriods={seedFiscalPeriods ?? []}
        cashAccounts={seedCashAccounts ?? []}
        settings={settingsError ? undefined : settings}
      >
      <SessionTimeoutController />
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
          className="min-h-dvh bg-frame md:flex md:flex-col"
          style={{ '--nav-w': navCollapsed ? '64px' : '248px' } as React.CSSProperties}
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
          {graceBanner && (
            <MultiUserGraceBanner
              graceEndsAt={graceBanner.graceEndsAt}
              affectedEmails={graceBanner.affectedEmails}
              isAffectedUser={graceBanner.isAffectedUser}
              companyName={displayName}
            />
          )}
          <DashboardNav
            companyName={settings?.company_name || 'Min verksamhet'}
            entityType={entityType}
            paysSalaries={paysSalaries}
            dimensionsEnabled={dimensionsEnabled}
            salesOrdersEnabled={salesOrdersEnabled}
            hasWebshop={hasWebshop}
            hasMileage={hasMileage}
            hasExpenseClaims={hasExpenseClaims}
            isSandbox={isSandbox}
            extensionNavItems={getExtensionNavItems()}
            userName={userProfile?.full_name ?? null}
            userEmail={user.email ?? null}
            initialUiState={uiState}
          />
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
          {/* One-time expired-trial notice. Sandbox/anonymous demo users have
              no billing (their companies carry trial grants too), so the gate
              lives here where both flags are known. Acknowledgement persists
              per user AND company in user_preferences.ui_state, read here
              server-side so an acked dialog never flashes. */}
          {!isSandbox && !user.is_anonymous && (
            <TrialExpiredDialog
              state={entitlements.entitlementState}
              trialExpiredAt={entitlements.trialExpiredAt}
              companyId={companyId}
              initialAcknowledged={!!uiState.trial_expired_ack?.[companyId]}
            />
          )}
          <LazyCommandPalette />
          <SettingsHotkey />
          {settingsModal}
        </div>
        {/* Outside #dash-shell on purpose: non-modal dialogs (booking,
            invoice) set `inert` on the shell while open, and the assistant
            entry point must stay clickable then, like the sheet itself. */}
        <AgentTrigger hidden={userPrefs?.hide_assistant_fab === true} />
        {!isSandbox && (
          <AnalyticsIdentify
            user={{
              userId: user.id,
              email: user.email,
              fullName: userProfile?.full_name ?? null,
              role: memberRow.role as CompanyRole,
            }}
            identityHash={computeIdentityHash(user.id)}
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
      </ReferenceDataSeed>
    </CompanyProvider>
  )
}
