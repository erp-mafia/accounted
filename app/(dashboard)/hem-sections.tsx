import { after } from 'next/server'
import NewUserChecklist from '@/components/onboarding/NewUserChecklist'
import AttGoraSection from '@/components/dashboard/AttGoraSection'
import ResumePane from '@/components/dashboard/ResumePane'
import { HemNotices } from '@/components/dashboard/HemNotices'
import { getWorklistCounts, listSuggestedMatches, SUGGESTED_MATCH_SCAN_CAP } from '@/lib/worklist'
import { listResumeItems } from '@/lib/worklist/resume'
import { getCompanyNotices } from '@/lib/notices'
import { expiringBankConnectionsFrom } from '@/lib/notices/categories'
import { vatDeadlineLine } from '@/lib/onboarding/checklist'
import type { InitialSetupState, MomsPeriod, OnboardingProgress } from '@/types'
import { getDashboardAuthContext } from './request-context'

/**
 * Hem's streamed sections. Each is an async server component rendered behind
 * its own <Suspense> in page.tsx, so the greeting shell paints as soon as the
 * page's small first wave resolves and each block fills in when its own
 * queries land. The Supabase client comes from the request-cached auth
 * context, never from props (not serialisable).
 */

type BankConnectionRow = {
  id: string
  status: string
  consent_expires: string | null
  bank_name: string
  last_sie_sweep: unknown
}

type SieSweepSummaryLite = {
  auto_linked?: number
  suggested?: number
  unmatched?: number
  errors?: number
  ran_at?: string
}

export async function HemNoticesSection({
  companyId,
  userId,
  now,
}: {
  companyId: string
  userId: string
  now: Date
}) {
  const { supabase } = await getDashboardAuthContext()
  // Degraded-state notices (lib/notices): broken/expiring bank connections,
  // Skatteverket reconnect, failing backups, the wrong-account hint (#1231),
  // priority-ordered and dismissal-filtered. The stale-dismissal reap is
  // hygiene and runs after the response (Next `after`), not on the read path.
  const notices = await getCompanyNotices(supabase, companyId, {
    userId,
    now,
    deferReap: (task) => after(task),
  })
  return <HemNotices notices={notices} />
}

