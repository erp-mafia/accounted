import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { MatchBatchSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { Invoice, SupplierInvoice, Transaction } from '@/types'

ensureInitialized()

interface RpcAllocationResult {
  kind: 'customer_invoice' | 'supplier_invoice'
  invoice_id?: string
  supplier_invoice_id?: string
  payment_id: string
  status: 'paid' | 'partially_paid'
  paid_amount: number
  remaining_amount: number
  amount: number
}

interface RpcOk {
  ok: true
  journal_entry_id: string
  voucher_series: string
  voucher_number: number
  tx_id: string
  allocations: RpcAllocationResult[]
  total_allocated: number
  leftover: number
}

interface RpcErr {
  ok: false
  code: string
  details?: Record<string, unknown>
}

/**
 * POST /api/transactions/[id]/match-batch
 *
 * Allocate one bank transaction across N customer OR N supplier invoices.
 * Builds a single combined verifikat (samlingsverifikation) and inserts N
 * payment rows via the match_batch_allocate PL/pgSQL RPC.
 *
 * The RPC is the atomicity boundary; this route is a thin wrapper that:
 *   1. Validates the request body via MatchBatchSchema.
 *   2. Invokes the RPC.
 *   3. Maps the structured RPC error (jsonb { ok: false, code }) to an
 *      errorResponseFromCode call.
 *   4. On success, refetches the per-allocation invoice/supplier_invoice rows
 *      to emit the same per-allocation events the legacy single-tx routes
 *      emit (invoice.match_confirmed, invoice.paid, supplier_invoice.*).
 *      Event emission is best-effort: a failure here does not roll back
 *      the booking; the RPC commit is the source of truth.
 */
export const POST = withRouteContext(
  'transaction.match_batch',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchBatchSchema, {
      log,
      operation: 'transaction.match_batch',
    })
    if (!validation.success) return validation.response

    const txLog = log.child({ transactionId })

    // PR #607 round 3: p_user_id removed: RPC resolves caller from
    // auth.uid() directly. Keeps the attack surface off the API boundary.
    const { data, error } = await supabase.rpc('match_batch_allocate', {
      p_tx_id: transactionId,
      p_allocations: validation.data.allocations,
      p_company_id: companyId,
    })

    if (error) {
      txLog.error('match_batch_allocate RPC error', error)
      return errorResponseFromCode('BATCH_RPC_FAILED', txLog, {
        requestId,
        details: { message: error.message },
      })
    }

    const result = data as RpcOk | RpcErr | null
    if (!result || !result.ok) {
      const code = (result as RpcErr | null)?.code ?? 'BATCH_RPC_FAILED'
      const details = (result as RpcErr | null)?.details
      return errorResponseFromCode(code, txLog, { requestId, details })
    }

    // Re-fetch the transaction row for event payloads (the RPC has already
    // updated it). Lookup is non-critical: events fail open on miss.
    const { data: tx } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .maybeSingle()

    // Emit one event per allocation so existing subscribers (reminder
    // cancellation, automation, processing-history) keep working without a
    // new event channel. Loop sequentially so a single failure logs cleanly.
    for (const alloc of result.allocations) {
      try {
        if (alloc.kind === 'customer_invoice' && alloc.invoice_id) {
          const { data: invoice } = await supabase
            .from('invoices')
            .select('*')
            .eq('id', alloc.invoice_id)
            .eq('company_id', companyId)
            .maybeSingle()
          if (invoice && tx) {
            await eventBus.emit({
              type: 'invoice.match_confirmed',
              payload: {
                invoice: invoice as Invoice,
                transaction: tx as Transaction,
                userId: user.id,
                companyId,
              },
            })
          }
        } else if (alloc.kind === 'supplier_invoice' && alloc.supplier_invoice_id) {
          const { data: supplierInvoice } = await supabase
            .from('supplier_invoices')
            .select('*')
            .eq('id', alloc.supplier_invoice_id)
            .eq('company_id', companyId)
            .maybeSingle()
          if (supplierInvoice && tx) {
            await eventBus.emit({
              type: 'supplier_invoice.match_confirmed',
              payload: {
                supplierInvoice: supplierInvoice as SupplierInvoice,
                transaction: tx as Transaction,
                userId: user.id,
                companyId,
              },
            })
          }
        }
      } catch (err) {
        txLog.warn('match_batch event emission failed', err as Error)
      }
    }

    return NextResponse.json({
      data: {
        journal_entry_id: result.journal_entry_id,
        voucher_series: result.voucher_series,
        voucher_number: result.voucher_number,
        allocations: result.allocations,
        total_allocated: result.total_allocated,
        leftover: result.leftover,
      },
    })
  },
  { requireWrite: true },
)
