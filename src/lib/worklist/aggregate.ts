import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  BankSwitchDue,
  DocumentToSignDue,
  ExpensePayoutDue,
  PaymentsVerificationDue,
  SkattekontoPaymentDue,
  SuggestedMatch,
  SupplierPayeeChangeDue,
} from './types'
import type { WorklistCounts } from './types'
import type { MissingUnderlagSample } from './missing-underlag'
import { listOpenSuggestions } from '@/lib/suggestions/list'
import type { OpenSuggestion } from '@/lib/suggestions/types'
import { isArkivBrainEnabled, isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { inboxHref, isInkorgV2Enabled } from '@/lib/inkorg/flag'
import { inboxCompanionIds } from './inbox-companions'
import {
  countBankSwitchDue,
  countDeadlinesNeedingAction,
  countDocumentsToSign,
  countExpensePayoutsDue,
  countFailedPeppolDeliveries,
  countInboxDocuments,
  countHeldDocuments,
  countUnclassifiedDocuments,
  countDocumentFieldReviews,
  countMissedAgreementPayments,
  countArkivFindings,
  countCollectionAttention,
  countCollectionSettlementsToBook,
  countCollectedPaymentsToBook,
  countCollectionDecisionsAndBatch,
  countReminderBatchReady,
  getOverdueInvoicesDue,
  countPaymentsVerificationDue,
  countPendingOperations,
  countReconciliationDue,
  countSkattekontoPaymentDue,
  countSuggestedMatches,
  countSupplierInvoicesAwaitingApproval,
  countSupplierPayeeChangesDue,
  countUnbookedSkattekontoRows,
  countUnbookedTransactions,
  countVerifikatMissingDocument,
} from './categories'

/**
 * All worklist counts in one round-trip burst. Each count is a bounded query
 * (mostly head-only; suggested_match revalidates its candidates, see
 * categories.ts) and individually soft-fails to 0, so this is safe to call
 * from layouts and server components on every render.
 *
 * `total` is the number of distinct actionable items: suggested_match is a
 * fast path over transactions already counted in book_transaction, so it is
 * excluded to avoid double-counting (see lib/worklist/types.ts).
 */
export interface GetWorklistCountsOptions {
  /**
   * Suggested matches the caller is already fetching (Hem renders them in
   * the Att göra pane): the count is taken from this list instead of a
   * second scan of the same rows. A promise is accepted so it can run in
   * parallel with the other counts.
   */
  suggestedMatches?: SuggestedMatch[] | Promise<SuggestedMatch[]>
  /**
   * People owed for unpaid utlägg the caller is already fetching (Hem
   * renders one row per person): the count is the list's length instead of
   * a second scan of expense_claims.
   */
  expensePayoutsDue?: ExpensePayoutDue[] | Promise<ExpensePayoutDue[]>
  /**
   * The next uncovered skattekonto charge the caller is already fetching
   * (Hem renders it as one Betala row): the count is 1 or 0 from that value
   * instead of a second scan. Pass null for "nothing to pay in".
   */
  skattekontoPaymentDue?: SkattekontoPaymentDue | null | Promise<SkattekontoPaymentDue | null>
  /**
   * The missing-underlag page the caller is already fetching to say what the
   * errand behind the row is (Hem renders it as the row's detail line). Its
   * `total` is computed over the full filtered set inside the same RPC, so
   * passing it replaces the count call rather than adding one.
   */
  missingUnderlag?: MissingUnderlagSample | Promise<MissingUnderlagSample>
  /**
   * The bank connections still to switch to Open Payments the caller is
   * already fetching (Hem renders one row per connection): the count is the
   * list's length instead of a second read of bank_connections.
   */
  bankSwitchDue?: BankSwitchDue[] | Promise<BankSwitchDue[]>
  /**
   * The payments verification to renew the caller is already fetching (Hem
   * renders it as one row): the count is 1 or 0 from it instead of a second
   * read. Pass null for "nothing due".
   */
  paymentsVerificationDue?: PaymentsVerificationDue | null | Promise<PaymentsVerificationDue | null>
  /**
   * The supplier invoices whose bank details wait for a decision the caller
   * is already fetching (Hem renders one row each): the count is the list's
   * length instead of a second read.
   */
  supplierPayeeChangesDue?: SupplierPayeeChangeDue[] | Promise<SupplierPayeeChangeDue[]>
  /**
   * The open suggestions the caller is already fetching (Hem renders one
   * Förslag card each, at most three): the count is the list's length
   * instead of a second read.
   */
  openSuggestions?: OpenSuggestion[] | Promise<OpenSuggestion[]>
  /**
   * The documents waiting for this person's signature the caller is already
   * fetching (Hem renders one row each): the count is the list's length.
   */
  documentsToSign?: DocumentToSignDue[] | Promise<DocumentToSignDue[]>
  /**
   * Whose per-person work to count when no list is passed (documents_to_sign:
   * a signature asked of this user). Without it the per-person count is 0.
   */
  userId?: string | null
}

export async function getWorklistCounts(
  supabase: SupabaseClient,
  companyId: string,
  options: GetWorklistCountsOptions = {},
): Promise<WorklistCounts> {
  // The Dokument rows lead into the section and the brain rows into Granska
  // and Avtal: a row whose page is a 404 for this company is not counted.
  const section = isArkivSectionEnabled(companyId)
  const brain = isArkivBrainEnabled(companyId)
  // The decision row and the daily batch row count an invoice once (lib/collections/batch.ts).
  const collectionWork = countCollectionDecisionsAndBatch(supabase, companyId)
  const [
    bookTransaction,
    bookSkattekonto,
    inboxDocument,
    suggestedMatch,
    supplierInvoiceApproval,
    verifikatMissingDocument,
    overdueInvoices,
    deadlineAction,
    pendingOperations,
    suggestion,
    reconciliationDue,
    expensePayout,
    skattekontoPaymentDue,
    documentRelevance,
    documentUnclassified,
    documentFieldReview,
    agreementPaymentMissed,
    arkivFinding,
    peppolDeliveryFailed,
    collectionDecision,
    collectionAttention,
    collectionSettlementsToBook,
    collectedPaymentsToBook,
    collectionBatchReady,
    reminderBatchReady,
    bankSwitch,
    paymentsVerificationRenewal,
    supplierPayeeChange,
    documentsToSign,
  ] = await Promise.all([
    countUnbookedTransactions(supabase, companyId),
    countUnbookedSkattekontoRows(supabase, companyId),
    countInboxDocuments(supabase, companyId, { companionIds: inboxCompanionIds(supabase, companyId) }),
    options.suggestedMatches
      ? Promise.resolve(options.suggestedMatches).then((m) => m.length)
      : countSuggestedMatches(supabase, companyId),
    countSupplierInvoicesAwaitingApproval(supabase, companyId),
    options.missingUnderlag
      ? Promise.resolve(options.missingUnderlag).then((s) => s.total)
      : countVerifikatMissingDocument(supabase, companyId),
    // One read gives the grouped row's facts and its count.
    getOverdueInvoicesDue(supabase, companyId),
    countDeadlinesNeedingAction(supabase, companyId),
    countPendingOperations(supabase, companyId),
    options.openSuggestions
      ? Promise.resolve(options.openSuggestions).then((s) => s.length)
      : listOpenSuggestions(supabase, companyId).then((s) => s.length),
    countReconciliationDue(supabase, companyId),
    options.expensePayoutsDue
      ? Promise.resolve(options.expensePayoutsDue).then((p) => p.length)
      : countExpensePayoutsDue(supabase, companyId),
    options.skattekontoPaymentDue !== undefined
      ? Promise.resolve(options.skattekontoPaymentDue).then((p) => (p ? 1 : 0))
      : countSkattekontoPaymentDue(supabase, companyId),
    section ? countHeldDocuments(supabase, companyId) : 0,
    section ? countUnclassifiedDocuments(supabase, companyId) : 0,
    brain ? countDocumentFieldReviews(supabase, companyId) : 0,
    brain ? countMissedAgreementPayments(supabase, companyId) : 0,
    brain ? countArkivFindings(supabase, companyId) : 0,
    countFailedPeppolDeliveries(supabase, companyId),
    collectionWork.then((work) => work.decision),
    countCollectionAttention(supabase, companyId),
    countCollectionSettlementsToBook(supabase, companyId),
    countCollectedPaymentsToBook(supabase, companyId),
    collectionWork.then((work) => work.batchReady),
    countReminderBatchReady(supabase, companyId),
    options.bankSwitchDue
      ? Promise.resolve(options.bankSwitchDue).then((b) => b.length)
      : countBankSwitchDue(supabase, companyId),
    options.paymentsVerificationDue !== undefined
      ? Promise.resolve(options.paymentsVerificationDue).then((v) => (v ? 1 : 0))
      : countPaymentsVerificationDue(supabase, companyId),
    options.supplierPayeeChangesDue
      ? Promise.resolve(options.supplierPayeeChangesDue).then((rows) => rows.length)
      : countSupplierPayeeChangesDue(supabase, companyId),
    options.documentsToSign
      ? Promise.resolve(options.documentsToSign).then((rows) => rows.length)
      : options.userId
        ? countDocumentsToSign(supabase, companyId, options.userId)
        : 0,
  ])

  // The overdue customer invoices are one grouped row (lib/worklist/types.ts
  // OverdueInvoicesDue): the count says how many invoices, the total takes
  // the row as one thing to do.
  const overdueInvoice = overdueInvoices?.count ?? 0

  return {
    counts: {
      book_transaction: bookTransaction,
      book_skattekonto: bookSkattekonto,
      inbox_document: inboxDocument,
      suggested_match: suggestedMatch,
      supplier_invoice_approval: supplierInvoiceApproval,
      verifikat_missing_document: verifikatMissingDocument,
      overdue_invoice: overdueInvoice,
      deadline_action: deadlineAction,
      pending_operations: pendingOperations,
      suggestion,
      reconciliation_due: reconciliationDue,
      expense_payout: expensePayout,
      skattekonto_payment_due: skattekontoPaymentDue,
      document_relevance: documentRelevance,
      document_unclassified: documentUnclassified,
      document_field_review: documentFieldReview,
      agreement_payment_missed: agreementPaymentMissed,
      arkiv_finding: arkivFinding,
      peppol_delivery_failed: peppolDeliveryFailed,
      collection_decision: collectionDecision,
      collection_attention: collectionAttention,
      collection_settlements_to_book: collectionSettlementsToBook,
      collected_payments_to_book: collectedPaymentsToBook,
      collection_batch_ready: collectionBatchReady,
      reminder_batch_ready: reminderBatchReady,
      bank_switch: bankSwitch,
      payments_verification_renewal: paymentsVerificationRenewal,
      supplier_payee_change: supplierPayeeChange,
      documents_to_sign: documentsToSign,
    },
    total:
      bookTransaction +
      bookSkattekonto +
      inboxDocument +
      supplierInvoiceApproval +
      verifikatMissingDocument +
      (overdueInvoice > 0 ? 1 : 0) +
      deadlineAction +
      pendingOperations +
      suggestion +
      reconciliationDue +
      expensePayout +
      skattekontoPaymentDue +
      documentRelevance +
      documentUnclassified +
      documentFieldReview +
      agreementPaymentMissed +
      arkivFinding +
      peppolDeliveryFailed +
      collectionDecision +
      collectionAttention +
      collectionSettlementsToBook +
      collectedPaymentsToBook +
      collectionBatchReady +
      reminderBatchReady +
      bankSwitch +
      paymentsVerificationRenewal +
      supplierPayeeChange +
      documentsToSign,
    overdueInvoices: overdueInvoice > 0 ? overdueInvoices : null,
    inboxHref: inboxHref(isInkorgV2Enabled(companyId)),
  }
}
