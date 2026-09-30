/**
 * Pair an invoice-inbox item with a supplier or a bank transaction. One
 * implementation behind the invoice-inbox extension routes
 * (/api/extensions/ext/invoice-inbox/items/:id/match-supplier and
 * /match-transaction) and the v1 operations (lib/operations/inbox-items.ts):
 *
 *   - both the item and the supplier / transaction must belong to the
 *     company (service-role doors skip RLS, so this is the tenant check);
 *   - a supplier match only sets the item's matched_supplier_id, a hint the
 *     conversion to a supplier invoice uses; nothing is booked;
 *   - a transaction match sets the item's matched_transaction_id and mirrors
 *     the item's document onto the transaction only when the transaction has
 *     no document yet (an existing pin is never overwritten);
 *   - when the transaction is already booked, the item is completed against
 *     the anchoring verifikat (underlag link + consumed stamp), best-effort.
 *
 * Releasing a transaction match is unmatchInboxItemTransaction in
 * ./inbox-item-actions.ts. A dry run reads and checks; it writes nothing.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { errorCauseTag } from '@/lib/errors/db-error'
import { completeInboxItemsForBookedTransaction } from '@/lib/transactions/inbox-underlag'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const ITEM_NOT_FOUND: Failure = { ok: false, code: 'INBOX_ITEM_NOT_FOUND' }

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

export interface MatchSupplierResult {
  id: string
  matched_supplier_id: string
}

export async function matchInboxItemSupplier(
  ctx: OperationContext,
  inboxItemId: string,
  supplierId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<MatchSupplierResult>> {
  const { supabase, companyId } = ctx

  const { data: supplier } = await supabase
    .from('suppliers')
    .select('id, name')
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!supplier) return { ok: false, code: 'SUPPLIER_NOT_FOUND' }

  const { data: item, error: itemError } = await supabase
    .from('invoice_inbox_items')
    .select('id, matched_supplier_id')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (itemError || !item) return ITEM_NOT_FOUND

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        inbox_item_id: item.id,
        supplier_id: supplier.id,
        supplier_name: (supplier.name as string | null) ?? null,
        previous_supplier_id: (item.matched_supplier_id as string | null) ?? null,
        changed: item.matched_supplier_id !== supplier.id,
      },
    }
  }

  const { error: updateError } = await supabase
    .from('invoice_inbox_items')
    .update({ matched_supplier_id: supplierId })
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
  if (updateError) return failed(updateError)

  return { ok: true, data: { id: inboxItemId, matched_supplier_id: supplierId } }
}

export interface MatchTransactionResult {
  id: string
  matched_transaction_id: string
}

export async function matchInboxItemTransaction(
  ctx: OperationContext,
  inboxItemId: string,
  transactionId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<MatchTransactionResult>> {
  const { supabase, companyId, log } = ctx

  const { data: tx } = await supabase
    .from('transactions')
    .select('id, document_id')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!tx) return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }

  const { data: inboxItem, error: itemError } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id')
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (itemError || !inboxItem) return ITEM_NOT_FOUND

  const itemDocumentId = (inboxItem.document_id as string | null) ?? null
  const mirrorsDocument = itemDocumentId != null && !tx.document_id

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        inbox_item_id: inboxItem.id,
        transaction_id: tx.id,
        document_id: itemDocumentId,
        pins_document_on_transaction: mirrorsDocument,
        transaction_has_other_document: tx.document_id != null && tx.document_id !== itemDocumentId,
      },
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from('invoice_inbox_items')
    .update({ matched_transaction_id: transactionId })
    .eq('id', inboxItemId)
    .eq('company_id', companyId)
    .select('id, matched_transaction_id')
    .single()
  if (updateError || !updated) return updateError ? failed(updateError) : ITEM_NOT_FOUND

  // Mirror the inbox document onto the transaction so the list shows
  // "underlag bifogat" at once. Never overwrites an existing pin.
  if (mirrorsDocument) {
    const { error: txUpdateError } = await supabase
      .from('transactions')
      .update({ document_id: itemDocumentId })
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .is('document_id', null)
    if (txUpdateError) {
      // Non-fatal: the match itself succeeded.
      log.error('inbox match: tx.document_id backfill failed', { cause: errorCauseTag(txUpdateError) })
    }
  }

  // A booked transaction completes the item against its verifikat, so a
  // match to a settled purchase resolves the item. Best-effort, logged inside.
  await completeInboxItemsForBookedTransaction(supabase, companyId, transactionId)

  return {
    ok: true,
    data: { id: updated.id as string, matched_transaction_id: updated.matched_transaction_id as string },
  }
}
