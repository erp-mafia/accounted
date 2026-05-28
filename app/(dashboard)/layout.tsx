import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import DashboardNav from '@/components/dashboard/DashboardNav'
import { MainContainer } from '@/components/dashboard/MainContainer'
import CompanyTabSync from '@/components/dashboard/CompanyTabSync'
import { AgentSheetProvider } from '@/components/agent/AgentSheetProvider'
import AgentTrigger from '@/components/agent/AgentTrigger'
import CommandPalette from '@/components/common/CommandPalette'
import { SandboxBanner } from '@/components/dashboard/SandboxBanner'
import { getExtensionNavItems } from '@/lib/extensions/sectors'
import { CompanyProvider } from '@/contexts/CompanyContext'
import { getActiveCompanyId } from '@/lib/company/context'
import { getBranding } from '@/lib/branding/service'
import type { EntityType, CompanyRole, Team } from '@/types'

/**
 * Routes inside the dashboard group that must remain reachable when the
 * user has no active company. Keep in sync with the middleware's
 * no-company allowlist.
 */
const NO_COMPANY_ALLOWED_PATHS = ['/settings/account']

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // Resolve active company from user_preferences (authoritative). The
  // `gnubok-company-id` cookie is intentionally no longer consulted here —
  // `getActiveCompanyId` reads from user_preferences, matching what RLS
  // sees via `current_active_company_id()`. Keeping both sides on the same
  // source avoids cross-tab / cookie divergence.
  const companyId = await getActiveCompanyId(supabase, user.id)

  // Read the pathname forwarded by middleware so we can branch on it.
  const headerStore = await headers()
  const pathname = headerStore.get('x-pathname') ?? ''
  const isNoCompanyAllowed = NO_COMPANY_ALLOWED_PATHS.some((p) =>
    pathname.startsWith(p)
  )

  // Fetch team membership + team info
  const { data: teamMembership } = await supabase
    .from('team_members')
    .select('team_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle()

  let team: Team | null = null
  if (teamMembership?.team_id) {
    const { data: teamRow } = await supabase
      .from('teams')
      .select('*')
      .eq('id', teamMembership.team_id)
      .single()
    team = teamRow
  }

  const isTeamMember = !!teamMembership

  // No companies — redirect to onboarding, except for allowed escape-hatch
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
          </div>
        </AgentSheetProvider>
      </CompanyProvider>
    )
  }

  // Fetch company + membership for context provider
  const [
    { data: companyRow },
    { data: memberRow },
    { data: allMemberships },
  ] = await Promise.all([
    supabase.from('companies').select('*').eq('id', companyId).single(),
    supabase.from('company_members').select('role').eq('company_id', companyId).eq('user_id', user.id).single(),
    supabase.from('company_members').select('company_id, role, companies:company_id(id, name, org_number, entity_type, accounting_framework, created_by, team_id, archived_at, created_at, updated_at)').eq('user_id', user.id),
  ])

  if (!companyRow || !memberRow) {
    // Stale cookie pointing to a deleted/inaccessible company.
    // Render the empty-state dashboard so user can switch or create a company.
    const companyContextValue = {
      company: null,
      role: null,
      companies: (allMemberships || []).filter(m => m.companies).map((m) => ({
        company: m.companies as unknown as import('@/types').Company,
        role: m.role as CompanyRole,
      })),
      isTeamMember,
      team,
      isSandbox: false,
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
          </div>
        </AgentSheetProvider>
      </CompanyProvider>
    )
  }

  const [
    { data: settings },
    { count: uncategorizedCount },
    { count: pendingOpsCount },
    { data: agentProfileIdentity },
    { data: userProfile },
  ] = await Promise.all([
    supabase
      .from('company_settings')
      .select('company_name, onboarding_complete, entity_type, is_sandbox')
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('transactions')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .is('is_business', null),
    supabase
      .from('pending_operations')
      .select('*', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'pending'),
    // Agent identity — name + avatar — surfaced on the FAB and chat
    // surfaces. Null when no agent_profile exists yet (banner CTA path).
    supabase
      .from('agent_profiles')
      .select('display_name, avatar_id, verified_at')
      .eq('company_id', companyId)
      .maybeSingle(),
    // The signed-in user's profile — shown in the bottom-left account
    // popover (full_name + initial) so it's clear which user is logged
    // in, distinct from the active company shown at the top.
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
  ])

  // If onboarding incomplete, still render the dashboard — the page component
  // will show the inline onboarding card instead of the normal dashboard content.

  // Use company_name from settings as the display name (companies.name may be stale)
  const displayName = settings?.company_name || companyRow.name
  const companyWithName = { ...companyRow, name: displayName }

  const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

  const isSandbox = settings?.is_sandbox === true

  const companyContextValue = {
    company: companyWithName,
    role: memberRow.role as CompanyRole,
    companies: (allMemberships || []).map((m) => {
      const c = m.companies as unknown as import('@/types').Company
      // Override active company's name with settings name
      if (c.id === companyId) {
        return { company: { ...c, name: displayName }, role: m.role as CompanyRole }
      }
      return { company: c, role: m.role as CompanyRole }
    }),
    isTeamMember,
    team,
    isSandbox,
  }

  return (
    <CompanyProvider value={companyContextValue}>
      <AgentSheetProvider
        identity={{
          displayName: agentProfileIdentity?.display_name ?? null,
          avatarId: agentProfileIdentity?.avatar_id ?? null,
          isVerified: Boolean(agentProfileIdentity?.verified_at),
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
            uncategorizedTransactionCount={uncategorizedCount ?? 0}
            pendingOperationsCount={pendingOpsCount ?? 0}
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
        </div>
      </AgentSheetProvider>
    </CompanyProvider>
  )
}
