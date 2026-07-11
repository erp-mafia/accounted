import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import DashboardNav from '@/components/dashboard/DashboardNav'
import { MainContainer } from '@/components/dashboard/MainContainer'
import CompanyTabSync from '@/components/dashboard/CompanyTabSync'
import { RecaptIdentify } from '@/components/RecaptIdentify'
import { AgentSheetProvider } from '@/components/agent/AgentSheetProvider'
import AgentTrigger from '@/components/agent/AgentTrigger'
import CommandPalette from '@/components/common/CommandPalette'
import { SettingsHotkey } from '@/components/settings/SettingsHotkey'
import { SandboxBanner } from '@/components/dashboard/SandboxBanner'
import { getExtensionNavItems } from '@/lib/extensions/sectors'
import { CompanyProvider } from '@/contexts/CompanyContext'
import { getActiveCompanyId } from '@/lib/company/context'
import { getCompanyEntitlements } from '@/lib/entitlements/has-capability'
import { getBranding } from '@/lib/branding/service'
import { ensureSandboxAgentProfile } from '@/lib/sandbox/ensure-agent'
import { countPendingOperations, countUnbookedTransactions } from '@/lib/worklist'
import type { EntityType, CompanyRole, Team } from '@/types'

/**
 * Routes inside the dashboard group that must remain reachable when the
 * user has no active company. Keep in sync with the middleware's
 * no-company allowlist.
 */
const NO_COMPANY_ALLOWED_PATHS = ['/settings/account']

