/**
 * Per-category worklist queries: the single owner of every pending-work
 * predicate. Surfaces (dashboard, sidebar badges, /api/worklist, MCP tools)
 * must call these instead of inlining their own Supabase queries; see
 * lib/worklist/types.ts for each category's pending/done definition.
 *
 * Counts soft-fail to 0 with a logged error: a broken badge must never take
 * down the dashboard layout or the home page.
 */

import {
  OPEN_ROT_RUT_PAYOUT_STATUSES,
  expectedRotRutPayoutAmount,
  isMatchableRotRutPayoutRequest,
} from '@/lib/invoices/rot-rut-payout-matching'
import { loadOpenRotRutPayoutRequests } from '@/lib/invoices/rot-rut-payout-candidates'
import { matchTransactionsToRotRutPayoutSets } from '@/lib/invoices/rot-rut-payout-set-matching'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { supersededTwins, type TwinCandidate } from '@/lib/cash-accounts/twins'
import { toError } from '@/lib/errors/to-error'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { listExpenseClaimsAwaitingPayout } from '@/lib/salary/expense-claim-payout-state'
import { INBOX_ITEM_DOCUMENT_HOLD, isOpenInboxItem, whereInboxItemOpen, withDocumentHold, type DocumentHoldRow } from '@/lib/documents/inbox-item-state'
import {
  groupExpenseClaimsByPerson,
  matchTransactionsToExpensePayouts,
} from '@/lib/expenses/expense-payout-candidates'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
} from '@/lib/bookkeeping/matchable-statuses'
import { matchRowsToInvoiceCombinations, type CombinationInvoice } from '@/lib/transactions/invoice-combination'
import { BANKGIRO_SPLIT_METHOD } from '@/lib/transactions/part-suggestions'
import { todayIsoStockholm, previousMonthEndIso } from '@/lib/dates/iso'
import { filterOverdueInvoices, filterOwedInvoices } from '@/lib/invoices/overdue'
import { summarizeOverdueInvoices } from './overdue-summary'
import { PAYMENT_STATUSES_TO_BOOK, SETTLEMENT_STATUSES_TO_BOOK } from '@/lib/collections/settlements-ui'
import { COLLECTIONS_BATCH_TYPE, collectionWorkCounts, type BatchItem, type BatchRemoval } from '@/lib/collections/batch'
import { DAILY_BATCH_TYPES_FILTER } from '@/lib/pending-operations/daily-batches'
import { readPendingReminderBatch } from '@/lib/reminders/pending-batch'
import { resolveSkattekontoOcr, SKATTEKONTO_BANKGIRO } from '@/lib/skatteverket/skattekonto-ocr'
import { readSkattekontoOpeningDate, whereSkattekontoRowOpen } from '@/lib/skatteverket/skattekonto-open-rows'
import { parseEntityType } from '@/lib/company/entity-type'
import { readCompanyOrgNumber } from '@/lib/company/org-number'
import { listPeppolFailedInvoiceIds } from '@/lib/invoices/peppol-failed-invoices'
import { switchStateFor } from '@/lib/bank-feed/switch-campaign'
import { paymentsAdmitted } from '@/lib/payments/orders/pilot'
import { SKATTEKONTO_PAYMENT_COVER_STATUSES, skattekontoPaymentsCovering, type SkattekontoPaymentOrderCover } from '@/lib/payments/orders/skattekonto-underway'
import { readVerificationRecord } from '@/lib/payments/orders/verification-record'
import { deriveVerificationState, RENEWAL_DUE_STATES } from '@/lib/payments/orders/verification-state'
import { readPaymentAccounts } from '@/lib/payments/orders/payment-accounts'
import { paymentsReadiness } from '@/lib/payments/orders/readiness'
import { ATTESTABLE_SUPPLIER_INVOICE_STATUSES, companyAttestsSupplierInvoices } from '@/lib/supplier-invoices/lifecycle'
import { attestsAtAnyStep, invoiceNeedsAttest, ruleOnApproval } from '@/lib/supplier-invoices/attest-policy'
import { loadAttestLimits, loadAttestPolicy, loadAttestTrails, loadInvoiceProjects, withProjects } from '@/lib/supplier-invoices/attest-policy-read'
import { loadToPayQueue } from '@/lib/supplier-invoices/attest-queues'
import { isAttestRole } from '@/lib/auth/invoicer-role'
import { listSupplierPayeeAlerts } from '@/lib/payments/payee-alerts'
import { listInvoicesAfterFailedPayment } from '@/lib/payments/orders/failed-payments'
import { readUnsignedPayments } from '@/lib/payments/orders/unsigned-payments'
import { signingSwitchedOn } from '@/lib/signing/switched-on'
import { filterOpenDeadlines } from '@/lib/deadlines/open'
import type {
  AttestedToPayDue,
  BankSwitchDue,
  DocumentToSignDue,
  ExpensePayoutDue,
  InvoiceSetAllocation,
  OverdueInvoicesDue,
  PaymentFailedDue,
  PaymentsToSignDue,
  PaymentsVerificationDue,
  SkattekontoPaymentDue,
  SuggestedMatch,
  SupplierInvoiceAttestDue,
  SupplierPayeeChangeDue,
} from './types'

// Canonical home is lib/worklist/types.ts (dependency-free, client-safe);
// re-exported here so existing server-side imports keep working.
export { NEEDS_DOC_SOURCE_TYPES } from './types'

const log = createLogger('worklist')

/**
 * Upper bound on the unconsumed-inbox scan in countInboxDocuments. An inbox
 * with more than this many unhandled items is pathological; the count clamps
 * there rather than scanning unbounded rows on every badge render.
 */
const INBOX_SCAN_CAP = 1000

/**
 * Max ids per PostgREST .in() filter. Ids travel in the GET query string;
 * 150 UUIDs ≈ 5.6 KB, comfortably under common 8 KB proxy URL limits.
 */
const IN_CLAUSE_CHUNK = 150

/**
 * A count that could not be read answers zero: no count ever errors the page.
 * `error` is whatever failed, a PostgREST error object as often as an Error:
 * toError keeps its message and code, where String() of the object logged
 * "[object Object]" (every attest-due failure on 2026-10-29).
 *
 * A column or table the code reads before its migration has run (42703 /
 * PGRST204, 42P01 / PGRST205) is the minutes between deploy and migrate: it
 * clears itself, so it is a warning, not an error. Reading
 * company_attest_policies.two_step_from_sek before 20261030140000 logged one
 * error per Hem load for 46 minutes.
 */
// Missing column (42703 read, PGRST204 write) or table (42P01, PGRST205).
// Kept local: this module is in the Transaktioner client bundle (through
// lib/transactions/underlag-status), and the shared helpers live in modules
// that import node:async_hooks.
const SCHEMA_GAP_CODES = new Set(['42703', 'PGRST204', '42P01', 'PGRST205'])

function logAndZero(category: string, companyId: string, error: unknown): number {
  const { message, code } = toError(error)
  // companyId is a structured field so repeated failures can be correlated
  // to a tenant in monitoring.
  const fields = { companyId, reason: message, code }
  if (code && SCHEMA_GAP_CODES.has(code)) {
    log.warn(`worklist count skipped, schema not migrated yet: ${category}`, fields)
  } else {
    log.error(`worklist count failed: ${category}`, fields)
    for (const listener of countFailureListeners) listener(category, companyId)
  }
  return 0
}

/**
 * A zero from a failed read looks like nothing to do. A caller that shows
 * "Allt är klart" on a zero total (Hem) watches the failures while its
 * counts run, so it can say instead that not everything could be read.
 * Listeners are keyed by company, not by request: two overlapping reads for
 * one company can each see the other's failure, which only ever shows the
 * warning, never hides work. A schema gap (the minutes between deploy and
 * migrate) is not reported: that count is correctly zero until it exists.
 */
type CountFailureListener = (category: string, companyId: string) => void
const countFailureListeners = new Set<CountFailureListener>()

export async function watchCountFailures<T>(
  companyId: string,
  run: () => Promise<T>,
): Promise<{ result: T; failed: string[] }> {
  const failed: string[] = []
  const listener: CountFailureListener = (category, id) => {
    if (id === companyId && !failed.includes(category)) failed.push(category)
  }
  countFailureListeners.add(listener)
  try {
    const result = await run()
    return { result, failed }
  } finally {
    countFailureListeners.delete(listener)
  }
}

/**
 * Unbooked bank transactions: the canonical "att bokföra" predicate.
 * All booking flows (incl. the bulk-book RPCs) set is_business = true, so
 * is_business IS NULL is sufficient; is_ignored excludes the user's
 * explicitly-suppressed rows. Served by the partial index
 * idx_transactions_company_unbooked.
 *
 * This answers "which rows still need a triage decision" (the inbox badge).
 * "Is the ledger complete for a range" is a different question with its own
 * helper, lib/transactions/unbooked.ts: it also counts rows triaged as
 * business that never got a verifikat (574 such rows in 52 real companies in
 * prod on 2026-09-27; the thousands more in sandbox demo companies aside).
 */
export async function countUnbookedTransactions(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
  if (error) return logAndZero('book_transaction', companyId, error)
  return count ?? 0
}

/**
 * Unbooked skattekonto rows: the open rows of lib/skatteverket/skattekonto-open-rows.ts,
 * the same reading the Transaktioner inbox lists. A row dated before the
 * ingående balans on the skattekonto account is carried by it and never
 * counted (crm#2010). Most companies have no open row at all, so the IB is
 * read only when there is a row to date. When it cannot be read every open
 * row counts: work is never hidden on a failed read.
 */
