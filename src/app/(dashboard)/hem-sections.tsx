import { after } from 'next/server'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { filterOpenDeadlines } from '@/lib/deadlines/open'
import { formatDate } from '@/lib/utils'
import type { HemView } from '@/components/dashboard/att-gora-views'
import { dueStateOf } from '@/components/dashboard/need-model'
import { countCompletedSieImports, countInboxItems, countTransactions, readActiveBankConnections } from './hem-reads'
import NewUserChecklist from '@/components/onboarding/NewUserChecklist'
import {
  getSkatteverketOmbudAppointment,
  hasSkatteverketOmbudReadAccess,
  isSkatteverketOmbudEnabled,
} from '@/lib/skatteverket/ombud-access'
import AttGoraSection from '@/components/dashboard/AttGoraSection'
import type { AiClient, AiConnection } from '@/lib/onboarding/ai-clients'
import ResumePane from '@/components/dashboard/ResumePane'
import { HemNotices } from '@/components/dashboard/HemNotices'
import {
  getWorklistCounts,
  listAttestedToPayDue,
  listBankSwitchDue,
  listDocumentsToSign,
  listExpensePayoutsDue,
  listPaymentsFailedDue,
  listPaymentsVerificationDue,
  listSkattekontoPaymentDue,
  listSuggestedMatches,
  listSupplierInvoiceAttestsDue,
  listSupplierPayeeChangesDue,
  SUGGESTED_MATCH_SCAN_CAP,
} from '@/lib/worklist'
import { listResumeItems } from '@/lib/worklist/resume'
import { listMissingUnderlagSample } from '@/lib/worklist/missing-underlag'
import { listOpenSuggestions } from '@/lib/suggestions/list'
import { loadGrantReview } from '@/lib/grants/review'
import { getCompanyNotices } from '@/lib/notices'
import type { Notice } from '@/lib/notices/types'
import { expiringBankConnectionsFrom } from '@/lib/notices/categories'
import { RECEIPT_UPLOAD_SOURCES, hasBankFeed, skippedSetupSteps, vatDeadlineLine } from '@/lib/onboarding/checklist'
import { findUnfinishedConnect } from '@/lib/providers/unfinished-connect'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import { createServiceClient } from '@/lib/supabase/server'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { InitialSetupState, MomsPeriod, OnboardingProgress, UserUiState } from '@/types'
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
  return <HemNotices notices={notices.filter((n) => !HEM_NOTICE_SLOT_SKIPS.has(n.category))} />
}

/**
 * Notice categories Hem leaves out of its notice slot. The Skatteverket
 * reconnect has its own places (the Konton row and the Skattekonto page); a
 * line about it over every visit to Att göra was noise (founder feedback
 * 2026-09-09). The bank switch and the expiring consent are Att göra rows
 * (the switch rows and the Bevaka consent row in AttGoraSection), fed by the
 * same computations as the notices (switchStateFor, expiringBankConnectionsFrom),
 * so the row shows in every case the notice would and saying it twice on one
 * page is clutter (convention 6).
 */
const HEM_NOTICE_SLOT_SKIPS: ReadonlySet<Notice['category']> = new Set([
  'skv_disconnected',
  'bank_switch_needed',
  'bank_connection_expiring',
])

