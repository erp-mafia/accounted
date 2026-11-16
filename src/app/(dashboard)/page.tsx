import { randomUUID } from 'node:crypto'
import { Suspense } from 'react'
import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { ChecklistSkeleton, PanesSkeleton } from '@/components/dashboard/HemSkeletons'
import { AgentPromo } from '@/components/dashboard/AgentPromo'
import { HemDone } from '@/components/dashboard/HemDone'
import { HEM_ACTION_SLOT_ID } from '@/components/dashboard/hem-slot'
import { parseHemView } from '@/components/dashboard/need-model'
import { RefreshWhenRestored } from '@/components/system/RefreshWhenRestored'
import { COMPANY_PICKED_COOKIE } from '@/lib/company/context'
import { hasSkatteverketOmbudReadAccess } from '@/lib/skatteverket/ombud-access'
import { isCockpitLandingRole } from '@/lib/company/home-domain'
import { decideHemGate } from '@/lib/onboarding/hem-gate'
import { readAiConnection, readFirstTaskClient } from '@/lib/onboarding/ai-clients.server'
import { createServiceClient } from '@/lib/supabase/server'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardSettings,
  getDashboardTeamMemberships,
  getResolvedDashboardAgentProfile,
  redirectInvoicerOffPage,
} from './request-context'
import { HemChecklistSection, HemNoticesSection, HemPanesSection } from './hem-sections'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { getTranslations } from 'next-intl/server'

export const dynamic = 'force-dynamic'