export async function countUnbookedSkattekontoRows(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const countOpen = (openingDate: string | null) =>
    whereSkattekontoRowOpen(
      supabase
        .from('skattekonto_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId),
      openingDate,
    )
  const undated = await countOpen(null)
  if (undated.error) return logAndZero('book_skattekonto', companyId, undated.error)
  if (!undated.count) return 0

  let openingDate: string | null = null
  try {
    openingDate = await readSkattekontoOpeningDate(supabase, companyId)
  } catch (err) {
    log.warn('book_skattekonto: opening balance read failed; counting every open row', {
      companyId,
      error: toError(err).message,
    })
  }
  if (!openingDate) return undated.count

  const dated = await countOpen(openingDate)
  if (dated.error) return logAndZero('book_skattekonto', companyId, dated.error)
  return dated.count ?? 0
}

/**
 * The documents of the open inbox items (isOpenInboxItem, lib/documents/inbox-item-state.ts),
 * each counted once. A receipt that rides on its invoice (an invoice and its
 * receipt are one purchase, lib/inkorg/pairs.ts), and an open half whose other
 * half is booked already, are not counted when the caller passes
 * `companionIds` (./inbox-companions.ts, server only: this module is reachable
 * from the browser through its constants): the Inkorg's Behöver dig leaves them
 * out the same way. A pairing that cannot be read counts every item.
 */
export async function countInboxDocuments(
  supabase: SupabaseClient,
  companyId: string,
  options: { companionIds?: (rows: readonly Record<string, unknown>[]) => Promise<ReadonlySet<string>> } = {},
): Promise<number> {
  const { data, error } = await whereInboxItemOpen(
    supabase
      .from('invoice_inbox_items')
      .select(`id, status, source, document_id, resend_email_id, channel_context, kind_hint, extracted_data, routed_to_arkiv_at, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, ${INBOX_ITEM_DOCUMENT_HOLD}`)
      .eq('company_id', companyId)
      .not('document_id', 'is', null),
  ).limit(INBOX_SCAN_CAP)
  if (error) return logAndZero('inbox_document', companyId, error)
  const rows = ((data ?? []) as unknown as Array<DocumentHoldRow & { id: string; document_id: string }>).map(withDocumentHold).filter(isOpenInboxItem)

  let companions: ReadonlySet<string> = new Set<string>()
  try {
    if (options.companionIds) companions = await options.companionIds(rows as unknown as Record<string, unknown>[])
  } catch (pairingError) {
    log.warn('inbox_document pairing read failed; counting every item', {
      companyId,
      error: toError(pairingError).message,
    })
  }

  return new Set(rows.filter((r) => !companions.has(r.id)).map((r) => r.document_id)).size
}

/** Shared predicate for transactions carrying a match hint. */
const SUGGESTED_MATCH_OR =
  'potential_invoice_id.not.is.null,potential_supplier_invoice_id.not.is.null,potential_rot_rut_payout_request_id.not.is.null'

/**
 * Cap on the hint scan behind countSuggestedMatches; clamps like
 * INBOX_SCAN_CAP. Above IN_CLAUSE_CHUNK on purpose: the candidate lookups it
 * feeds are chunked (fetchCandidatesChunked), so the URL length stays bounded
 * regardless of this number.
 */
export const SUGGESTED_MATCH_SCAN_CAP = 200

/**
 * Unbooked transactions with a still-actionable invoice/supplier-invoice match
 * hint.
 *
 * Delegates to listSuggestedMatches so the badge can never claim a number the
 * list cannot render: a head count over the raw hint columns still counts a
 * pointer at an invoice settled elsewhere (issue #1259), which is exactly the
 * divergence lib/worklist exists to prevent (see types.ts).
 */
export async function countSuggestedMatches(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const matches = await listSuggestedMatches(supabase, companyId, SUGGESTED_MATCH_SCAN_CAP)
  return matches.length
}

/**
 * Supplier invoices awaiting approval ("attestera"): not attested yet, in a
 * status attest still accepts (ATTESTABLE_SUPPLIER_INVOICE_STATUSES, the rule
 * of canApproveSupplierInvoice and the list's Registrerade tab). An invoice
 * that passes its due date unattested is stored as 'overdue' and still waits
 * for its attest: counting 'registered' alone dropped it from Att göra the
 * day it fell due (crm#1631). Zero for a company on kontantmetoden: it has no
 * attest step (companyAttestsSupplierInvoices, the rule the detail page and
 * the list read), so every invoice counted here was an item nobody could
 * clear (crm#1156). Every surface reads this count: the Att göra row and
 * total, the AI task list and the MCP attention resource.
 */
export async function countSupplierInvoicesAwaitingApproval(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const [{ count, error }, { data: settings, error: settingsError }] = await Promise.all([
    supabase
      .from('supplier_invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .in('status', [...ATTESTABLE_SUPPLIER_INVOICE_STATUSES])
      // The cron moves an attested invoice to 'overdue' too: approved_at,
      // not the status, says the attest is done.
      .is('approved_at', null)
      // A credit note is a reversal, never a payable: there is nothing to
      // attest on it and the detail page offers no attest button, so counting
      // one here made an item nobody could clear. The CHECK
      // supplier_invoices_credit_note_not_payable keeps credit notes out of
      // 'registered' since 20260904190000; the predicate states the rule where
      // the count is defined.
      .eq('is_credit_note', false),
    supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .maybeSingle(),
  ])
  if (error) return logAndZero('supplier_invoice_approval', companyId, error)
  if (settingsError) return logAndZero('supplier_invoice_approval', companyId, settingsError)
  const accountingMethod = (settings as { accounting_method?: string | null } | null)?.accounting_method
  if (!companyAttestsSupplierInvoices(accountingMethod)) return 0
  return count ?? 0
}

/** How many invoices awaiting attest one person's rows are read from, oldest due date first. */
const ATTEST_DUE_SCAN_CAP = 200

/**
 * Supplier invoices waiting for this user's attest under the company's attest
 * policy (lib/supplier-invoices/attest-policy.ts), soonest due first: one Att
 * göra row each, "Attestera {leverantör} {belopp}". Empty when the policy is
 * off, the company keeps kontantmetoden, or the user is not an attester.
 * Pending: registered or overdue, not attested (approved_at null), not a
 * credit note, the policy requires attest, and the user's approval would
 * count now (ruleOnApproval records it): they may attest it, have not
 * approved it in the current round, and their limit covers it or the round
 * still has room for an attester without a covering limit (#135). An
 * invoice above the controller's limit is the CEO's row, not the
 * controller's. With ordered steps (#192) a row is the förattestant's until
 * the förattest is given and the attester's after; a substitute gets the
 * rows of the attester they stand in for while the substitution runs.
 * Done: the user approves or rejects, the policy is satisfied
 * by others, or the invoice leaves attest.
 * Soft-fails to an empty list, like every count here.
 */
export async function listSupplierInvoiceAttestsDue(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<SupplierInvoiceAttestDue[]> {
  try {
    const policy = await loadAttestPolicy(supabase, companyId)
    if (!policy.enabled || !attestsAtAnyStep(policy, userId)) return []
    const [{ data: settings, error: settingsError }, { data: memberRows, error: memberError }, limits] = await Promise.all([
      supabase.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
      supabase.from('company_members').select('user_id, role').eq('company_id', companyId),
      loadAttestLimits(supabase, companyId),
    ])
    if (settingsError || memberError) {
      logAndZero('supplier_invoice_attest_due', companyId, settingsError ?? memberError)
      return []
    }
    const accountingMethod = (settings as { accounting_method?: string | null } | null)?.accounting_method
    // The company's members whose attest can count, a viewer the policy names among them (attest-service's loadAttestMembers).
    const attesters = new Set(
      ((memberRows ?? []) as Array<{ user_id: string; role: string }>).filter((m) => isAttestRole(m.role)).map((m) => m.user_id),
    )
    if (!attesters.has(userId) || !companyAttestsSupplierInvoices(accountingMethod)) return []

    const { data: invoices, error } = await supabase
      .from('supplier_invoices')
      .select('id, user_id, supplier_invoice_number, arrival_number, total, total_sek, exchange_rate, currency, due_date, is_credit_note, supplier:suppliers(name)')
      .eq('company_id', companyId)
      .in('status', ['registered', 'overdue'])
      .is('approved_at', null)
      .eq('is_credit_note', false)
      .order('due_date', { ascending: true })
      .limit(ATTEST_DUE_SCAN_CAP)
    if (error) {
      logAndZero('supplier_invoice_attest_due', companyId, error)
      return []
    }
    type Row = {
      id: string
      user_id: string
      supplier_invoice_number: string | null
      arrival_number: number
      total: number
      total_sek: number | null
      exchange_rate: number | null
      currency: string
      due_date: string
      is_credit_note: boolean
      supplier: { name: string | null } | null
    }
    const governed = ((invoices ?? []) as unknown as Row[]).filter((row) => {
      const facts = { ...row, total: Number(row.total) }
      return invoiceNeedsAttest(policy, accountingMethod, facts) && (policy.preparer_may_attest || facts.user_id !== userId)
    })
    if (governed.length === 0) return []
    const ids = governed.map((c) => c.id)
    const [projects, byInvoice] = await Promise.all([loadInvoiceProjects(supabase, companyId, policy, ids), loadAttestTrails(supabase, companyId, ids)])
    return governed
      .map((c) => withProjects(c, projects))
      .filter(
        (c) =>
          ruleOnApproval(policy, accountingMethod, { ...c, total: Number(c.total) }, byInvoice.get(c.id) ?? [], userId, attesters, { limits }).kind ===
          'record',
      )
      .map((c) => ({
        supplier_invoice_id: c.id,
        supplier_name: c.supplier?.name ?? null,
        supplier_invoice_number: c.supplier_invoice_number,
        arrival_number: c.arrival_number,
        total: Number(c.total),
        currency: c.currency,
        due_date: c.due_date,
      }))
  } catch (error) {
    logAndZero('supplier_invoice_attest_due', companyId, error)
    return []
  }
}

/**
 * The supplier invoices still to pay (attested_to_pay): loadToPayQueue of
 * lib/supplier-invoices/attest-queues.ts, every invoice that waits to be paid
 * ("Betala N leverantörsfakturor"), the invoices the Att betala tab it opens
 * lists (lib/supplier-invoices/to-pay.ts). Less the invoices the payment_failed row
 * shows (listPaymentsFailedDue, the very list it renders): one payment is
 * one row. An invoice that row does not show stays here, so none falls
 * between the two. Hem passes the failed list it already reads; otherwise it
 * is read only when an invoice could be ready. Null when there is nothing to
 * pay. Soft-fails to null, like every count here.
 */
export async function listAttestedToPayDue(
  supabase: SupabaseClient,
  companyId: string,
  options: { today?: string; paymentsFailed?: PaymentFailedDue[] | Promise<PaymentFailedDue[]> } = {},
): Promise<AttestedToPayDue | null> {
  try {
    const leaveOut = async () =>
      new Set((await (options.paymentsFailed ?? listPaymentsFailedDue(supabase, companyId))).map((p) => p.supplier_invoice_id))
    const { queue } = await loadToPayQueue(supabase, companyId, options.today ?? todayIsoStockholm(), { leaveOut })
    if (queue.count === 0 || !queue.next_due) return null
    return { count: queue.count, next_due: queue.next_due, overdue: queue.overdue }
  } catch (error) {
    logAndZero('attested_to_pay', companyId, error)
    return null
  }
}

/** How many supplier invoices wait to be paid (listAttestedToPayDue's count). */
export async function countAttestedToPayDue(supabase: SupabaseClient, companyId: string): Promise<number> {
  return (await listAttestedToPayDue(supabase, companyId))?.count ?? 0
}

/**
 * Posted verifikat without underlag: posted entries of document-requiring
 * source types that have neither a current-version document nor a
 * journal_entry_no_doc_required exemption.
 *
 * Delegates to the verifikat_without_documents RPC: the SAME predicate the
 * MCP surfaces use (single truth in SQL; the RPC's needs-doc source-type
 * list mirrors NEEDS_DOC_SOURCE_TYPES, pinned by
 * tests/pg/document-surfaces-unification.pg.test.ts). Previously this
 * fetched three full id-column tables and set-differenced client-side.
 */
export async function countVerifikatMissingDocument(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  try {
    // p_limit only sizes the page: total_count is computed over the FULL
    // filtered set inside the RPC (independent CTE), so 1 is the cheapest
    // valid page size for a count-only call.
    const { data, error } = await supabase.rpc('verifikat_without_documents', {
      p_company_id: companyId,
      p_limit: 1,
      p_offset: 0,
    })
    if (error) return logAndZero('verifikat_missing_document', companyId, error)
    const result = data as { ok?: boolean; code?: string; total_count?: number } | null
    if (!result?.ok) {
      return logAndZero('verifikat_missing_document', companyId, {
        message: result?.code ?? 'rpc returned not-ok',
      })
    }
    return result.total_count ?? 0
  } catch (err) {
    return logAndZero('verifikat_missing_document', companyId, err)
  }
}

/** Arkiv: documents held at the door, waiting for "rör det här bolaget?". */
export async function countHeldDocuments(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { count, error } = await supabase
    .from('document_attachments')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('admission_state', 'held')
  if (error) return logAndZero('document_relevance', companyId, error)
  return count ?? 0
}

/**
 * How far back "say what this is" reaches. The read backfill types years of history, and asking about every
 * old document it could not name would bury Att göra. Older ones stay in Dokument's folders, unasked.
 */
export const REVIEW_RECENT_DAYS = 60
export const reviewSince = (now = new Date()): string => new Date(now.getTime() - REVIEW_RECENT_DAYS * 86_400_000).toISOString()

/** Arkiv: recently uploaded, admitted documents whose current model classification is 'other' or uncertain. */
export async function countUnclassifiedDocuments(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { count, error } = await supabase
    .from('document_classifications')
    .select('id, document_attachments!inner(created_at)', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_current', true)
    .eq('decided_by', 'model')
    .eq('relevance', 'relevant')
    .or('doc_type.eq.other,confidence.lt.0.6')
    .gte('document_attachments.created_at', reviewSince())
    // A booked document is never asked about: the verifikat already says what it is.
    .is('document_attachments.journal_entry_id', null)
    .is('document_attachments.journal_entry_line_id', null)
  if (error) return logAndZero('document_unclassified', companyId, error)
  return count ?? 0
}

/** Arkiv: current extractions with fields a person must settle. */
export async function countDocumentFieldReviews(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { count, error } = await supabase
    .from('document_extractions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('is_current', true)
    .not('review_fields', 'eq', '{}')
  if (error) return logAndZero('document_field_review', companyId, error)
  return count ?? 0
}

/** Arkiv: open findings of the nightly lint. */
export async function countArkivFindings(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { count, error } = await supabase
    .from('arkiv_findings')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'open')
  if (error) return logAndZero('arkiv_finding', companyId, error)
  return count ?? 0
}

/** Arkiv: expected payments from agreements that never arrived. */
export async function countMissedAgreementPayments(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { count, error } = await supabase
    .from('agreement_obligations')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'missed')
  if (error) return logAndZero('agreement_payment_missed', companyId, error)
  return count ?? 0
}

/**
 * Issued invoices whose latest Peppol delivery failed: the number of ids the
 * peppol_failed_invoice_ids function returns on the session client (lib/
 * invoices/peppol-failed-invoices.ts), the same list the invoice chips show.
 * The list is capped at PEPPOL_FAILED_INVOICE_LIMIT, so the count is too;
 * a to-do badge needs no more.
 */
export async function countFailedPeppolDeliveries(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  try {
    return (await listPeppolFailedInvoiceIds({ supabase, companyId })).length
  } catch (err) {
    return logAndZero('peppol_delivery_failed', companyId, err as { message?: string })
  }
}

/** Collections cases a person must look at: collection_attention_case_ids, on the session client. */
export async function countCollectionAttention(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { data, error } = await supabase.rpc('collection_attention_case_ids', { p_company_id: companyId })
  if (error) return logAndZero('collection_attention', companyId, error)
  return Array.isArray(data) ? data.length : 0
}

/** Payouts from the collections provider to book or answer (Avräkningar counts the same). */
export async function countCollectionSettlementsToBook(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { count, error } = await supabase
    .from('collection_settlements')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .in('status', [...SETTLEMENT_STATUSES_TO_BOOK])
  if (error) return logAndZero('collection_settlements_to_book', companyId, error)
  return count ?? 0
}

/** Payments the collections provider collected, not booked yet or refused by the books (Avräkningar counts the same). */
export async function countCollectedPaymentsToBook(supabase: SupabaseClient, companyId: string): Promise<number> {
  const { count, error } = await supabase
    .from('collection_collected_payments')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .in('status', [...PAYMENT_STATUSES_TO_BOOK])
  if (error) return logAndZero('collected_payments_to_book', companyId, error)
  return count ?? 0
}

/** An overdue invoice as the grouped Att göra row and the MCP attention resource read it. */
export interface OverdueInvoiceRow {
  id: string
  invoice_number: string | null
  customer_id: string | null
  status: string
  /** YYYY-MM-DD. */
  due_date: string
  total: number | string | null
  total_sek: number | string | null
  remaining_amount: number | string | null
  currency: string | null
}


/**
 * The invoices the "Hos inkasso" view lists (lib/invoices/invoice-list-tabs.ts
 * 'collections'): an open case past delivery (collection_open_invoice_ids
 * in_collection) or a case a person must look at
 * (collection_attention_case_ids). Such an invoice has its own status chip
 * and its own Att göra rows, so the overdue group and Förfallna leave it out.
 * A failed read is logged and leaves nothing out: an overdue invoice is shown
 * twice rather than hidden.
 */
export async function listCollectionsViewInvoiceIds(
  supabase: SupabaseClient,
  companyId: string,
): Promise<Set<string>> {
  const [open, attention] = await Promise.all([
    supabase.rpc('collection_open_invoice_ids', { p_company_id: companyId }),
    supabase.rpc('collection_attention_case_ids', { p_company_id: companyId }),
  ])
  const ids = new Set<string>()
  if (open.error) {
    log.warn('worklist overdue_invoice: open collection cases unavailable', { companyId, reason: open.error.message })
  } else {
    for (const row of (open.data ?? []) as Array<{ invoice_id: string; in_collection: boolean }>) {
      if (row.in_collection) ids.add(row.invoice_id)
    }
  }
  if (attention.error) {
    log.warn('worklist overdue_invoice: collection attention unavailable', { companyId, reason: attention.error.message })
  } else {
    for (const row of (attention.data ?? []) as Array<{ invoice_id: string }>) ids.add(row.invoice_id)
  }
  return ids
}

/**
 * Overdue customer invoices, oldest due date first: the rows the Förfallna
 * view lists, by the one rule in lib/invoices/overdue.ts (past due with an
 * open remainder, partly paid included, never the stored status), without
 * the "Hos inkasso" view's invoices. Throws on a failed invoice read; the
 * callers soft-fail.
 */
export async function listOverdueInvoiceRows(
  supabase: SupabaseClient,
  companyId: string,
  today: string = todayIsoStockholm(),
): Promise<OverdueInvoiceRow[]> {
  const [rows, held] = await Promise.all([
    fetchAllRows<OverdueInvoiceRow>(({ from, to }) =>
      filterOverdueInvoices(
        supabase.from('invoices').select('id, invoice_number, customer_id, status, due_date, total, total_sek, remaining_amount, currency').eq('company_id', companyId),
        today,
      )
        .order('due_date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    listCollectionsViewInvoiceIds(supabase, companyId),
  ])
  return held.size > 0 ? rows.filter((row) => !held.has(row.id)) : rows
}

// The grouped row's facts (pure): its own module so the Viktiga datum page
// can read the same figure in the browser (crm#1435).
export { summarizeOverdueInvoices }

/**
 * The company's overdue customer invoices as one Att göra item (see
 * OverdueInvoicesDue): null when none is overdue. Soft-fails to null with a
 * logged error, like every other category.
 */
export async function getOverdueInvoicesDue(
  supabase: SupabaseClient,
  companyId: string,
  today: string = todayIsoStockholm(),
): Promise<OverdueInvoicesDue | null> {
  try {
    return summarizeOverdueInvoices(await listOverdueInvoiceRows(supabase, companyId, today), today)
  } catch (err) {
    logAndZero('overdue_invoice', companyId, err as { message?: string })
    return null
  }
}

/**
 * Deadlines needing attention: same predicate as
 * lib/deadlines/status-engine.ts getDeadlinesNeedingAttention(), as a
 * head-count so badges don't fetch rows.
 */
export async function countDeadlinesNeedingAction(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await filterOpenDeadlines(
    supabase
      .from('deadlines')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId),
  )
    .in('status', ['action_needed', 'overdue'])
  if (error) return logAndZero('deadline_action', companyId, error)
  return count ?? 0
}

/** Agent-staged operations awaiting review. */
export async function countPendingOperations(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('pending_operations')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .eq('status', 'pending')
    // The daily batches have their own rows (collection_batch_ready, reminder_batch_ready).
    .not('operation_type', 'in', DAILY_BATCH_TYPES_FILTER)
    // A suggestion (staged by the system, lib/suggestions) has its own row too.
    .neq('actor_type', 'system')
  if (error) return logAndZero('pending_operations', companyId, error)
  return count ?? 0
}

/**
 * The two collections rows of Att göra, counted together so an invoice is
 * counted once (collectionWorkCounts): open cases waiting for the company's
 * decision ("collection_decision") outside the pending daily batch, and the
 * items of that batch (at most one is pending) less those an administrator
 * took out ("collection_batch_ready"). Each read soft-fails on its own.
 */
export async function countCollectionDecisionsAndBatch(
  supabase: SupabaseClient,
  companyId: string,
): Promise<{ decision: number; batchReady: number }> {
  const [casesRes, batchRes] = await Promise.all([
    supabase
      .from('collection_cases')
      .select('id')
      .eq('company_id', companyId)
      .eq('is_open', true)
      .eq('stage', 'awaiting_decision'),
    supabase
      .from('pending_operations')
      .select('id, params')
      .eq('company_id', companyId)
      .eq('operation_type', COLLECTIONS_BATCH_TYPE)
      .eq('status', 'pending')
      .limit(1),
  ])
  if (casesRes.error) logAndZero('collection_decision', companyId, casesRes.error)
  if (batchRes.error) logAndZero('collection_batch_ready', companyId, batchRes.error)
  const decisionCaseIds = casesRes.error ? [] : ((casesRes.data ?? []) as { id: string }[]).map((row) => row.id)
  const batch = batchRes.error ? undefined : ((batchRes.data ?? [])[0] as { id: string; params?: { items?: unknown } } | undefined)
  const rawItems = batch?.params?.items
  const items = Array.isArray(rawItems) ? (rawItems.filter((item) => item && typeof item === 'object') as BatchItem[]) : []
  if (!batch || items.length === 0) return collectionWorkCounts(decisionCaseIds, [], [])
  const { data: removed, error: removedError } = await supabase
    .from('collection_batch_removals')
    .select('invoice_id, kind')
    .eq('company_id', companyId)
    .eq('pending_operation_id', batch.id)
  if (removedError) {
    // Without the removals the batch cannot be counted: it shows no row, and its decisions stay on theirs.
    logAndZero('collection_batch_ready', companyId, removedError)
    return { decision: decisionCaseIds.length, batchReady: 0 }
  }
  return collectionWorkCounts(decisionCaseIds, items, (removed ?? []) as BatchRemoval[])
}

/**
 * The reminders of the pending daily reminder batch (at most one is
 * pending) less those a person took out ("reminder_batch_ready"). Read with
 * the row that opens the batch's dialog (lib/reminders/pending-batch.ts),
 * so the number and the dialog agree.
 */
export async function countReminderBatchReady(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  const read = await readPendingReminderBatch(supabase, companyId)
  if (!read.ok) return logAndZero('reminder_batch_ready', companyId, read.error)
  return read.batch?.items.length ?? 0
}

interface SuggestedMatchTxRow {
  id: string
  date: string
  description: string | null
  amount: number
  currency: string | null
  potential_invoice_id: string | null
  potential_supplier_invoice_id: string | null
  potential_rot_rut_payout_request_id?: string | null
}

type PayoutCandidateRow = {
  id: string
  name: string
  requested_total: number | string
  decided_total: number | string | null
}

type CandidateRow = {
  id: string
  invoice_number?: string | null
  supplier_invoice_number?: string | null
  total: number | null
  customer?: { name: string | null } | null
  supplier?: { name: string | null } | null
}

/**
 * Run one candidate lookup over a chunked id list. PostgREST serialises .in()
 * into the GET query string, so a long list can push the URL past proxy limits
 * (HTTP 414) exactly as countInboxDocuments guards against. The first error
 * short-circuits: a partial candidate set would silently drop rows from the
 * list and, through countSuggestedMatches, from the badge.
 */
async function fetchCandidatesChunked(
  ids: string[],
  runChunk: (
    chunk: string[],
  ) => PromiseLike<{ data: unknown; error: { message?: string } | null }>,
): Promise<{ rows: CandidateRow[]; error: { message?: string } | null }> {
  const rows: CandidateRow[] = []
  for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK) {
    const { data, error } = await runChunk(ids.slice(i, i + IN_CLAUSE_CHUNK))
    if (error) return { rows: [], error }
    rows.push(...((data ?? []) as unknown as CandidateRow[]))
  }
  return { rows, error: null }
}

/**
 * Suggested transaction↔invoice matches with enough candidate context for a
 * one-click confirm row. Confirm endpoints:
 *   kind 'invoice'           → POST /api/transactions/{id}/match-invoice
 *   kind 'supplier_invoice'  → POST /api/transactions/{id}/match-supplier-invoice
 *
 * The hint columns are write-once suggestions: nothing revisits them when the
 * invoice is later settled by a DIFFERENT transaction (or by mark-paid, MCP,
 * bank reconciliation or a SIE import). So the candidate lookup revalidates
 * against MATCHABLE_*_STATUSES instead of trusting the pointer: an invoice
 * that has since been paid would otherwise render a one-click confirm row
 * whose endpoint can only answer ALREADY_PAID.
 *
 * Revalidation stays here, at read time, even though the high-traffic settle
 * paths now also retire sibling pointers
 * (lib/invoices/clear-settled-invoice-suggestions.ts, issue #1259): the settle
 * paths are many and a missed one leaks, while this check covers every route
 * into the list.
 */
export async function listSuggestedMatches(
  supabase: SupabaseClient,
  companyId: string,
  limit = 20,
): Promise<SuggestedMatch[]> {
  const { data: txRows, error } = await supabase
    .from('transactions')
    .select(
      'id, date, description, amount, currency, potential_invoice_id, potential_supplier_invoice_id, potential_rot_rut_payout_request_id',
    )
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
    .or(SUGGESTED_MATCH_OR)
    .order('date', { ascending: false })
    .limit(limit)
  if (error) {
    // companyId matches logAndZero's convention so repeated failures can be
    // correlated to a tenant in monitoring.
    log.error('worklist listSuggestedMatches failed', { companyId, reason: error.message })
    return []
  }

  const txs = (txRows ?? []) as SuggestedMatchTxRow[]
  const invoiceIds = [
    ...new Set(txs.map((t) => t.potential_invoice_id).filter((x): x is string => !!x)),
  ]
  const supplierInvoiceIds = [
    ...new Set(txs.map((t) => t.potential_supplier_invoice_id).filter((x): x is string => !!x)),
  ]

  const payoutRequestIds = [
    ...new Set(
      txs.map((t) => t.potential_rot_rut_payout_request_id).filter((x): x is string => !!x),
    ),
  ]

  const [invoiceRes, supplierRes, payoutRes] = await Promise.all([
    fetchCandidatesChunked(invoiceIds, (chunk) =>
      supabase
        .from('invoices')
        .select('id, invoice_number, total, customer:customers(name)')
        .eq('company_id', companyId)
        .in('id', chunk)
        .in('status', [...MATCHABLE_INVOICE_STATUSES])
        .gt('remaining_amount', 0),
    ),
    fetchCandidatesChunked(supplierInvoiceIds, (chunk) =>
      supabase
        .from('supplier_invoices')
        .select('id, supplier_invoice_number, total, supplier:suppliers(name)')
        .eq('company_id', companyId)
        .in('id', chunk)
        .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
        .gt('remaining_amount', 0),
    ),
    // Open, unsettled begäran only: a settled request must not render a
    // one-click confirm that the route can only answer with INVALID_STATE.
    fetchCandidatesChunked(payoutRequestIds, (chunk) =>
      supabase
        .from('rot_rut_payout_requests')
        .select('id, name, requested_total, decided_total')
        .eq('company_id', companyId)
        .in('id', chunk)
        .in('status', [...OPEN_ROT_RUT_PAYOUT_STATUSES])
        .is('settlement_journal_entry_id', null),
    ),
  ])

  // A failed candidate lookup must not pass for "nothing is matchable": that
  // would render an empty list and, through countSuggestedMatches, a silent
  // zero badge. Log it (with companyId) and bail, same as the tx query above.
  const candidateError = invoiceRes.error ?? supplierRes.error ?? payoutRes.error
  if (candidateError) {
    log.error('worklist listSuggestedMatches candidate lookup failed', {
      companyId,
      reason: candidateError.message,
    })
    return []
  }

  const invoiceById = new Map<string, CandidateRow>(invoiceRes.rows.map((r) => [r.id, r]))
  const supplierById = new Map<string, CandidateRow>(supplierRes.rows.map((r) => [r.id, r]))

  const payoutById = new Map(
    (payoutRes.rows as unknown as PayoutCandidateRow[]).map((r) => [r.id, r] as const),
  )

  const matches: SuggestedMatch[] = []
  for (const tx of txs) {
    const base = {
      transaction_id: tx.id,
      transaction_date: tx.date,
      transaction_description: tx.description ?? '',
      transaction_amount: tx.amount,
      transaction_currency: tx.currency ?? 'SEK',
    }
    // Mirror the transactions page: an invoice hint wins over a supplier hint
    // when both are present (income matches are rarer and higher-signal).
    const invoice = tx.potential_invoice_id
      ? invoiceById.get(tx.potential_invoice_id)
      : undefined
    if (invoice) {
      matches.push({
        ...base,
        kind: 'invoice',
        candidate_id: invoice.id,
        candidate_number: invoice.invoice_number ?? null,
        counterparty_name: invoice.customer?.name ?? null,
        candidate_total: invoice.total ?? null,
      })
      continue
    }
    const supplierInvoice = tx.potential_supplier_invoice_id
      ? supplierById.get(tx.potential_supplier_invoice_id)
      : undefined
    if (supplierInvoice) {
      matches.push({
        ...base,
        kind: 'supplier_invoice',
        candidate_id: supplierInvoice.id,
        candidate_number: supplierInvoice.supplier_invoice_number ?? null,
        counterparty_name: supplierInvoice.supplier?.name ?? null,
        candidate_total: supplierInvoice.total ?? null,
      })
      continue
    }
    const payoutRequest = tx.potential_rot_rut_payout_request_id
      ? payoutById.get(tx.potential_rot_rut_payout_request_id)
      : undefined
    if (payoutRequest) {
      matches.push({
        ...base,
        kind: 'rot_rut_payout',
        candidate_id: payoutRequest.id,
        candidate_number: payoutRequest.name,
        counterparty_name: 'Skatteverket',
        candidate_total: Number(payoutRequest.decided_total ?? payoutRequest.requested_total),
      })
    }
    // Hint pointing at a deleted, foreign or already-settled candidate → drop
    // the row rather than render an unconfirmable suggestion.
  }
  // Transfers that repay one person's registered utlägg. No hint column: the
  // pairing is recomputed from the open claims (cheap, and empty for the
  // companies without any). Confirm endpoint:
  //   kind 'expense_payout'    → POST /api/transactions/{id}/match-expense-payout
  const expenseMatches = await listExpensePayoutSuggestions(supabase, companyId, limit)
  const seen = new Set(matches.map((m) => m.transaction_id))
  for (const m of expenseMatches) {
    if (!seen.has(m.transaction_id)) matches.push(m)
  }
  // Skatteverket's bundled ROT/RUT payout (several begäran in one transfer):
  // no hint column either, recomputed from the open begäran. Confirm endpoint
  // is the same match-rot-rut-payout route, with request_ids.
  const setMatches = await listRotRutPayoutSetSuggestions(supabase, companyId, limit)
  for (const m of setMatches) {
    if (!seen.has(m.transaction_id)) {
      matches.push(m)
      seen.add(m.transaction_id)
    }
  }
  // One payment of several open invoices of one counterparty (PH 192): no
  // hint column either, recomputed from the open invoices. A row that already
  // has a suggestion keeps it, and an invoice a 1:1 hint is about to settle
  // is offered to no set. Confirmed in the batch allocation (allocations).
  const combinationMatches = await listInvoiceCombinationSuggestions(supabase, companyId, limit, {
    transactionIds: new Set(matches.map((m) => m.transaction_id)),
    invoiceIds: new Set(
      matches.filter((m) => m.kind === 'invoice' || m.kind === 'supplier_invoice').map((m) => m.candidate_id),
    ),
  })
  matches.push(...combinationMatches)
  return matches
}

/** Newest unbooked rows scanned for a payment of several invoices of one counterparty. */
const INVOICE_COMBINATION_SCAN_LIMIT = 200

/**
 * Open invoices read per direction for the combination search. A read that
 * comes back full may be missing the invoice that makes a second set fit, so
 * that direction proposes nothing: a set is only offered when it is the one
 * explanation. Fewer than 1 in 100 companies has this many open.
 */
const INVOICE_COMBINATION_POOL_LIMIT = 500

interface CombinationPoolInvoice extends CombinationInvoice {
  number: string | null
  counterpartyName: string | null
  status: string
}

/**
 * Unbooked SEK rows that settle several open invoices of ONE counterparty to
 * the öre: two supplier invoices paid with one internet-bank payment, or a
 * customer paying two invoices in one transfer (PH 192). Read-time pairing
 * over the open invoices, like the ROT/RUT set; the rule, and every refusal
 * that keeps it precise, lives in lib/transactions/invoice-combination.ts.
 * Two reads for a company without two open invoices of one counterparty
 * (the common case), at most five. Soft-fails to [] like the rest of the
 * worklist.
 *
 * `taken` leaves out the rows another suggestion already covers and the
 * invoices a 1:1 hint is about to settle.
 */
export async function listInvoiceCombinationSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  limit = 20,
  taken: { transactionIds?: ReadonlySet<string>; invoiceIds?: ReadonlySet<string> } = {},
): Promise<SuggestedMatch[]> {
  type InvoiceRow = {
    id: string
    customer_id: string | null
    invoice_number: string | null
    remaining_amount: number | string | null
    currency: string | null
    invoice_date: string | null
    due_date: string | null
    status: string
    customer?: { name: string | null } | null
  }
  type SupplierInvoiceRow = {
    id: string
    supplier_id: string | null
    supplier_invoice_number: string | null
    arrival_number: number | null
    remaining_amount: number | string | null
    currency: string | null
    invoice_date: string | null
    due_date: string | null
    status: string
    supplier?: { name: string | null } | null
  }
  type TxRow = {
    id: string
    date: string
    description: string | null
    amount: number | string
    currency: string | null
    potential_match_method: string | null
  }

  try {
    // The open invoices the batch allocation dialog offers
    // (lib/invoices/open-invoice-search.ts): real invoices, the statuses the
    // batch RPC takes, something still owed.
    const [customerRes, supplierRes] = await Promise.all([
      filterOwedInvoices(
        supabase
          .from('invoices')
          .select('id, customer_id, invoice_number, remaining_amount, currency, invoice_date, due_date, status, customer:customers(name)')
          .eq('company_id', companyId),
      ).limit(INVOICE_COMBINATION_POOL_LIMIT),
      supabase
        .from('supplier_invoices')
        .select('id, supplier_id, supplier_invoice_number, arrival_number, remaining_amount, currency, invoice_date, due_date, status, supplier:suppliers(name)')
        .eq('company_id', companyId)
        .eq('is_credit_note', false)
        .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
        .gt('remaining_amount', 0)
        .limit(INVOICE_COMBINATION_POOL_LIMIT),
    ])
    const poolError = customerRes.error ?? supplierRes.error
    if (poolError) {
      log.error('worklist listInvoiceCombinationSuggestions pool failed', { companyId, reason: poolError.message })
      return []
    }
    const claimed = taken.invoiceIds ?? new Set<string>()
    const customerRows = (customerRes.data ?? []) as unknown as InvoiceRow[]
    const supplierRows = (supplierRes.data ?? []) as unknown as SupplierInvoiceRow[]
    const customer: CombinationPoolInvoice[] =
      customerRows.length >= INVOICE_COMBINATION_POOL_LIMIT
        ? []
        : customerRows
            .filter((r) => !claimed.has(r.id))
            .map((r) => ({
              id: r.id,
              counterpartyId: r.customer_id,
              remaining: Number(r.remaining_amount ?? 0),
              currency: r.currency,
              invoiceDate: r.invoice_date,
              dueDate: r.due_date,
              number: r.invoice_number,
              counterpartyName: r.customer?.name ?? null,
              status: r.status,
            }))
    const supplier: CombinationPoolInvoice[] =
      supplierRows.length >= INVOICE_COMBINATION_POOL_LIMIT
        ? []
        : supplierRows
            .filter((r) => !claimed.has(r.id))
            .map((r) => ({
              id: r.id,
              counterpartyId: r.supplier_id,
              remaining: Number(r.remaining_amount ?? 0),
              currency: r.currency,
              invoiceDate: r.invoice_date,
              dueDate: r.due_date,
              // The batch dialog's label for an invoice without the supplier's number.
              number: r.supplier_invoice_number ?? (r.arrival_number != null ? `LF-${r.arrival_number}` : null),
              counterpartyName: r.supplier?.name ?? null,
              status: r.status,
            }))

    // Without two open invoices of one counterparty there is no set to find:
    // skip the bank row read.
    const pairable = (pool: CombinationPoolInvoice[]): boolean => {
      const counterparties = new Set<string>()
      for (const invoice of pool) {
        if (!invoice.counterpartyId) continue
        if (counterparties.has(invoice.counterpartyId)) return true
        counterparties.add(invoice.counterpartyId)
      }
      return false
    }
    const receipts = pairable(customer)
    const payments = pairable(supplier)
    if (!receipts && !payments) return []

    let txQuery = supabase
      .from('transactions')
      .select('id, date, description, amount, currency, potential_match_method')
      .eq('company_id', companyId)
      .is('is_business', null)
      .eq('is_ignored', false)
      .is('journal_entry_id', null)
    if (!receipts) txQuery = txQuery.lt('amount', 0)
    else if (!payments) txQuery = txQuery.gt('amount', 0)
    const { data: txData, error: txError } = await txQuery
      .order('date', { ascending: false })
      .limit(INVOICE_COMBINATION_SCAN_LIMIT)
    if (txError) {
      log.error('worklist listInvoiceCombinationSuggestions failed', { companyId, reason: txError.message })
      return []
    }
    const skipRows = taken.transactionIds ?? new Set<string>()
    const txs = ((txData ?? []) as TxRow[]).filter(
      // A Bankgirot split has its own prefilled allocation, part by part.
      (tx) => !skipRows.has(tx.id) && tx.potential_match_method !== BANKGIRO_SPLIT_METHOD,
    )
    const paired = matchRowsToInvoiceCombinations(
      txs.map((tx) => ({ id: tx.id, amount: Number(tx.amount), currency: tx.currency, date: tx.date })),
      { customer, supplier },
    )
    if (paired.size === 0) return []

    // The dialog's status-leak guard (loadOpenInvoicesForMatch): an invoice
    // whose status still says unpaid but that already has a payment voucher
    // is not offered. Read only for the invoices of a proposed set.
    const fullyOpen = (receipt: boolean) =>
      txs
        .filter((tx) => paired.has(tx.id) && (Number(tx.amount) > 0) === receipt)
        .flatMap((tx) => (paired.get(tx.id)?.invoices ?? []) as CombinationPoolInvoice[])
        .filter((invoice) => invoice.status !== 'partially_paid')
        .map((invoice) => invoice.id)
    const customerIds = fullyOpen(true)
    const supplierIds = fullyOpen(false)
    const [paidCustomer, paidSupplier] = await Promise.all([
      customerIds.length > 0
        ? supabase
            .from('invoice_payments')
            .select('invoice_id')
            .eq('company_id', companyId)
            .in('invoice_id', customerIds)
            .not('journal_entry_id', 'is', null)
        : Promise.resolve({ data: [], error: null }),
      supplierIds.length > 0
        ? supabase
            .from('supplier_invoice_payments')
            .select('supplier_invoice_id')
            .eq('company_id', companyId)
            .in('supplier_invoice_id', supplierIds)
            .not('journal_entry_id', 'is', null)
        : Promise.resolve({ data: [], error: null }),
    ])
    const guardError = paidCustomer.error ?? paidSupplier.error
    if (guardError) {
      log.error('worklist listInvoiceCombinationSuggestions guard failed', { companyId, reason: guardError.message })
      return []
    }
    const leaked = new Set<string>([
      ...((paidCustomer.data ?? []) as { invoice_id: string }[]).map((r) => r.invoice_id),
      ...((paidSupplier.data ?? []) as { supplier_invoice_id: string }[]).map((r) => r.supplier_invoice_id),
    ])

    const out: SuggestedMatch[] = []
    for (const tx of txs) {
      const match = paired.get(tx.id)
      if (!match) continue
      const invoices = match.invoices as CombinationPoolInvoice[]
      if (invoices.some((invoice) => leaked.has(invoice.id))) continue
      const receipt = Number(tx.amount) > 0
      const allocations: InvoiceSetAllocation[] = invoices.map((invoice) =>
        receipt
          ? { kind: 'customer_invoice', invoice_id: invoice.id, amount: roundOre(invoice.remaining) }
          : { kind: 'supplier_invoice', supplier_invoice_id: invoice.id, amount: roundOre(invoice.remaining) },
      )
      const numbers = invoices.map((invoice) => invoice.number).filter((n): n is string => !!n)
      out.push({
        transaction_id: tx.id,
        transaction_date: tx.date,
        transaction_description: tx.description ?? '',
        transaction_amount: Number(tx.amount),
        transaction_currency: tx.currency ?? 'SEK',
        kind: receipt ? 'invoice' : 'supplier_invoice',
        candidate_id: invoices[0].id,
        candidate_number: numbers.length > 0 ? numbers.join(' + ') : null,
        counterparty_name: invoices[0].counterpartyName,
        candidate_total: match.total,
        allocations,
      })
      if (out.length >= limit) break
    }
    return out
  } catch (err) {
    log.error('worklist listInvoiceCombinationSuggestions failed', {
      companyId,
      reason: toError(err).message,
    })
    return []
  }
}

/** Newest unbooked income rows scanned for a bundled ROT/RUT payout. */
const ROT_RUT_SET_SCAN_LIMIT = 200

/**
 * Unbooked SEK income rows that equal the SUM of several open begäran:
 * Skatteverket bundles the beslut it pays that day into one transfer
 * (#2239). Read-time pairing over the open pool, like the expense payouts:
 * no hint column, and nothing at all for a company without two open
 * begäran. The rule lives in lib/invoices/rot-rut-payout-set-matching.ts;
 * a single-begäran hit is the persisted 1:1 hint's job and is not repeated
 * here.
 */
export async function listRotRutPayoutSetSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  limit = 20,
): Promise<SuggestedMatch[]> {
  const pool = (await loadOpenRotRutPayoutRequests(supabase, companyId)).filter((request) =>
    isMatchableRotRutPayoutRequest(request),
  )
  if (pool.length < 2) return []
  const expected = pool.map((request) => expectedRotRutPayoutAmount(request))
  const minExpected = Math.min(...expected)
  const maxTotal = roundOre(expected.reduce((sum, amount) => sum + amount, 0))

  // An invoice hint wins over a begäran (same precedence as the hint path),
  // so rows carrying one are not candidates. Rows with a 1:1 begäran hint
  // ARE fetched: the matcher skips them but takes their begäran out of the
  // pool, so a set never offers a request another row is about to settle.
  const { data, error } = await supabase
    .from('transactions')
    .select(
      'id, date, description, merchant_name, amount, currency, is_business, journal_entry_id, potential_rot_rut_payout_request_id',
    )
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
    .is('journal_entry_id', null)
    .is('potential_invoice_id', null)
    .gte('amount', minExpected)
    .lte('amount', maxTotal)
    .order('date', { ascending: false })
    .limit(ROT_RUT_SET_SCAN_LIMIT)
  if (error) {
    log.error('worklist listRotRutPayoutSetSuggestions failed', { companyId, reason: error.message })
    return []
  }
  type TxRow = {
    id: string
    date: string
    description: string | null
    merchant_name: string | null
    amount: number
    currency: string | null
    is_business: boolean | null
    journal_entry_id: string | null
    potential_rot_rut_payout_request_id: string | null
  }
  const txs = (data ?? []) as TxRow[]
  const paired = matchTransactionsToRotRutPayoutSets(txs, pool)
  const out: SuggestedMatch[] = []
  for (const tx of txs) {
    const m = paired.get(tx.id)
    if (!m || m.requests.length < 2) continue
    out.push({
      transaction_id: tx.id,
      transaction_date: tx.date,
      transaction_description: tx.description ?? '',
      transaction_amount: tx.amount,
      transaction_currency: tx.currency ?? 'SEK',
      kind: 'rot_rut_payout',
      candidate_id: m.requests[0].id,
      candidate_number: m.requests.map((request) => request.name).join(' + '),
      counterparty_name: 'Skatteverket',
      candidate_total: m.total,
      request_ids: m.requests.map((request) => request.id),
    })
    if (out.length >= limit) break
  }
  return out
}

/**
 * Accounts not signed off through the end of the previous month. Cheap by
 * construction (three small reads, no bridge computation) and zero for
 * companies that never signed off anything, so the Hem row only appears
 * once the ritual is adopted. Mirrors lib/reconciliation/service.ts's account
 * set: enabled cash accounts deduplicated per IBAN + currency, plus the
 * skattekonto when it has rows.
 */
export async function countReconciliationDue(
  supabase: SupabaseClient,
  companyId: string,
  today: Date = new Date(),
): Promise<number> {
  const prevMonthEnd = previousMonthEndIso(todayIsoStockholm(today))

  const { data: signoffRows, error: signoffError } = await supabase
    .from('account_reconciliations')
    .select('account_key, through_date, reopened_at')
    .eq('company_id', companyId)
    .order('through_date', { ascending: false })
    .limit(500)
  if (signoffError) return logAndZero('reconciliation_due', companyId, signoffError)
  const signoffs = (signoffRows ?? []) as Array<{ account_key: string; through_date: string; reopened_at: string | null }>
  // Adoption gate: no sign-off ever (active or reopened) means no nudge.
  if (signoffs.length === 0) return 0
  const coveredKeys = new Set(
    signoffs.filter((s) => s.reopened_at === null && s.through_date >= prevMonthEnd).map((s) => s.account_key),
  )

  const { data: cashRows, error: cashError } = await supabase
    .from('cash_accounts')
    .select('id, iban, currency, ledger_account, is_primary, created_at')
    .eq('company_id', companyId)
    .eq('enabled', true)
  if (cashError) return logAndZero('reconciliation_due', companyId, cashError)
  const cash = (cashRows ?? []) as Array<TwinCandidate & { iban: string | null; currency: string | null }>
  // Reconnect duplicates count once: the row the rail keeps.
  const twins = await supersededTwins(supabase, companyId, cash)
  const keys = cash.filter((a) => !twins.has(a.id)).map((a) => `bank:${a.id}`)

  const { count: skvCount, error: skvError } = await supabase
    .from('skattekonto_transactions')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', companyId)
  if (skvError) return logAndZero('reconciliation_due', companyId, skvError)
  if ((skvCount ?? 0) > 0) keys.push('skattekonto')

  return keys.filter((k) => !coveredKeys.has(k)).length
}

/**
 * People owed a payout for their utlägg, oldest debt first. Which claims
 * wait for a payout is listExpenseClaimsAwaitingPayout's answer (registered
 * and on no payslip line, lib/salary/expense-claim-payout-state.ts): a claim
 * put on a salary run is repaid with that salary and is no payout to make.
 * Grouped here (not in SQL) because the owner has no employee row: two owner
 * claims with the same claimant_name are one person, one transfer.
 */
export async function listExpensePayoutsDue(
  supabase: SupabaseClient,
  companyId: string,
): Promise<ExpensePayoutDue[]> {
  try {
    return groupExpenseClaimsByPerson(await listExpenseClaimsAwaitingPayout(supabase, companyId))
  } catch (err) {
    logAndZero('expense_payout', companyId, err as { message?: string })
    return []
  }
}

/** Number of people owed for unpaid utlägg (see listExpensePayoutsDue). */
export async function countExpensePayoutsDue(
  supabase: SupabaseClient,
  companyId: string,
): Promise<number> {
  return (await listExpensePayoutsDue(supabase, companyId)).length
}

/**
 * The Enable Banking connections the switch campaign still waits for, one
 * row each (see lib/worklist/types.ts bank_switch). Empty while the campaign
 * is off or does not apply to the company; the state itself is computed in
 * lib/bank-feed/switch-campaign.ts, which the notice line and the mails
 * read too, so the three can never disagree. Soft-fails to empty with a
 * logged error, like every other category.
 */
export async function listBankSwitchDue(
  supabase: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<BankSwitchDue[]> {
  try {
    const state = await switchStateFor({ supabase, companyId }, { now })
    if (!state) return []
    return state.pending.map((connection) => ({
      connection_id: connection.connection_id,
      bank_name: connection.bank_name,
      deadline: state.deadline,
      days_left: state.days_left,
      passed: state.passed,
      urgent: state.urgent,
    }))
  } catch (err) {
    logAndZero('bank_switch', companyId, err as { message?: string })
    return []
  }
}

/** Number of bank connections still to switch (see listBankSwitchDue). */
export async function countBankSwitchDue(
  supabase: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<number> {
  return (await listBankSwitchDue(supabase, companyId, now)).length
}

/** How far back a bank payment or a payment file shows that a company pays its suppliers here. */
export const PAYMENTS_VERIFICATION_ACTIVITY_DAYS = 60

/** Whether the company made a bank payment or a payment file since `since` (cancelled ones too: the intent counts). */
async function paidSuppliersSince(supabase: SupabaseClient, companyId: string, since: string): Promise<boolean> {
  const [orders, files] = await Promise.all([
    supabase.from('payment_orders').select('id').eq('company_id', companyId).gte('created_at', since).limit(1),
    supabase.from('supplier_payment_batches').select('id').eq('company_id', companyId).gte('created_at', since).limit(1),
  ])
  if (orders.error) throw orders.error
  if (files.error) throw files.error
  return (orders.data?.length ?? 0) > 0 || (files.data?.length ?? 0) > 0
}

/**
 * The payments verification to start or renew, when one is due (see
 * lib/worklist/types.ts payments_verification_renewal): the stored record
 * alone, never a provider call (the status cron and every status read keep it
 * fresh). Null for a company outside the pilot or the paid plan, with
 * nothing on file, or, for the first time, without a bank payment or payment
 * file in the last 60 days or an account that needs the verification.
 */
export async function listPaymentsVerificationDue(
  supabase: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<PaymentsVerificationDue | null> {
  try {
    // The pilot and the plan, never the provider registry (this module is
    // client-reachable): a record exists only where a provider once answered.
    if (!(await paymentsAdmitted(supabase, companyId)).ok) return null
    const record = await readVerificationRecord(supabase, companyId)
    if (!record) return null
    const derived = deriveVerificationState(record, now)
    if (RENEWAL_DUE_STATES.has(derived.state)) {
      return { state: derived.state as PaymentsVerificationDue['state'], valid_until: derived.valid_until, days_left: derived.days_left }
    }
    // The first time: the provider said not verified and nobody made a form.
    if (derived.state !== 'not_started' || !record.checked_at) return null
    const since = new Date(now.getTime() - PAYMENTS_VERIFICATION_ACTIVITY_DAYS * 24 * 60 * 60 * 1000).toISOString()
    if (!(await paidSuppliersSince(supabase, companyId, since))) return null
    const accounts = await readPaymentAccounts(supabase, companyId)
    if (paymentsReadiness({ available: true, accounts, verification: derived }) !== 'verification_needed') return null
    return { state: 'not_started', valid_until: null, days_left: null }
  } catch (err) {
    logAndZero('payments_verification_renewal', companyId, err as { message?: string })
    return null
  }
}

/**
 * Supplier invoices whose stated bank details nobody has decided on (see
 * lib/worklist/types.ts supplier_payee_change): one row per invoice, oldest
 * due date first. A rejected account leaves the list (the invoice says so);
 * a confirmed one never alerts. Soft-fails to none.
 */
export async function listSupplierPayeeChangesDue(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SupplierPayeeChangeDue[]> {
  try {
    return (await listSupplierPayeeAlerts(supabase, companyId)).filter((row) => row.decision === null)
  } catch (err) {
    logAndZero('supplier_payee_change', companyId, err as { message?: string })
    return []
  }
}

/** How many supplier invoices wait for a decision on their bank details (see listSupplierPayeeChangesDue). */
export async function countSupplierPayeeChangesDue(supabase: SupabaseClient, companyId: string): Promise<number> {
  return (await listSupplierPayeeChangesDue(supabase, companyId)).length
}

/**
 * Supplier invoices whose newest bank payment the bank rejected or that
 * failed, still to pay (see lib/worklist/types.ts payment_failed): one row
 * each, most pressing due date first. Soft-fails to none.
 */
export async function listPaymentsFailedDue(supabase: SupabaseClient, companyId: string): Promise<PaymentFailedDue[]> {
  try {
    return await listInvoicesAfterFailedPayment(supabase, companyId)
  } catch (err) {
    logAndZero('payment_failed', companyId, err)
    return []
  }
}

/** How many supplier invoices wait to be paid again after their bank payment did not go through (see listPaymentsFailedDue). */
export async function countPaymentsFailedDue(supabase: SupabaseClient, companyId: string): Promise<number> {
  return (await listPaymentsFailedDue(supabase, companyId)).length
}

/**
 * The bank payments that wait for a person's approval or BankID signature
 * (see lib/worklist/types.ts payments_to_sign): one grouped row, "Signera N
 * betalningar", opening Betalningar. Null when there are none. Soft-fails to
 * null, like every count here.
 */
export async function listPaymentsToSignDue(supabase: SupabaseClient, companyId: string): Promise<PaymentsToSignDue | null> {
  try {
    return await readUnsignedPayments(supabase, companyId)
  } catch (err) {
    logAndZero('payments_to_sign', companyId, err)
    return null
  }
}

/** How many bank payments wait for a person's approval or signature (listPaymentsToSignDue's count). */
export async function countPaymentsToSignDue(supabase: SupabaseClient, companyId: string): Promise<number> {
  return (await listPaymentsToSignDue(supabase, companyId))?.count ?? 0
}

/** How many of one person's pending signer rows a list reads; nobody has more open at once. */
const DOCUMENTS_TO_SIGN_SCAN_CAP = 100

/**
 * The documents waiting for this user's BankID signature in the company
 * (lib/worklist/types.ts documents_to_sign), soonest expiry first: one Att
 * göra row each, "Signera {rubrik}", opening /signering/<signerId>. Empty
 * while signing is switched off (nobody could sign them). Reads only the
 * columns the session is granted (never the token or the BankID session).
 * Soft-fails to an empty list, like every count here.
 */
export async function listDocumentsToSign(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  now: Date = new Date(),
): Promise<DocumentToSignDue[]> {
  try {
    if (!signingSwitchedOn(companyId)) return []
    const { data: signers, error } = await supabase
      .from('signing_request_signers')
      .select('id, signing_request_id, role_label')
      .eq('company_id', companyId)
      .eq('user_id', userId)
      .eq('status', 'pending')
      .limit(DOCUMENTS_TO_SIGN_SCAN_CAP)
    if (error) {
      logAndZero('documents_to_sign', companyId, error)
      return []
    }
    const rows = (signers ?? []) as Array<{ id: string; signing_request_id: string; role_label: string | null }>
    if (rows.length === 0) return []
    const { data: requests, error: requestError } = await supabase
      .from('signing_requests')
      .select('id, title, expires_at')
      .eq('company_id', companyId)
      .eq('status', 'open')
      .gt('expires_at', now.toISOString())
      .in('id', [...new Set(rows.map((r) => r.signing_request_id))])
    if (requestError) {
      logAndZero('documents_to_sign', companyId, requestError)
      return []
    }
    const open = new Map(((requests ?? []) as Array<{ id: string; title: string; expires_at: string }>).map((r) => [r.id, r]))
    return rows
      .filter((r) => open.has(r.signing_request_id))
      .map((r) => {
        const request = open.get(r.signing_request_id)!
        return { signer_id: r.id, signing_request_id: r.signing_request_id, title: request.title, role_label: r.role_label, expires_at: request.expires_at }
      })
      .sort((a, b) => a.expires_at.localeCompare(b.expires_at))
  } catch (err) {
    logAndZero('documents_to_sign', companyId, err as { message?: string })
    return []
  }
}

/** How many documents wait for this user's signature (see listDocumentsToSign). */
export async function countDocumentsToSign(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  return (await listDocumentsToSign(supabase, companyId, userId, now)).length
}

/** 1 when the payments verification is due to start or renew, else 0 (see listPaymentsVerificationDue). */
export async function countPaymentsVerificationDue(
  supabase: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<number> {
  return (await listPaymentsVerificationDue(supabase, companyId, now)) ? 1 : 0
}

/**
 * Where the skatteverket extension caches the saldo it last fetched. Core
 * reads the row directly (never imports `@/extensions/*`); the same row the
 * reconciliation engine and the OCR resolver read.
 */
const SKATTEVERKET_EXTENSION_ID = 'skatteverket'
const BALANCE_SNAPSHOT_KEY = 'skattekonto_balance_snapshot'


/**
 * What the company's bank payments to the skattekonto (payment_orders with
 * purpose 'skattekonto') already cover and the synced saldo cannot show yet:
 * every order on its way to the bank (approved up to accepted, a signing
 * nobody finished only for as long as it can still finish), and every one
 * the bank executed after the saldo was fetched. A draft nobody approved pays
 * nothing. Without a snapshot (fetchedAtMs null) only the orders on their way
 * count, since nothing tells whether an executed one already reached the
 * charge the company reads. A failed read covers nothing, so the row keeps
 * showing the shortfall.
 */
async function skattekontoPaymentsUnderway(
  supabase: SupabaseClient,
  companyId: string,
  fetchedAtMs: number | null,
): Promise<number> {
  const { data, error } = await supabase
    .from('payment_orders')
    .select('amount, status, executed_at, signing:payment_order_batches!fk_payment_orders_batch(status, signing_started_at)')
    .eq('company_id', companyId)
    .eq('purpose', 'skattekonto')
    .in('status', [...SKATTEKONTO_PAYMENT_COVER_STATUSES])
  if (error) {
    logAndZero('skattekonto_payment_due', companyId, error)
    return 0
  }
  return skattekontoPaymentsCovering((data ?? []) as SkattekontoPaymentOrderCover[], fetchedAtMs)
}

/**
 * The next skattekonto charge the balance does not cover, or null.
 *
 * Server-side twin of the /skattekonto page's "Nästa dragning" math: the
 * earliest due date on or after today among Skatteverket's upcoming rows
 * (ignored rows included, Skatteverket draws them regardless of our flag),
 * the sum drawn that day, and the shortfall against the last synced saldo,
 * less what the company's bank payments to the skattekonto already cover
 * (skattekontoPaymentsUnderway). Nothing to pay in (no upcoming charge, a
 * saldo that covers it, or a payment on its way that does) is null, so the
 * Att göra row only appears when money actually has to move.
 *
 * Soft-fails to null with a logged error, like every other category.
 */
export async function listSkattekontoPaymentDue(
  supabase: SupabaseClient,
  companyId: string,
  today: string = todayIsoStockholm(),
): Promise<SkattekontoPaymentDue | null> {
  type UpcomingRow = {
    transaktionsdatum: string
    forfallodatum: string | null
    belopp_skatteverket: number | string
  }
  const [rowsRes, snapshotRes] = await Promise.all([
    supabase
      .from('skattekonto_transactions')
      .select('transaktionsdatum, forfallodatum, belopp_skatteverket')
      .eq('company_id', companyId)
      .eq('status', 'upcoming'),
    supabase
      .from('extension_data')
      .select('value')
      .eq('company_id', companyId)
      .eq('extension_id', SKATTEVERKET_EXTENSION_ID)
      .eq('key', BALANCE_SNAPSHOT_KEY)
      .maybeSingle(),
  ])
  if (rowsRes.error) {
    logAndZero('skattekonto_payment_due', companyId, rowsRes.error)
    return null
  }

  const dueOf = (r: UpcomingRow) => r.forfallodatum ?? r.transaktionsdatum
  const upcoming = ((rowsRes.data ?? []) as UpcomingRow[]).filter((r) => dueOf(r) >= today)
  const due = upcoming.map(dueOf).sort()[0]
  if (!due) return null
  const rows = upcoming.filter((r) => dueOf(r) === due)
  const charge = roundOre(Math.abs(rows.reduce((sum, r) => sum + Number(r.belopp_skatteverket), 0)))
  if (charge <= 0) return null

  // A failed snapshot read is "balance unknown", never "balance zero": the
  // full charge is then the honest amount to show.
  const snapshotValue = snapshotRes.error ? null : (snapshotRes.data?.value as
    | { saldo?: { saldoSkatteverket?: unknown }; fetchedAt?: unknown }
    | null
    | undefined)
  const rawBalance = Number(snapshotValue?.saldo?.saldoSkatteverket)
  const balance = snapshotValue && Number.isFinite(rawBalance) ? roundOre(rawBalance) : null
  if (balance !== null && balance >= charge) return null
  const shortfall = balance === null ? charge : roundOre(charge - balance)
  // A payment made through the bank is not in the saldo yet: Hem and the
  // payment dialog must never ask for it again.
  const fetchedAt = typeof snapshotValue?.fetchedAt === 'number' ? snapshotValue.fetchedAt : null
  const amount = roundOre(shortfall - (await skattekontoPaymentsUnderway(supabase, companyId, fetchedAt)))
  if (amount <= 0) return null

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('entity_type')
    .eq('id', companyId)
    .maybeSingle()
  if (companyError) logAndZero('skattekonto_payment_due', companyId, companyError)
  // Without an org number there is no reference to derive; the row still
  // shows, the user reads the OCR off Skatteverket instead.
  let ocr: string | null = null
  try {
    const orgNumber = await readCompanyOrgNumber(supabase, companyId)
    if (orgNumber) ocr = await resolveSkattekontoOcr(supabase, companyId, orgNumber, parseEntityType(company?.entity_type))
  } catch (err) {
    log.warn('worklist skattekonto_payment_due: OCR could not be derived', {
      companyId,
      reason: (err as { message?: string })?.message,
    })
  }

  return { due, charge, balance, amount, count: rows.length, ocr, bankgiro: SKATTEKONTO_BANKGIRO }
}

/** 1 when a skattekonto charge needs a payment in (see listSkattekontoPaymentDue), else 0. */
export async function countSkattekontoPaymentDue(
  supabase: SupabaseClient,
  companyId: string,
  today: string = todayIsoStockholm(),
): Promise<number> {
  return (await listSkattekontoPaymentDue(supabase, companyId, today)) ? 1 : 0
}

/**
 * Unbooked SEK outflows whose amount equals one person's outstanding utlägg
 * to the öre. Read-time pairing over the open claims: the candidate pool is
 * empty for most companies, so this costs one head-count-sized query and
 * nothing else there. See lib/expenses/expense-payout-candidates.ts for the
 * matching rule.
 */
export async function listExpensePayoutSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  limit = 20,
): Promise<SuggestedMatch[]> {
  const people = await listExpensePayoutsDue(supabase, companyId)
  if (people.length === 0) return []
  const amounts = [...new Set(people.map((p) => -p.total_sek))]
  const { data, error } = await supabase
    .from('transactions')
    .select('id, date, description, amount, currency, is_business, journal_entry_id')
    .eq('company_id', companyId)
    .is('is_business', null)
    .eq('is_ignored', false)
    .in('amount', amounts)
    .order('date', { ascending: false })
    .limit(limit)
  if (error) {
    log.error('worklist listExpensePayoutSuggestions failed', { companyId, reason: error.message })
    return []
  }
  type TxRow = {
    id: string
    date: string
    description: string | null
    amount: number
    currency: string | null
    is_business: boolean | null
    journal_entry_id: string | null
  }
  const txs = (data ?? []) as TxRow[]
  const paired = matchTransactionsToExpensePayouts(txs, people)
  const out: SuggestedMatch[] = []
  for (const tx of txs) {
    const m = paired.get(tx.id)
    if (!m) continue
    out.push({
      transaction_id: tx.id,
      transaction_date: tx.date,
      transaction_description: tx.description ?? '',
      transaction_amount: tx.amount,
      transaction_currency: tx.currency ?? 'SEK',
      kind: 'expense_payout',
      candidate_id: m.person.key,
      candidate_number: null,
      counterparty_name: m.person.claimant_name,
      candidate_total: m.person.total_sek,
      claim_ids: m.person.claim_ids,
    })
  }
  return out
}