export async function HemChecklistSection({
  companyId,
  userId,
  now,
  initialSetup,
  hasMcpKey,
  vatRegistered,
  momsPeriod,
}: {
  companyId: string
  userId: string
  now: Date
  initialSetup: InitialSetupState
  /** An agent is connected: AiConnection.connected (lib/onboarding/ai-clients). */
  hasMcpKey: boolean
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
    unfinishedConnect,
    skvOmbudReadAccess,
    { data: receiptDocuments },
    { data: userPreferences },
    skvOmbudEnabled,
    skvOmbudAppointment,
  ] = await Promise.all([
    supabase.from('customers').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    countTransactions(companyId),
    readActiveBankConnections(companyId),
    countCompletedSieImports(companyId),
    // Skatteverket connections are per (user, company): filtering on user_id
    // alone made a connection on ANY of the user's companies hide the connect
    // nudge on all of them. 'id', never '*': the token columns are withheld
    // from end-user roles.
    supabase.from('skatteverket_tokens').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('company_id', companyId),
    // Any item ever received in the document inbox (email/WhatsApp/upload)
    // marks the receipts checklist step done: same "has ever done X" shape
    // as the other flags above.
    countInboxItems(companyId),
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
      .gte('due_date', todayIsoStockholm(now))
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
    // A provider connect that stalled before the token: the books step
    // offers to retry it or upload a SIE file instead. Service client:
    // provider_consent_tokens has no user policy.
    ENABLED_EXTENSION_IDS.has('arcim-migration')
      ? findUnfinishedConnect(createServiceClient(), companyId, now)
      : Promise.resolve(null),
    // Accounted as ombud also counts as connected: its reads need no
    // personal BankID session (lib/skatteverket/ombud-access.ts).
    hasSkatteverketOmbudReadAccess(companyId),
    // A document a person put in another way (photo or upload onto a
    // transaction, mail, WhatsApp) also means receipts are flowing: the step
    // used to stay open for them while only an inbox item counted.
    supabase
      .from('document_attachments')
      .select('id')
      .eq('company_id', companyId)
      .in('upload_source', [...RECEIPT_UPLOAD_SOURCES])
      .limit(1),
    // The Kom igång steps this user skipped for this company.
    supabase.from('user_preferences').select('ui_state').eq('user_id', userId).maybeSingle(),
    isSkatteverketOmbudEnabled(),
    // Appointed but not yet in Skatteverket's register: the step says it waits.
    getSkatteverketOmbudAppointment(companyId),
  ])

  const connections = (bankConnections ?? []) as BankConnectionRow[]
  const onboardingProgress: OnboardingProgress = {
    hasCustomers: (customerCount || 0) > 0,
    hasInvoices: (invoiceCount || 0) > 0,
    hasBankConnected: hasBankFeed({ activeBankConnections: connections.length, transactionCount: transactionCount || 0 }),
    hasSIEImport: (sieImportCount || 0) > 0,
    hasSkatteverketConnected: (skatteverketTokenCount || 0) > 0 || skvOmbudReadAccess,
    hasInboxItems: (inboxItemCount || 0) > 0 || (receiptDocuments ?? []).length > 0,
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
      skvOmbudEnabled={skvOmbudEnabled}
      skvOmbudWaiting={skvOmbudAppointment.state === 'waiting'}
      hasInboxItems={onboardingProgress.hasInboxItems}
      hasMcpKey={hasMcpKey}
      skippedSteps={skippedSetupSteps(userPreferences?.ui_state as UserUiState | null, companyId)}
      vatLine={vatLine}
      unfinishedConnect={unfinishedConnect ? { provider: unfinishedConnect.provider } : null}
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
  hasSkatteverketConnected,
  aiConnection,
  firstTaskClient,
  view = 'hem',
  initialStep = null,
  afterHeadline,
}: {
  /** Which face of Att göra to draw (AttGoraSection.view). */
  view?: HemView
  /** Börja: the step to open on. */
  initialStep?: string | null
  /** Hem: Kom igång and the assistant prompt, drawn under the headline. */
  afterHeadline?: ReactNode
  companyId: string
  now: Date
  setupOpen: boolean
  hasSkatteverketConnected: boolean
  /** See AttGoraSection.aiConnection. */
  aiConnection: AiConnection
  /** See AttGoraSection.firstTaskClient. */
  firstTaskClient: AiClient | null
}) {
  const { supabase, user } = await getDashboardAuthContext()
  // Fetched once at the scan cap: the worklist count is the list's length,
  // which the Att göra suggested-matches row shows. Everything else runs in
  // the same wave.
  const suggestedMatchesPromise = listSuggestedMatches(supabase, companyId, SUGGESTED_MATCH_SCAN_CAP)
  // Same pattern for people owed for utlägg: Hem renders one row per person
  // and the worklist count is the list's length.
  const expensePayoutsPromise = listExpensePayoutsDue(supabase, companyId)
  // And for the next uncovered skattekonto charge: Hem renders the Betala
  // row with amount, bankgiro and OCR; the worklist count is 1 or 0 from it.
  const skattekontoPaymentPromise = listSkattekontoPaymentDue(supabase, companyId)
  // And once more for the missing underlag: Hem renders what the biggest ones
  // need fetching from as the row's detail line, and the worklist count is the
  // total from the same RPC call rather than a second one at p_limit 1.
  const missingUnderlagPromise = listMissingUnderlagSample(supabase, companyId)
  // And for the bank connections still to switch to Open Payments: Hem
  // renders one row per connection with its deep link; the count is the
  // list's length.
  const bankSwitchPromise = listBankSwitchDue(supabase, companyId, now)
  // And for the payments verification to renew: Hem renders it as one row
  // with the days left; the count is 1 or 0 from the same read.
  const paymentsVerificationPromise = listPaymentsVerificationDue(supabase, companyId, now)
  // And the invoices waiting for this person's attest under the attest
  // policy: one row each, a per-person view of the company's attest count.
  const attestsDuePromise = user ? listSupplierInvoiceAttestsDue(supabase, companyId, user.id) : Promise.resolve([])
  // And the documents waiting for this person's BankID signature: one row
  // each, the count is the list's length.
  const documentsToSignPromise = user ? listDocumentsToSign(supabase, companyId, user.id, now) : Promise.resolve([])
  // And for supplier invoices with bank details nobody approved: one row per
  // invoice, the count is the list's length.
  const supplierPayeeChangesPromise = listSupplierPayeeChangesDue(supabase, companyId)
  // And for supplier invoices whose bank payment did not go through: one row
  // per invoice, the count is the list's length.
  const paymentsFailedPromise = listPaymentsFailedDue(supabase, companyId)
  // And the supplier invoices that wait to be paid: one Betala row, without
  // the ones the failed-payment rows above already show.
  const attestedToPayPromise = listAttestedToPayDue(supabase, companyId, { paymentsFailed: paymentsFailedPromise })
  // And the open suggestions: one Förslag card each (at most three); the
  // count is the list's length.
  const openSuggestionsPromise = listOpenSuggestions(supabase, companyId)
  // And what the company's rules for automatic booking let through since the
  // last review (one indexed probe for a company that never had a rule), with
  // the agent that booked each posting.
  const grantReviewPromise = loadGrantReview(supabase, companyId, { withAgents: true })
  // Whether the company has one posted entry: asked as "is there one", never
  // "how many" (the exact count walked every verifikat of the company on each
  // Hem load: 154 000 for the largest, 230 ms). Two places read it, each only
  // in the one state it matters in.
  const firstPostedEntry = () =>
    supabase.from('journal_entries').select('id').eq('company_id', companyId).in('status', ['posted', 'reversed']).limit(1)
  const [
    worklist,
    expensePayouts,
    skattekontoPayment,
    missingUnderlag,
    bankSwitches,
    paymentsVerification,
    supplierPayeeChanges,
    openSuggestions,
    grantReview,
    resumeItems,
    bankConnectionsRes,
    postedEntries,
    attestsDue,
    suggestedMatches,
    documentsToSign,
    paymentsFailed,
    attestedToPay,
    nextDeadlineRes,
  ] =
    await Promise.all([
      // Pending-work counts come from lib/worklist: the same source as the
      // sidebar badges, so the numbers can never diverge.
      getWorklistCounts(supabase, companyId, {
        suggestedMatches: suggestedMatchesPromise,
        expensePayoutsDue: expensePayoutsPromise,
        skattekontoPaymentDue: skattekontoPaymentPromise,
        missingUnderlag: missingUnderlagPromise,
        bankSwitchDue: bankSwitchPromise,
        paymentsVerificationDue: paymentsVerificationPromise,
        supplierPayeeChangesDue: supplierPayeeChangesPromise,
        paymentsFailedDue: paymentsFailedPromise,
        openSuggestions: openSuggestionsPromise,
        documentsToSign: documentsToSignPromise,
        attestedToPayDue: attestedToPayPromise,
      }),
      expensePayoutsPromise,
      skattekontoPaymentPromise,
      missingUnderlagPromise,
      bankSwitchPromise,
      paymentsVerificationPromise,
      supplierPayeeChangesPromise,
      openSuggestionsPromise,
      grantReviewPromise,
      // In-progress work for the Fortsätt pane: pure draft-state derivation.
      listResumeItems(supabase, companyId, now),
      supabase.from('bank_connections').select('id, status, consent_expires, bank_name, last_sie_sweep').eq('company_id', companyId).eq('status', 'active'),
      // One posted entry distinguishes "brand-new empty ledger" from "all
      // caught up" in the Att göra empty state, read only while the setup
      // checklist is open.
      setupOpen ? firstPostedEntry() : null,
      attestsDuePromise,
      // The several-invoice payments among them get rows of their own.
      suggestedMatchesPromise,
      documentsToSignPromise,
      paymentsFailedPromise,
      attestedToPayPromise,
      // Hem's glance line: the next open deadline from today on (the same
      // rows /deadlines lists; its stored title is shown as it is there).
      view === 'hem'
        ? filterOpenDeadlines(
            supabase.from('deadlines').select('title, due_date').eq('company_id', companyId),
          )
            .gte('due_date', todayIsoStockholm(now))
            .order('due_date', { ascending: true })
            .limit(1)
            .maybeSingle()
        : null,
    ])

  // "Empty ledger" only matters while the setup checklist is still open; once
  // it is completed or dismissed the ordinary all-clear copy applies. A failed
  // count must NOT read as empty: that would tell a company with real
  // bookkeeping that its ledger is blank, so errors degrade to the normal copy.
  const emptyLedger = !!postedEntries && !postedEntries.error && (postedEntries.data ?? []).length === 0

  const bankConnections = bankConnectionsRes.data
  // Same degrade-on-error rule as emptyLedger: a failed fetch must NOT tell a
  // connected company that no bank is connected, so errors read as connected.
  const hasActiveBankConnection = !!bankConnectionsRes.error || (bankConnections ?? []).length > 0

  // Once the getting-started steps are closed, an empty list on an empty
  // ledger with no bank row on its way is not "all done": finishing the books
  // act without a bank lands exactly here. Asked only for that company (no
  // posted entry, no active connection), so nobody else pays for the count,
  // and a failed read keeps the ordinary copy, as above. The list above asks
  // for a posted entry only while the checklist is open, so a company with a
  // closed checklist and no active connection asks for it here (one row).
  let noBankFeed = false
  if (!setupOpen && !hasActiveBankConnection) {
    const posted = await firstPostedEntry()
    if (!posted.error && (posted.data ?? []).length === 0) {
      const { count: transactionCount, error: transactionCountError } = await countTransactions(companyId)
      noBankFeed = !transactionCountError && !hasBankFeed({ activeBankConnections: 0, transactionCount: transactionCount || 0 })
    }
  }

  // Same day-math as the bank_connection_expiring notice predicate
  // (lib/notices/categories.ts): the Bevaka row and the notice can never
  // disagree on the threshold.
  const expiringBankConnections = expiringBankConnectionsFrom(
    (bankConnections ?? []) as BankConnectionRow[],
    now,
  )

  // The Skatteverket chip only shows for a company that is not connected, and
  // says "väntar på Skatteverket" while the register has not listed its grant.
  const skvOmbudEnabled = await isSkatteverketOmbudEnabled()
  const skvOmbudWaiting =
    skvOmbudEnabled &&
    !setupOpen &&
    !hasSkatteverketConnected &&
    (await getSkatteverketOmbudAppointment(companyId)).state === 'waiting'

  const tHem = await getTranslations('hem')
  // A failed read leaves the line out: no deadline is not the same as none found.
  const nextDeadline = nextDeadlineRes && !nextDeadlineRes.error ? nextDeadlineRes.data : null
  // Due today or tomorrow is said in words (the row's own state); any other day is its date.
  const nextDeadlineState = nextDeadline ? dueStateOf(nextDeadline.due_date, todayIsoStockholm(now)) : null
  const facts = nextDeadline ? (
    <p className="mt-1.5 text-[13px] text-muted-foreground">
      {/* The label never breaks in two; on a narrow screen the deadline wraps under it as one piece. */}
      <Link href="/deadlines" className="group inline-flex min-h-7 flex-wrap items-baseline gap-x-1.5 py-1">
        <span className="whitespace-nowrap">{tHem('next_deadline')}</span>
        <span className="font-medium text-strong group-hover:underline group-hover:underline-offset-[3px]">
          {nextDeadlineState === 'today' ? (
            tHem('next_deadline_today')
          ) : nextDeadlineState === 'tomorrow' ? (
            tHem('next_deadline_tomorrow')
          ) : (
            <span className="date-figures">{formatDate(nextDeadline.due_date)}</span>
          )}
          , {nextDeadline.title}
        </span>
      </Link>
    </p>
  ) : null

  return (
    <AttGoraSection
      view={view}
      initialStep={initialStep}
      todayIso={todayIsoStockholm(now)}
      afterHeadline={afterHeadline}
      facts={facts}
      resume={view === 'borja' ? null : <ResumePane items={resumeItems} />}
      worklist={worklist}
      expensePayouts={expensePayouts}
      attestsDue={attestsDue}
      documentsToSign={documentsToSign}
      skattekontoPayment={skattekontoPayment}
      attestedToPay={attestedToPay}
      missingUnderlag={missingUnderlag}
      bankSwitches={bankSwitches}
      paymentsVerification={paymentsVerification}
      supplierPayeeChanges={supplierPayeeChanges}
      paymentsFailed={paymentsFailed}
      invoiceSets={suggestedMatches.filter((m) => (m.allocations?.length ?? 0) > 0)}
      suggestions={openSuggestions}
      grantReview={grantReview}
      expiringBankConnections={expiringBankConnections}
      emptyLedger={emptyLedger}
      noBankFeed={noBankFeed}
      hasActiveBankConnection={hasActiveBankConnection}
      hasSkatteverketConnection={hasSkatteverketConnected}
      skvOmbudEnabled={skvOmbudEnabled}
      skvOmbudWaiting={skvOmbudWaiting}
      aiConnection={aiConnection}
      firstTaskClient={firstTaskClient}
      // While the getting-started checklist is open it carries the bank
      // and Skatteverket steps itself; afterwards the kopplingar row keeps
      // the connections visible for whoever declined them in the books act.
      showKopplingar={!setupOpen}
    />
  )
}