export async function HemChecklistSection({
  companyId,
  userId,
  now,
  initialSetup,
  agentBuilt,
  vatRegistered,
  momsPeriod,
}: {
  companyId: string
  userId: string
  now: Date
  initialSetup: InitialSetupState
  agentBuilt: boolean
  vatRegistered: boolean
  momsPeriod: MomsPeriod | null
}) {
  const { supabase } = await getDashboardAuthContext()
  const [
    { count: customerCount },
    { count: invoiceCount },
    { count: transactionCount },
    { data: bankConnections },
    { count: sieImportCount },
    { count: skatteverketTokenCount },
    { count: inboxItemCount },
    { data: nextVatDeadline },
    { data: latestFileSweep },
  ] = await Promise.all([
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('bank_connections').select('id, status, consent_expires, bank_name, last_sie_sweep').eq('company_id', companyId).eq('status', 'active'),
    supabase.from('sie_imports').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'completed'),
    // Skatteverket connections are per (user, company): filtering on user_id
    // alone made a connection on ANY of the user's companies hide the connect
    // nudge on all of them.
    supabase.from('skatteverket_tokens').select('*', { count: 'exact', head: true }).eq('user_id', userId).eq('company_id', companyId),
    // Any item ever received in the document inbox (email/WhatsApp/upload)
    // marks the receipts checklist step done: same "has ever done X" shape
    // as the other flags above.
    supabase.from('invoice_inbox_items').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
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
    // Latest bank-file SIE sweep (PSD2 sync stamps bank_connections.last_sie_sweep
    // instead). Feeds the checklist's bank step with "X matchade, Y att
    // granska". Best-effort: absent rows just render no note.
    supabase
      .from('bank_file_imports')
      .select('sie_sweep')
      .eq('company_id', companyId)
      .not('sie_sweep', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const connections = (bankConnections ?? []) as BankConnectionRow[]
  const onboardingProgress: OnboardingProgress = {
    hasCustomers: (customerCount || 0) > 0,
    hasInvoices: (invoiceCount || 0) > 0,
    hasBankConnected: connections.length > 0 || (transactionCount || 0) > 0,
    hasSIEImport: (sieImportCount || 0) > 0,
    hasSkatteverketConnected: (skatteverketTokenCount || 0) > 0,
    hasInboxItems: (inboxItemCount || 0) > 0,
  }

  const vatLine = vatDeadlineLine({
    vatRegistered,
    momsPeriod,
    nextVatDueDate: nextVatDeadline?.due_date ?? null,
  })

  const sweepCandidates: SieSweepSummaryLite[] = [
    ...connections
      .map((c) => c.last_sie_sweep as SieSweepSummaryLite | null)
      .filter((s): s is SieSweepSummaryLite => Boolean(s)),
    ...(latestFileSweep?.sie_sweep ? [latestFileSweep.sie_sweep as SieSweepSummaryLite] : []),
  ]
  const sieSweep =
    sweepCandidates.length > 0
      ? sweepCandidates.reduce((a, b) => ((a.ran_at ?? '') >= (b.ran_at ?? '') ? a : b))
      : null

  return (
    <NewUserChecklist
      initialState={initialSetup}
      hasBookkeepingImported={onboardingProgress.hasSIEImport}
      hasBankConnected={onboardingProgress.hasBankConnected}
      hasSkatteverketConnected={onboardingProgress.hasSkatteverketConnected}
      hasInboxItems={onboardingProgress.hasInboxItems}
      hasAgentBuilt={agentBuilt}
      vatLine={vatLine}
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

export async function HemPanesSection({
  companyId,
  now,
  setupOpen,
}: {
  companyId: string
  now: Date
  setupOpen: boolean
}) {
  const { supabase } = await getDashboardAuthContext()
  // Fetched once at the scan cap: the Att göra pane shows the first five and
  // the worklist count is the list's length (it used to scan the same rows
  // twice). Everything else runs in the same wave.
  const suggestedMatchesPromise = listSuggestedMatches(supabase, companyId, SUGGESTED_MATCH_SCAN_CAP)
  const [worklist, suggestedMatches, resumeItems, bankConnectionsRes, postedEntries] =
    await Promise.all([
      // Pending-work counts come from lib/worklist: the same source as the
      // sidebar badges, so the numbers can never diverge.
      getWorklistCounts(supabase, companyId, { suggestedMatches: suggestedMatchesPromise }),
      suggestedMatchesPromise,
      // In-progress work for the Fortsätt pane: pure draft-state derivation.
      listResumeItems(supabase, companyId, now),
      supabase.from('bank_connections').select('id, status, consent_expires, bank_name, last_sie_sweep').eq('company_id', companyId).eq('status', 'active'),
      // Posted entries distinguish "brand-new empty ledger" from "all caught
      // up" in the Att göra empty state (hits the partial posted/reversed index).
      supabase.from('journal_entries').select('*', { count: 'exact', head: true }).eq('company_id', companyId).in('status', ['posted', 'reversed']),
    ])

  // "Empty ledger" only matters while the setup checklist is still open; once
  // it is completed or dismissed the ordinary all-clear copy applies. A failed
  // count must NOT read as empty: that would tell a company with real
  // bookkeeping that its ledger is blank, so errors degrade to the normal copy.
  const emptyLedger = setupOpen && !postedEntries.error && (postedEntries.count || 0) === 0

  const bankConnections = bankConnectionsRes.data
  // Same degrade-on-error rule as emptyLedger: a failed fetch must NOT tell a
  // connected company that no bank is connected, so errors read as connected.
  const hasActiveBankConnection = !!bankConnectionsRes.error || (bankConnections ?? []).length > 0

  // Same day-math as the bank_connection_expiring notice predicate
  // (lib/notices/categories.ts): the Bevaka row and the notice can never
  // disagree on the threshold.
  const expiringBankConnections = expiringBankConnectionsFrom(
    (bankConnections ?? []) as BankConnectionRow[],
    now,
  )

  return (
    <div className={resumeItems.length > 0 ? 'grid items-start gap-x-6 gap-y-8 md:grid-cols-2' : undefined}>
      <AttGoraSection
        worklist={worklist}
        suggestedMatches={suggestedMatches.slice(0, 5)}
        expiringBankConnections={expiringBankConnections}
        emptyLedger={emptyLedger}
        hasActiveBankConnection={hasActiveBankConnection}
      />
      <ResumePane items={resumeItems} />
    </div>
  )
}
