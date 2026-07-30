import type { SupabaseClient } from '@supabase/supabase-js'
import { clearSettledInvoiceSuggestions } from './clear-settled-invoice-suggestions'

/**
 * One allocation result as returned by the `match_batch_allocate` RPC
 * (supabase/migrations/20260601122000_match_batch_allocate_round3_fixes.sql).
 * Only the fields this cleanup needs are declared; both callers pass richer
 * rows.
 */
export interface BatchAllocationResult {
  kind: 'customer_invoice' | 'supplier_invoice' | string
  invoice_id?: string | null
  supplier_invoice_id?: string | null
  status: 'paid' | 'partially_paid' | string
}

/**
 * Retire the suggestion pointers at every invoice a samlingsbetalning settled
 * in full (issue #1259).
 *
 * The RPC nulls potential_invoice_id / potential_supplier_invoice_id only on
 * the source transaction (WHERE id = p_tx_id), so every OTHER transaction of
 * the company keeps a pointer at an invoice the batch just closed. That row is
 * excluded here via exceptTransactionId: the RPC already linked it.
 *
 * Shared by the two callers of `match_batch_allocate`, the HTTP route
 * (app/api/transactions/[id]/match-batch/route.ts) and the MCP staged-operation
 * executor (commitMatchBatchAllocate in lib/pending-operations/commit.ts), so
 * they cannot drift.
 *
 * Partially paid allocations are deliberately left alone: such an invoice is
 * still matchable, so its suggestions must survive.
 *
 * Best effort like the helper it wraps: the batch verifikat is already
 * committed, so a failed cleanup must never fail the settle.
 */
export async function clearSettledBatchAllocationSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  allocations: readonly BatchAllocationResult[],
  transactionId: string,
): Promise<void> {
  for (const alloc of allocations) {
    if (alloc.status !== 'paid') continue
    if (alloc.kind === 'customer_invoice' && alloc.invoice_id) {
      await clearSettledInvoiceSuggestions(supabase, companyId, 'invoice', alloc.invoice_id, {
        exceptTransactionId: transactionId,
      })
    } else if (alloc.kind === 'supplier_invoice' && alloc.supplier_invoice_id) {
      await clearSettledInvoiceSuggestions(
        supabase,
        companyId,
        'supplier_invoice',
        alloc.supplier_invoice_id,
        { exceptTransactionId: transactionId },
      )
    }
  }
}
