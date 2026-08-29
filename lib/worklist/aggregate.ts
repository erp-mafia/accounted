import type { SupabaseClient } from '@supabase/supabase-js'
import type { SuggestedMatch } from './types'
import type { WorklistCounts } from './types'
import {
  countDeadlinesNeedingAction,
  countInboxDocuments,
  countOverdueInvoices,
  countPendingOperations,
  countReconciliationDue,
  countSuggestedMatches,
  countSupplierInvoicesAwaitingApproval,
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
}

export async function getWorklistCounts(
  supabase: SupabaseClient,
  companyId: string,
  options: GetWorklistCountsOptions = {},
): Promise<WorklistCounts> {
  const [
    bookTransaction,
    inboxDocument,
    suggestedMatch,
    supplierInvoiceApproval,
    verifikatMissingDocument,
    overdueInvoice,
    deadlineAction,
    pendingOperations,
    reconciliationDue,
  ] = await Promise.all([
    countUnbookedTransactions(supabase, companyId),
    countInboxDocuments(supabase, companyId),
    options.suggestedMatches
      ? Promise.resolve(options.suggestedMatches).then((m) => m.length)
      : countSuggestedMatches(supabase, companyId),
    countSupplierInvoicesAwaitingApproval(supabase, companyId),
    countVerifikatMissingDocument(supabase, companyId),
    countOverdueInvoices(supabase, companyId),
    countDeadlinesNeedingAction(supabase, companyId),
    countPendingOperations(supabase, companyId),
    countReconciliationDue(supabase, companyId),
  ])

  return {
    counts: {
      book_transaction: bookTransaction,
      inbox_document: inboxDocument,
      suggested_match: suggestedMatch,
      supplier_invoice_approval: supplierInvoiceApproval,
      verifikat_missing_document: verifikatMissingDocument,
      overdue_invoice: overdueInvoice,
      deadline_action: deadlineAction,
      pending_operations: pendingOperations,
      reconciliation_due: reconciliationDue,
    },
    total:
      bookTransaction +
      inboxDocument +
      supplierInvoiceApproval +
      verifikatMissingDocument +
      overdueInvoice +
      deadlineAction +
      pendingOperations +
      reconciliationDue,
  }
}
