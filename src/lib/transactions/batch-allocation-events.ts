import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events/bus'
import {
  emitInvoicePaidIfSettled,
  emitSupplierInvoicePaidIfSettled,
} from '@/lib/invoices/paid-events'
import type { Logger } from '@/lib/logger'
import type { Invoice, SupplierInvoice, Transaction } from '@/types'

/**
 * One allocation as the `match_batch_allocate` RPC reports it. Only the fields
 * the events need; both callers pass richer rows.
 */
export interface BatchAllocationEventRow {
  kind: 'customer_invoice' | 'supplier_invoice' | string
  invoice_id?: string | null
  supplier_invoice_id?: string | null
  /** The invoice_payments / supplier_invoice_payments row the RPC wrote. */
  payment_id?: string | null
  /** The status the RPC set on the invoice for this allocation. */
  status: 'paid' | 'partially_paid' | string
  /** The allocated amount, in the transaction currency. */
  amount?: number | null
}

/**
 * The events a committed batch allocation (samlingsbetalning) owes its
 * subscribers, per allocation:
 *   - `invoice.match_confirmed` / `supplier_invoice.match_confirmed`, always
 *     (reminder cancellation, automation, processing history);
 *   - `invoice.paid` / `supplier_invoice.paid` when THIS allocation settled
 *     the invoice in full. The RPC locks each invoice FOR UPDATE and refuses
 *     one that is not open, so a 'paid' status in its result is this call's
 *     transition, reported once (lib/invoices/paid-events.ts).
 *
 * Shared by every door that runs the RPC: matchTransactionBatch (dashboard
 * route and the v1 transactions.match-batch operation) and the MCP commit
 * executor commitMatchBatchAllocate, which used to emit nothing at all.
 *
 * Best-effort: the RPC has committed, so nothing here throws.
 */
export async function emitBatchAllocationEvents(
  supabase: SupabaseClient,
  params: {
    companyId: string
    userId: string
    transactionId: string
    allocations: readonly BatchAllocationEventRow[]
  },
  log: Pick<Logger, 'warn'>,
): Promise<void> {
  const { companyId, userId, transactionId, allocations } = params

  // The RPC already updated the transaction; re-read it for the payloads.
  const { data: txRow } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!txRow) {
    log.warn('match_batch events skipped: transaction re-read returned nothing', {
      companyId,
      transactionId,
    })
    return
  }
  const tx = txRow as Transaction

  for (const alloc of allocations) {
    try {
      if (alloc.kind === 'customer_invoice' && alloc.invoice_id) {
        const { data: invoice } = await supabase
          .from('invoices')
          .select('*')
          .eq('id', alloc.invoice_id)
          .eq('company_id', companyId)
          .maybeSingle()
        if (!invoice) continue
        await eventBus.emit({
          type: 'invoice.match_confirmed',
          payload: { invoice: invoice as Invoice, transaction: tx, userId, companyId },
        })
        if (alloc.status === 'paid') {
          await emitInvoicePaidIfSettled({
            newStatus: alloc.status,
            invoice: invoice as Invoice,
            paymentAmount: await appliedPaymentAmount(supabase, 'invoice_payments', companyId, alloc),
            paymentDate: tx.date,
            userId,
            companyId,
          })
        }
      } else if (alloc.kind === 'supplier_invoice' && alloc.supplier_invoice_id) {
        const { data: supplierInvoice } = await supabase
          .from('supplier_invoices')
          .select('*')
          .eq('id', alloc.supplier_invoice_id)
          .eq('company_id', companyId)
          .maybeSingle()
        if (!supplierInvoice) continue
        await eventBus.emit({
          type: 'supplier_invoice.match_confirmed',
          payload: {
            supplierInvoice: supplierInvoice as SupplierInvoice,
            transaction: tx,
            userId,
            companyId,
          },
        })
        if (alloc.status === 'paid') {
          await emitSupplierInvoicePaidIfSettled({
            newStatus: alloc.status,
            supplierInvoice: supplierInvoice as SupplierInvoice,
            paymentAmount: await appliedPaymentAmount(
              supabase,
              'supplier_invoice_payments',
              companyId,
              alloc,
            ),
            userId,
            companyId,
          })
        }
      }
    } catch (err) {
      log.warn('match_batch event emission failed', err as Error)
    }
  }
}

/**
 * The amount the allocation applied to the invoice, in the INVOICE currency:
 * the payment row the RPC wrote carries it (it differs from the allocated
 * amount on a cross-currency allocation and on an absorbed öre residual).
 * Falls back to the allocated amount when the row cannot be read.
 */
async function appliedPaymentAmount(
  supabase: SupabaseClient,
  table: 'invoice_payments' | 'supplier_invoice_payments',
  companyId: string,
  alloc: BatchAllocationEventRow,
): Promise<number> {
  if (alloc.payment_id) {
    const { data } = await supabase
      .from(table)
      .select('amount')
      .eq('id', alloc.payment_id)
      .eq('company_id', companyId)
      .maybeSingle()
    const amount = (data as { amount?: number | string | null } | null)?.amount
    if (amount !== null && amount !== undefined && Number.isFinite(Number(amount))) {
      return Number(amount)
    }
  }
  return alloc.amount ?? 0
}
