import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
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
import { getExtensionNavItems } from '@/lib/extensions/sectors'
import { CompanyProvider } from '@/contexts/CompanyContext'
import { getCompanyEntitlements } from '@/lib/entitlements/has-capability'
import { getDashboardNavFlags } from '@/lib/dashboard/nav-flags'
import { getBranding } from '@/lib/branding/service'
import type { AccountingFramework, EntityType, CompanyRole, Team } from '@/types'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardSettings,
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
  // Team membership (with the team row embedded) only depends on user.id,
  // so it resolves in parallel, this layout is on the critical path of
  // every dashboard page, so sequential round-trips are wall-clock time.
  // Wave 1: everything keyed on the user alone runs alongside the company
  // resolution. The memberships join carries the active company's row and
  // role too, so wave 2 no longer re-reads companies / company_members.
  const [
    companyId,
    headerStore,
    { data: teamMembership },
    { data: userProfile },
    { data: userPrefs },
    { data: allMemberships },
  ] = await Promise.all([
    getDashboardCompanyId(),
    // Read the pathname forwarded by middleware so we can branch on it.
    headers(),
    supabase
      .from('team_members')
      .select('team_id, role, teams:team_id(*)')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle(),
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

  const team: Team | null =
    (teamMembership?.teams as unknown as Team | null) ?? null
  const isTeamMember = !!teamMembership

  // No companies: redirect to onboarding, except for allowed escape-hatch
  // routes (so the user can still reach /settings/account to delete their
  // account after archiving their last company).
  if (!companyId) {
    if (!isNoCompanyAllowed) {
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

  // Wave 2: everything keyed on the company. Nav badge counts are NOT fetched
  // here: DashboardNav loads them client-side after mount
  // (lib/hooks/use-worklist-badges). The four nav-visibility probes
  // (webshop connections/orders, mileage trips) collapsed into one RPC.
  const [
    { data: settings },
    agentProfileIdentity,
    entitlements,
    { data: allSettingsNames },
    navFlags,
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
  ])
  const hasWebshop = navFlags.hasWebshop
  const hasMileageTrips = navFlags.hasMileageTrips

  // company_id -> current display name for every company the user belongs to.
  const nameByCompany = new Map(
    (allSettingsNames || []).map((s) => [s.company_id, s.company_name as string | null]),
  )

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

  // Client-driven UI preferences (sidebar collapse + fold state). Read here
  // so the shell renders at the right width on first paint; the nav toggles
  // flip the data attribute client-side and persist via /api/user/ui-state.
  const uiState = (userPrefs?.ui_state ?? {}) as import('@/types').UserUiState
  const navCollapsed = uiState.nav_collapsed === true

  const companyContextValue = {
    company: companyWithName,
    role: memberRow.role as CompanyRole,
    companies: (allMemberships || []).map((m) => {
      const c = m.companies as unknown as import('@/types').Company
      // Current display name for every company (company_settings.company_name,
      // falling back to the frozen companies.name) so non-active switcher rows
      // are current too. For the active company this equals `displayName`.
      return {
        company: { ...c, name: nameByCompany.get(c.id) || c.name },
        role: m.role as CompanyRole,
      }
    }),
    isTeamMember,
    team,
    isSandbox,
    capabilities: entitlements.capabilities,
    trialEndsAt: entitlements.trialEndsAt,
    entitlementState: entitlements.entitlementState,
    trialExpiredAt: entitlements.trialExpiredAt,
  }

  return (
    <CompanyProvider value={companyContextValue}>
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
          <DashboardNav
            companyName={settings?.company_name || 'Min verksamhet'}
            entityType={entityType}
            paysSalaries={paysSalaries}
            dimensionsEnabled={dimensionsEnabled}
            hasWebshop={hasWebshop}
            hasMileage={hasMileage}
            isSandbox={isSandbox}
            extensionNavItems={getExtensionNavItems()}
            userName={userProfile?.full_name ?? null}
            userEmail={user.email ?? null}
            initialUiState={uiState}
          />
          <main id="main-content" className={MAIN_PANEL_CLASS} role="main">
            <MainContainer companyId={companyId}>{children}</MainContainer>
          </main>
          <AgentTrigger hidden={userPrefs?.hide_assistant_fab === true} />
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
    </CompanyProvider>
  )
}