export default async function DashboardLayout({
  children,
  settingsModal,
}: {
  children: React.ReactNode
  // `@settingsModal` parallel slot: renders the routed settings modal over the
  // current page on in-app navigation to /settings/*; null otherwise.
  settingsModal: React.ReactNode
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

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
  const [companyId, headerStore, { data: teamMembership }] = await Promise.all([
    getActiveCompanyId(supabase, user.id),
    // Read the pathname forwarded by middleware so we can branch on it.
    headers(),
    supabase
      .from('team_members')
      .select('team_id, role, teams:team_id(*)')
      .eq('user_id', user.id)
      .limit(1)
      .maybeSingle(),
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
        }}
      >
        <AgentSheetProvider>
          <CompanyTabSync />
          <div className="min-h-screen bg-background">
            <DashboardNav
              companyName={getBranding().appName.toLowerCase()}
              entityType="enskild_firma"
              uncategorizedTransactionCount={0}
              pendingOperationsCount={0}
              isSandbox={false}
              extensionNavItems={getExtensionNavItems()}
            />
            <main
              id="main-content"
              className="safe-area-main-padding md:!pb-0 md:pl-64"
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

  // Fetch company + membership for context provider, together with the
  // nav/badge data, none of these depend on each other, only on
  // companyId/user.id, so one round-trip batch instead of two. The rare
  // stale-cookie early return below wastes the extra reads; that's cheaper
  // than serializing two batches on every dashboard render.
  const [
    { data: companyRow },
    { data: memberRow },
    { data: allMemberships },
    { data: settings },
    uncategorizedCount,
    pendingOpsCount,
    { data: agentProfileIdentity },
    { data: userProfile },
    entitlements,
    { data: allSettingsNames },
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).single(),
    supabase.from('company_members').select('role').eq('company_id', companyId).eq('user_id', user.id).single(),
    supabase.from('company_members').select('company_id, role, companies:company_id(id, name, org_number, entity_type, accounting_framework, created_by, team_id, archived_at, created_at, updated_at)').eq('user_id', user.id),
    supabase
      .from('company_settings')
      .select('company_name, onboarding_complete, entity_type, pays_salaries, is_sandbox, dimensions_enabled')
      .eq('company_id', companyId)
      .single(),
    // Shared worklist predicates (lib/worklist), the badge must show the
    // same number as every other "att göra" surface. Notably this excludes
    // is_ignored rows, which the old inline query here did not.
    countUnbookedTransactions(supabase, companyId),
    countPendingOperations(supabase, companyId),
    // Agent identity, name + avatar, surfaced on the FAB and chat
    // surfaces. Null when no agent_profile exists yet (banner CTA path).
    supabase
      .from('agent_profiles')
      .select('display_name, avatar_id, verified_at')
      .eq('company_id', companyId)
      .maybeSingle(),
    // The signed-in user's profile, shown in the bottom-left account
    // popover (full_name + initial) so it's clear which user is logged
    // in, distinct from the active company shown at the top.
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
    getCompanyEntitlements(supabase, companyId),
    // Current display names for ALL the user's companies (the switcher list).
    // RLS scopes company_settings SELECT to user_company_ids(), so this bare
    // select returns exactly the caller's companies, letting non-active rows
    // show company_settings.company_name instead of the frozen companies.name.
    supabase.from('company_settings').select('company_id, company_name'),
  ])

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
    }

    return (
      <CompanyProvider value={companyContextValue}>
        <AgentSheetProvider>
          <CompanyTabSync />
          <div className="min-h-screen bg-background">
            <DashboardNav
              companyName={getBranding().appName.toLowerCase()}
              entityType="enskild_firma"
              uncategorizedTransactionCount={0}
              pendingOperationsCount={0}
              isSandbox={false}
              extensionNavItems={getExtensionNavItems()}
            />
            <main id="main-content" className="safe-area-main-padding md:!pb-0 md:pl-64" role="main">
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
  const companyWithName = {
    ...companyRow,
    name: displayName,
    entity_type: entityType,
    pays_salaries: paysSalaries,
  }

  const isSandbox = settings?.is_sandbox === true

  // Backfill a verified agent_profile for sandbox sessions that pre-date the
  // seed change. Without this an old anonymous session shows the "Bygg din
  // bokföringsassistent" CTA in three places (dashboard hero, NewUserChecklist
  // step 4, /chat layout redirect) and the user can still kick off a build
  // flow that the server now 403s. Best-effort; doesn't block the layout
  // even if the insert fails.
  let resolvedAgentIdentity = agentProfileIdentity
  if (isSandbox && !agentProfileIdentity?.verified_at) {
    await ensureSandboxAgentProfile(supabase, companyId)
    const { data: refreshed } = await supabase
      .from('agent_profiles')
      .select('display_name, avatar_id, verified_at')
      .eq('company_id', companyId)
      .maybeSingle()
    resolvedAgentIdentity = refreshed ?? agentProfileIdentity
  }

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
  }

  return (
    <CompanyProvider value={companyContextValue}>
      <AgentSheetProvider
        identity={{
          displayName: resolvedAgentIdentity?.display_name ?? null,
          avatarId: resolvedAgentIdentity?.avatar_id ?? null,
          isVerified: Boolean(resolvedAgentIdentity?.verified_at),
        }}
      >
        <CompanyTabSync />
        <div className="min-h-screen bg-background">
          {/* Skip to content link for keyboard/screen reader users */}
          <a
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
            uncategorizedTransactionCount={uncategorizedCount}
            pendingOperationsCount={pendingOpsCount}
            isSandbox={isSandbox}
            extensionNavItems={getExtensionNavItems()}
            userName={userProfile?.full_name ?? null}
            userEmail={user.email ?? null}
          />
          <main id="main-content" className="safe-area-main-padding md:!pb-0 md:pl-64" role="main">
            <MainContainer companyId={companyId}>{children}</MainContainer>
          </main>
          <AgentTrigger />
          <CommandPalette />
          <SettingsHotkey />
          {settingsModal}
        </div>
        {!isSandbox && (
          <RecaptIdentify
            userId={user.id}
            email={user.email}
            displayName={settings?.company_name || undefined}
          />
        )}
      </AgentSheetProvider>
    </CompanyProvider>
  )
}
