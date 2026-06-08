import type { SupabaseClient } from '@supabase/supabase-js'
import type { WorklistCounts } from './types'
import {
  countDeadlinesNeedingAction,
  countInboxDocuments,
  countOverdueInvoices,
  countPendingOperations,
  countSuggestedMatches,
  countSupplierInvoicesAwaitingApproval,
  countUnbookedTransactions,
  countVerifikatMissingDocument,
} from './categories'

/**
 * All worklist counts in one round-trip burst. Every count is a cheap
 * head-only query (categories.ts) and individually soft-fails to 0, so this
 * is safe to call from layouts and server components on every render.
 *
 * `total` is the number of distinct actionable items: suggested_match is a
 * fast path over transactions already counted in book_transaction, so it is
 * excluded to avoid double-counting (see lib/worklist/types.ts).
 */
export async function getWorklistCounts(
  supabase: SupabaseClient,
  companyId: string,
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
  ] = await Promise.all([
    countUnbookedTransactions(supabase, companyId),
    countInboxDocuments(supabase, companyId),
    countSuggestedMatches(supabase, companyId),
    countSupplierInvoicesAwaitingApproval(supabase, companyId),
    countVerifikatMissingDocument(supabase, companyId),
    countOverdueInvoices(supabase, companyId),
    countDeadlinesNeedingAction(supabase, companyId),
    countPendingOperations(supabase, companyId),
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
    },
    total:
      bookTransaction +
      inboxDocument +
      supplierInvoiceApproval +
      verifikatMissingDocument +
      overdueInvoice +
      deadlineAction +
      pendingOperations,
  }
}
