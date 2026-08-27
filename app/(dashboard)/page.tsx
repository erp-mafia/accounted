import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { ChecklistSkeleton, PanesSkeleton } from '@/components/dashboard/HemSkeletons'
import { COMPANY_PICKED_COOKIE } from '@/lib/company/context'
import { isCockpitLandingRole } from '@/lib/company/home-domain'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardSettings,
  getDashboardTeamMemberships,
  getResolvedDashboardAgentProfile,
} from './request-context'
import { HemChecklistSection, HemNoticesSection, HemPanesSection } from './hem-sections'

export const dynamic = 'force-dynamic'

// Home route = Hem (concept scene 14): greeting + Att göra + Fortsätt.
// The KPI/revenue/deadline widgets left the page (founder direction,
// dev_docs/last_session_resume.md §8), which also pruned their fetches:
// the journal-line YTD aggregation, unpaid-invoice totals and deadline
// queries are gone and the page got faster.
//
// Streaming: the page itself awaits only what the greeting shell and the
// redirects need (settings, profile, agent profile, the Skatteverket flag).
// The notice line, the setup checklist and the Att göra + Fortsätt panes are
// async server components behind their own <Suspense> (hem-sections.tsx),
// so ~30 queries fill three blocks in as they land instead of holding the
// whole page behind the slowest one. RSC streaming applies to client
// navigations too, not only hard loads.

export default async function DashboardPage() {
  const [{ supabase, user }, companyId] = await Promise.all([
    getDashboardAuthContext(),
    getDashboardCompanyId(),
  ])

  if (!user) {
    redirect('/login')
  }

  if (!companyId) {
    redirect('/onboarding')
  }

  // Byrå landing: byrå owners/admins home to the cockpit, not to an
  // auto-resolved client company. Role-gated 2026-08-27 (superseding the
  // 2026-08-05 all-members widening): plain members land like regular users
  // and open the cockpit from the nav when they want it; the middleware's
  // zero-company steer stays ungated since a member with no client companies
  // has nowhere else to land. companyId above can be the middleware's
  // fallback (which it also writes back to user_preferences, so the DB can't
  // tell picked from auto-picked); the session cookie stamped by
  // setActiveCompany is the explicit-choice signal. Once they enter a client
  // this session, "/" is that company's Hem again. Memberships are
  // request-cached and shared with the layout.
  const [cookieStore, teamMemberships] = await Promise.all([
    cookies(),
    getDashboardTeamMemberships(),
  ])
  if (!cookieStore.has(COMPANY_PICKED_COOKIE)) {
    if (
      teamMemberships.some(
        (m) => m.teams?.kind === 'byra' && isCockpitLandingRole(m.role),
      )
    ) {
      redirect('/byra')
    }
  }

  const now = new Date()

  const [settingsRes, { data: profile }, agentProfile, { count: skatteverketTokenCount }] =
    await Promise.all([
      getDashboardSettings(),
      // First name for the greeting.
      supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
      getResolvedDashboardAgentProfile(),
      // The Skatteverket promo below the panes needs this flag in the shell;
      // the checklist section reads it again for its own step (cheap head count).
      supabase.from('skatteverket_tokens').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('company_id', companyId),
    ])

  // A FAILED settings read must not masquerade as "onboarding not done":
  // that sent fully onboarded users back to the wizard on a transient query
  // failure (issue #1053). Throw to the error boundary (retryable) and only
  // redirect on a genuinely incomplete or missing settings row.
  const { data: settings, error: settingsError } = settingsRes
  if (settingsError) {
    throw new Error(`company_settings fetch failed: ${settingsError.message}`)
  }

  // If onboarding is not complete, redirect to onboarding
  if (!settings?.onboarding_complete) {
    redirect('/onboarding')
  }

  const agentBuilt = Boolean(agentProfile?.verified_at)
  const userFirstName = profile?.full_name?.trim().split(/\s+/)[0] ?? null
  const initialSetup = {
    path: settings.initial_setup_path ?? null,
    completedAt: settings.initial_setup_completed_at ?? null,
    dismissedAt: settings.initial_setup_dismissed_at ?? null,
  }
  const setupOpen = !settings.initial_setup_completed_at && !settings.initial_setup_dismissed_at

  return (
    <DashboardContent
      companyId={companyId}
      agentBuilt={agentBuilt}
      userFirstName={userFirstName}
      initialSetup={initialSetup}
      hasSkatteverketConnected={(skatteverketTokenCount || 0) > 0}
      notices={
        <Suspense fallback={null}>
          <HemNoticesSection companyId={companyId} userId={user.id} now={now} />
        </Suspense>
      }
      checklist={
        <Suspense fallback={<ChecklistSkeleton />}>
          <HemChecklistSection
            companyId={companyId}
            userId={user.id}
            now={now}
            initialSetup={initialSetup}
            agentBuilt={agentBuilt}
            vatRegistered={settings.vat_registered}
            momsPeriod={settings.moms_period ?? null}
          />
        </Suspense>
      }
      panes={
        <Suspense fallback={<PanesSkeleton />}>
          <HemPanesSection companyId={companyId} now={now} setupOpen={setupOpen} />
        </Suspense>
      }
    />
  )
}
