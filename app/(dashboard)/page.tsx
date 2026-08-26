import { redirect } from 'next/navigation'
import { cookies } from 'next/headers'
import DashboardContent from '@/components/dashboard/DashboardContent'
import { getWorklistCounts, listSuggestedMatches } from '@/lib/worklist'
import { listResumeItems } from '@/lib/worklist/resume'
import { COMPANY_PICKED_COOKIE } from '@/lib/company/context'
import { getCompanyNotices } from '@/lib/notices'
import { expiringBankConnectionsFrom } from '@/lib/notices/categories'
import { vatDeadlineLine } from '@/lib/onboarding/checklist'
import type { OnboardingProgress } from '@/types'
import {
  getDashboardAuthContext,
  getDashboardCompanyId,
  getDashboardSettings,
  getDashboardTeamMemberships,
  getResolvedDashboardAgentProfile,
} from './request-context'

export const dynamic = 'force-dynamic'

// Home route = Hem (concept scene 14): greeting + Att göra + Fortsätt.
// The KPI/revenue/deadline widgets left the page (founder direction,
// dev_docs/last_session_resume.md §8), which also pruned their fetches:
// the journal-line YTD aggregation, unpaid-invoice totals and deadline
// queries are gone and the page got faster.

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

  // Byrå landing: every byrå team member (owner, admin AND member: widened
  // from owner/admin on the founder's call 2026-08-05, so invited consultants
  // land right too) homes to the cockpit, not to an auto-resolved client
  // company. companyId above can be the middleware's first-membership
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
    if (teamMemberships.some((m) => m.teams?.kind === 'byra')) {
      redirect('/byra')
    }
  }

  const now = new Date()

  // Fetch all data in parallel
  const [
    settingsRes,
    { count: customerCount },
    { count: invoiceCount },
    { count: transactionCount },
    { data: bankConnections },
    { count: sieImportCount },
    { count: skatteverketTokenCount },
    { count: inboxItemCount },
    { count: postedEntryCount, error: postedEntryError },
    { data: nextVatDeadline },
    { data: profile },
    agentProfile,
    worklist,
    suggestedMatches,
    resumeItems,
    notices,
  ] = await Promise.all([
    getDashboardSettings(),
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('bank_connections').select('id, status, consent_expires, bank_name, last_sie_sweep').eq('company_id', companyId).eq('status', 'active'),
    supabase.from('sie_imports').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'completed'),
    // Skatteverket connections are per (user, company): filtering on user_id
    // alone made a connection on ANY of the user's companies hide the connect
    // nudge on all of them.
    supabase.from('skatteverket_tokens').select('*', { count: 'exact', head: true }).eq('user_id', user.id).eq('company_id', companyId),
    // Any item ever received in the document inbox (email/WhatsApp/upload)
    // marks the receipts checklist step done: same "has ever done X" shape
    // as the other flags above.
    supabase.from('invoice_inbox_items').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    // Posted entries distinguish "brand-new empty ledger" from "all caught
    // up" in the Att göra empty state (hits the partial posted/reversed index).
    supabase.from('journal_entries').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['posted', 'reversed']),
    // Next upcoming momsdeklaration for the checklist's Skatteverket step.
    // Rows are system-generated per company settings; dismissed rows are
    // excluded everywhere deadlines are listed, so here too.
    supabase
      .from('deadlines')
      .select('due_date')
      .eq('company_id', companyId)
      .in('tax_deadline_type', ['moms_monthly', 'moms_quarterly', 'moms_yearly'])
      .eq('is_completed', false)
      .is('dismissed_at', null)
      .gte('due_date', now.toISOString().slice(0, 10))
      .order('due_date', { ascending: true })
      .limit(1)
      .maybeSingle(),
    // First name for the greeting.
    supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle(),
    getResolvedDashboardAgentProfile(),
    // Pending-work counts + suggested matches come from lib/worklist: the
    // same source as the sidebar badges, so the numbers can never diverge.
    getWorklistCounts(supabase, companyId),
    listSuggestedMatches(supabase, companyId, 5),
    // In-progress work for the Fortsätt pane: pure draft-state derivation.
    listResumeItems(supabase, companyId, now),
    // Degraded-state notices (lib/notices): broken/expiring bank
    // connections, Skatteverket reconnect, failing backups, and the
    // wrong-account hint (#1231), priority-ordered and dismissal-filtered.
    getCompanyNotices(supabase, companyId, { userId: user.id, now }),
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

  const onboardingProgress: OnboardingProgress = {
    hasCustomers: (customerCount || 0) > 0,
    hasInvoices: (invoiceCount || 0) > 0,
    hasBankConnected: (bankConnections?.length || 0) > 0 || (transactionCount || 0) > 0,
    hasSIEImport: (sieImportCount || 0) > 0,
    hasSkatteverketConnected: (skatteverketTokenCount || 0) > 0,
    hasInboxItems: (inboxItemCount || 0) > 0,
  }

  const vatLine = vatDeadlineLine({
    vatRegistered: settings.vat_registered,
    momsPeriod: settings.moms_period ?? null,
    nextVatDueDate: nextVatDeadline?.due_date ?? null,
  })

  // "Empty ledger" only matters while the setup checklist is still open; once
  // it is completed or dismissed the ordinary all-clear copy applies. A failed
  // count must NOT read as empty: that would tell a company with real
  // bookkeeping that its ledger is blank, so errors degrade to the normal copy.
  const setupOpen = !settings.initial_setup_completed_at && !settings.initial_setup_dismissed_at
  const emptyLedger = setupOpen && !postedEntryError && (postedEntryCount || 0) === 0

  // Same day-math as the bank_connection_expiring notice predicate
  // (lib/notices/categories.ts): the Bevaka row and the notice can never
  // disagree on the threshold.
  const expiringBankConnections = expiringBankConnectionsFrom(bankConnections || [], now)

  const userFirstName = profile?.full_name?.trim().split(/\s+/)[0] ?? null

  // Latest SIE reconciliation-sweep summary across both history sources
  // (PSD2 sync stamps bank_connections.last_sie_sweep; a bank-file import
  // stamps bank_file_imports.sie_sweep). Feeds the checklist's bank step with
  // "X matchade, Y att granska" so a migrator sees the sweep outcome without
  // hunting for it. Best-effort: absent rows just render no note.
  type SieSweepSummaryLite = {
    auto_linked?: number
    suggested?: number
    unmatched?: number
    errors?: number
    ran_at?: string
  }
  const { data: latestFileSweep } = await supabase
    .from('bank_file_imports')
    .select('sie_sweep')
    .eq('company_id', companyId)
    .not('sie_sweep', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const sweepCandidates: SieSweepSummaryLite[] = [
    ...(bankConnections || [])
      .map((c) => c.last_sie_sweep as SieSweepSummaryLite | null)
      .filter((s): s is SieSweepSummaryLite => Boolean(s)),
    ...(latestFileSweep?.sie_sweep ? [latestFileSweep.sie_sweep as SieSweepSummaryLite] : []),
  ]
  const sieSweep =
    sweepCandidates.length > 0
      ? sweepCandidates.reduce((a, b) => ((a.ran_at ?? '') >= (b.ran_at ?? '') ? a : b))
      : null

  return (
    <DashboardContent
      companyId={companyId}
      agentBuilt={agentBuilt}
      userFirstName={userFirstName}
      expiringBankConnections={expiringBankConnections}
      worklist={worklist}
      suggestedMatches={suggestedMatches}
      resumeItems={resumeItems}
      notices={notices}
      onboardingProgress={onboardingProgress}
      initialSetup={{
        path: settings.initial_setup_path ?? null,
        completedAt: settings.initial_setup_completed_at ?? null,
        dismissedAt: settings.initial_setup_dismissed_at ?? null,
      }}
      vatLine={vatLine}
      emptyLedger={emptyLedger}
      sieSweep={
        sieSweep
          ? {
              auto_linked: sieSweep.auto_linked ?? 0,
              suggested: sieSweep.suggested ?? 0,
              unmatched: sieSweep.unmatched ?? 0,
              errors: sieSweep.errors ?? 0,
            }
          : null
      }
    />
  )
}