// Home route = Hem (concept scene 14): greeting + Att göra + Fortsätt.
// The KPI/revenue/deadline widgets left the page (founder direction),
// which also pruned their fetches:
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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ vy?: string | string[]; steg?: string | string[] }>
} = {}) {
  const query = (await searchParams) ?? {}
  const vy = parseHemView(query.vy)
  const initialStep = (Array.isArray(query.steg) ? query.steg[0] : query.steg) ?? null
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
    // An invoicer goes to the invoices before any Hem read below: the
    // database does not count the role as a member, so each of them would be
    // refused and logged. The layout's own redirect does not stop this page
    // rendering beside it.
    redirectInvoicerOffPage(),
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

  // Service role for the agent-connection read below: api_keys' SELECT
  // policy is company_id IN user_company_ids() (20260330130000), so through
  // the user client a key minted companyless (company_id NULL, the connect-
  // before-signup flow) or bound to a company the user has since archived or
  // left is invisible, and the agent would read as not connected for exactly
  // the user who just connected. The query filters on user_id explicitly,
  // so no other user's rows are reachable.
  const serviceClient = await createServiceClient()

  const [
    settingsRes,
    agentProfile,
    { count: skatteverketTokenCount },
    aiConnection,
    skvOmbudReadAccess,
  ] =
    await Promise.all([
      getDashboardSettings(),
      getResolvedDashboardAgentProfile(),
      // The Skatteverket promo below the panes needs this flag in the shell;
      // the checklist section reads it again for its own step (cheap head count).
      // 'id', never '*': the token columns are withheld from end-user roles.
      supabase.from('skatteverket_tokens').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('company_id', companyId).eq('status', 'active'),
      // Is an agent connected (the checklist's connect step and the
      // kopplingar chip), and which of Claude / ChatGPT / Grok it is when
      // known (the Att göra row's AI action): one read, one answer for every
      // surface. Keyed on the user, not the company: the connection follows
      // the person. Throws on a failed read: guessing "not connected" would
      // re-open the connect step for a connected user.
      readAiConnection(serviceClient, user.id),
      // Accounted as ombud counts as connected too (lib/skatteverket/ombud-access.ts).
      hasSkatteverketOmbudReadAccess(companyId),
    ])

  // A key only proves the sign-in. Until an agent has worked, Hem asks for a
  // first task (Kopplingar chip), and that chip is the page's agent prompt.
  const firstTask = await readFirstTaskClient(serviceClient, user.id, aiConnection)

  // A FAILED settings read must not masquerade as "onboarding not done":
  // that sent fully onboarded users back to the wizard on a transient query
  // failure (issue #1053). Throw to the error boundary (retryable) and only
  // redirect on a genuinely incomplete or missing settings row.
  const { data: settings, error: settingsError } = settingsRes
  if (settingsError) {
    throw new Error(`company_settings fetch failed: ${settingsError.message}`)
  }

  // The decision lives in lib/onboarding/hem-gate.ts (pure, unit-tested): a
  // company that never finished onboarding goes to the journey, except a byrå
  // member who did not explicitly pick it this session, who goes to the
  // cockpit. Before the owner/admin landing gate the /byra bounce above
  // shielded every byrå member from this path; this keeps that shield without
  // the gate. A migration-reset replacement is an onboarded company and
  // renders (20260920190800).
  const hemGate = decideHemGate({
    onboardingComplete: settings?.onboarding_complete,
    companyPicked: cookieStore.has(COMPANY_PICKED_COOKIE),
    isByraMember: teamMemberships.some((m) => m.teams?.kind === 'byra'),
  })
  if (hemGate === 'byra') redirect('/byra')
  // `!settings` cannot be true once the gate says 'render' (a missing row
  // reads as not onboarded); it is here to narrow the type for the code below.
  if (hemGate === 'onboarding' || !settings) redirect('/onboarding')

  const agentBuilt = Boolean(agentProfile?.verified_at)
  const initialSetup = {
    path: settings.initial_setup_path ?? null,
    completedAt: settings.initial_setup_completed_at ?? null,
    dismissedAt: settings.initial_setup_dismissed_at ?? null,
  }
  const setupOpen = !settings.initial_setup_completed_at && !settings.initial_setup_dismissed_at

  // The streamed sections: the notice line and the
  // setup checklist fill in behind their own Suspense boundaries.
  const notices = (
    <Suspense fallback={null}>
      <HemNoticesSection companyId={companyId} userId={user.id} now={now} />
    </Suspense>
  )
  // A completed or dismissed setup renders no checklist (NewUserChecklist
  // returns null from its initial state), so the section is skipped outright:
  // otherwise every onboarded user saw a bordered skeleton box flash in and
  // collapse on each visit, and paid for nine count queries nobody reads.
  const checklist = setupOpen ? (
    <Suspense fallback={<ChecklistSkeleton />}>
      <HemChecklistSection
        companyId={companyId}
        userId={user.id}
        now={now}
        initialSetup={initialSetup}
        hasMcpKey={aiConnection.connected}
        vatRegistered={settings.vat_registered}
        momsPeriod={settings.moms_period ?? null}
      />
    </Suspense>
  ) : null

  // Hem (Att göra V8): the notice line, then the streamed pane, which opens
  // with the date and the headline and carries Kom igång and the assistant
  // prompt right under it. Behöver dig, Börja and Gjort are views of the same
  // page (?vy=), so every count comes from one read.
  //
  // Build-assistant nudge: shown only until the company has a verified
  // agent_profile, after the checklist is dismissed or completed, and once a
  // connected agent has worked (until then the Kopplingar agent chip is the
  // page's agent prompt).
  const agentConnected = aiConnection.connected && !firstTask
  const promo =
    !agentBuilt && agentConnected && (initialSetup.dismissedAt || initialSetup.completedAt) ? (
      <AgentPromo companyId={companyId} />
    ) : null
  const tHem = await getTranslations('hem')
  const hem = (
    <DashboardContent
      notices={vy === 'hem' ? notices : null}
      panes={
        vy === 'gjort' ? (
          <HemDone />
        ) : (
          <Suspense fallback={<PanesSkeleton view={vy} />}>
            <HemPanesSection
              view={vy}
              initialStep={initialStep}
              afterHeadline={
                vy === 'hem' && (checklist || promo) ? (
                  <>
                    {checklist}
                    {promo}
                  </>
                ) : null
              }
              companyId={companyId}
              now={now}
              setupOpen={setupOpen}
              hasSkatteverketConnected={(skatteverketTokenCount || 0) > 0 || skvOmbudReadAccess}
              aiConnection={aiConnection}
              firstTaskClient={firstTask}
            />
          </Suspense>
        )
      }
    />
  )

  // The top bar: the view's title (the menu label), Hem as the parent of the
  // views under it, and the slot the view puts its one primary in.
  const title = vy === 'behover' ? tHem('need_title') : vy === 'borja' ? tHem('borja_title') : vy === 'gjort' ? tHem('done_title') : tHem('title')
  const header = (
    <PageHeader
      title={title}
      parent={vy === 'borja' ? { label: tHem('title'), href: '/' } : undefined}
      help={vy === 'hem' ? <HelpPopover>{tHem('help')}</HelpPopover> : undefined}
      action={vy === 'gjort' ? undefined : <div id={HEM_ACTION_SLOT_ID} className="flex items-center justify-end" />}
    />
  )

  // Att göra is a live worklist: when the client router shows this render
  // again from its cache (back/forward, or a link click within
  // staleTimes.dynamic), it re-renders from the server instead of showing the
  // counts from the earlier visit.
  return (
    <>
      <RefreshWhenRestored renderId={randomUUID()} />
      {header}
      {hem}
    </>
  )
}
