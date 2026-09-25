/**
 * Allocate one bank transaction across N customer OR N supplier invoices:
 * one combined verifikat (samlingsverifikation) and N payment rows, built
 * atomically by the match_batch_allocate RPC.
 *
 * One implementation behind the dashboard route
 * (POST /api/transactions/[id]/match-batch) and the v1 operation
 * transactions.match-batch (lib/operations/transactions.ts). The MCP tool
 * gnubok_match_batch_allocate stages the same RPC through its own
 * hand-written preview and commit executor (lib/pending-operations/commit.ts
 * commitMatchBatchAllocate), which runs the same two shared guards.
 *
 * Rules, in order (the dashboard's order, pinned by its tests):
 *   1. only fakturor carry a receivable: a proforma or quote is refused
 *      (the RPC gates on status alone);
 *   2. already-explained guard: posted vouchers that already book this bank
 *      row (each invoice marked paid by hand, a Bankgirot aggregate) refuse
 *      the batch unless force=true names exactly that set;
 *   3. kontantmetoden: an invoice with no booking yet cannot be cleared off
 *      1510/2440 (its revenue/cost + moms would never reach the ledger);
 *   4. the RPC: tenant scope, direction, sums, periods, locks.
 *
 * A dry run runs 1-3, then reads the transaction and the invoices and
 * projects the verifikat the RPC would post (lib/invoices/batch-allocation-
 * preview.ts mirrors the migration). It writes nothing: no RPC, no events,
 * no behandlingshistorik.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { Invoice, SupplierInvoice, Transaction } from '@/types'
import { eventBus } from '@/lib/events/bus'
import { clearSettledBatchAllocationSuggestions } from '@/lib/invoices/clear-settled-batch-allocations'
import {
  alreadyExplainedDetails,
  guardAlreadyExplained,
  recordExplainedOverride,
} from '@/lib/invoices/already-explained-guard'
import { findCashMethodUnbookedAllocations } from '@/lib/invoices/batch-cash-method-guard'
import {
  buildBatchAllocationPreview,
  type BatchAllocationPreviewInvoice,
} from '@/lib/invoices/batch-allocation-preview'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { roundOre } from '@/lib/money'

export type MatchBatchAllocation =
  | { kind: 'customer_invoice'; invoice_id: string; amount: number }
  | { kind: 'supplier_invoice'; supplier_invoice_id: string; amount: number }

export interface MatchBatchInput {
  allocations: MatchBatchAllocation[]
  force?: boolean
  expected_journal_entry_ids?: string[]
}

export interface MatchBatchAllocationResult {
  kind: 'customer_invoice' | 'supplier_invoice'
  invoice_id?: string
  supplier_invoice_id?: string
  payment_id: string
  status: 'paid' | 'partially_paid'
  paid_amount: number
  remaining_amount: number
  amount: number
}

export interface MatchBatchResult {
  journal_entry_id: string
  voucher_series: string
  voucher_number: number
  allocations: MatchBatchAllocationResult[]
  total_allocated: number
  leftover: number
}

interface RpcOk extends MatchBatchResult {
  ok: true
  tx_id: string
}

interface RpcErr {
  ok: false
  code: string
  details?: Record<string, unknown>
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

export async function matchTransactionBatch(
  ctx: OperationContext,
  transactionId: string,
  input: MatchBatchInput,
  /** via: which door honoured a force override, for behandlingshistorik. */
  options: { dryRun?: boolean; via?: string } = {},
): Promise<OperationOutcome<MatchBatchResult>> {
  const { supabase, companyId, userId, log } = ctx
  const txLog = log.child({ transactionId })
  const { allocations } = input

  // 1. Only fakturor carry a receivable.
  const customerInvoiceIds = Array.from(
    new Set(allocations.flatMap((a) => (a.kind === 'customer_invoice' && a.invoice_id ? [a.invoice_id] : []))),
  )
  if (customerInvoiceIds.length > 0) {
    const { data: docRows, error: docError } = await supabase
      .from('invoices')
      .select('id, document_type')
      .in('id', customerInvoiceIds)
      .eq('company_id', companyId)
    if (docError) {
      txLog.error('match-batch: document lookup failed', docError)
      return failed(docError)
    }
    const offender = ((docRows ?? []) as { id: string; document_type: string | null }[]).find(
      (r) => r.document_type && r.document_type !== 'invoice',
    )
    if (offender) {
      return {
        ok: false,
        code: 'MATCH_INVOICE_NOT_INVOICE_TYPE',
        details: { invoiceId: offender.id, documentType: offender.document_type },
      }
    }
  }

  // 2. Already-explained guard (issue #2294). Fail-open on a detection error
  // without force; with force the override cannot be re-verified and is refused.
  const explained = await guardAlreadyExplained(supabase, companyId, transactionId, input, {
    onDetectError: (err) => txLog.warn('match-batch: explaining-voucher detection failed', err as Error),
  })
  if (explained.status === 'blocked') {
    return {
      ok: false,
      code: 'BATCH_TX_POSSIBLE_DUPLICATE',
      details: alreadyExplainedDetails(explained) as unknown as Record<string, unknown>,
    }
  }
  if (explained.status === 'unverifiable') {
    return {
      ok: false,
      code: 'BATCH_TX_EXPLAINED_CHECK_FAILED',
      details: { reason: 'detector_failed', force_rejected: true },
    }
  }

  // 3. Kontantmetoden. Fail closed on a lookup error: booking the wrong
  // shape is worse than a retry.
  const cashCheck = await findCashMethodUnbookedAllocations(supabase, companyId, allocations)
  if (!cashCheck.ok) {
    txLog.error('match-batch: kontantmetoden check failed', cashCheck.error as Error)
    return failed(cashCheck.error)
  }
  if (cashCheck.unbooked.length > 0) {
    return { ok: false, code: 'BATCH_CASH_METHOD_UNBOOKED_INVOICE', details: { invoices: cashCheck.unbooked } }
  }

  if (options.dryRun) return previewMatchBatch(ctx, transactionId, input, explained.status === 'overridden')

  if (explained.status === 'overridden') {
    txLog.warn('match-batch: already-explained guard bypassed', {
      reason: 'force=true',
      journalEntryIds: explained.set.vouchers.map((v) => v.journal_entry_id),
      userId,
    })
  }

  // 4. The RPC is the atomicity boundary. p_user_id is honoured only for a
  // service_role caller (the v1 door); a session caller resolves from its
  // own auth.uid() (migration 20260824120000).
  const { data, error } = await supabase.rpc('match_batch_allocate', {
    p_tx_id: transactionId,
    p_allocations: allocations,
    p_company_id: companyId,
    p_user_id: userId,
  })
  if (error) {
    txLog.error('match_batch_allocate RPC error', error)
    return { ok: false, code: 'BATCH_RPC_FAILED', details: { message: getUserErrorMessage(error) } }
  }

  const result = data as RpcOk | RpcErr | null
  if (!result || !result.ok) {
    const code = (result as RpcErr | null)?.code ?? 'BATCH_RPC_FAILED'
    return { ok: false, code, details: (result as RpcErr | null)?.details }
  }

  // Re-fetch the transaction for event payloads (the RPC already updated it).
  // Non-critical: events fail open on a miss.
  const { data: tx } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()

  // One event per allocation so existing subscribers (reminder cancellation,
  // automation, processing history) keep working. Best-effort.
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
            payload: { invoice: invoice as Invoice, transaction: tx as Transaction, userId, companyId },
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
              userId,
              companyId,
            },
          })
        }
      }
    } catch (err) {
      txLog.warn('match_batch event emission failed', err as Error)
    }
  }

  // Every allocation settled in full retires its suggestion pointer from the
  // company's OTHER transactions (issue #1259).
  await clearSettledBatchAllocationSuggestions(supabase, companyId, result.allocations, transactionId)

  // The override was acted on: durable behandlingshistorik record.
  if (explained.status === 'overridden') {
    await recordExplainedOverride(
      companyId,
      transactionId,
      explained.set,
      { actor: { type: 'user', id: userId }, via: options.via ?? 'dashboard_force' },
      (err) => txLog.warn('match-batch: failed to record override behandlingshistorik', err as Error),
    )
  }

  return {
    ok: true,
    data: {
      journal_entry_id: result.journal_entry_id,
      voucher_series: result.voucher_series,
      voucher_number: result.voucher_number,
      allocations: result.allocations,
      total_allocated: result.total_allocated,
      leftover: result.leftover,
    },
  }
}

/**
 * The dry run past the three guards: the RPC's own refusals that can be
 * answered from reads (transaction missing, already booked, zero, wrong
 * direction, unknown invoice, sums), then the verifikat it would post.
 * Period locks and invoice status are re-checked by the RPC at commit.
 */
async function previewMatchBatch(
  ctx: OperationContext,
  transactionId: string,
  input: MatchBatchInput,
  overridden: boolean,
): Promise<OperationOutcome<MatchBatchResult>> {
  const { supabase, companyId } = ctx
  const { allocations } = input

  const { data: txRow, error: txError } = await supabase
    .from('transactions')
    .select('id, amount, currency, date, journal_entry_id')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (txError) return failed(txError)
  if (!txRow) return { ok: false, code: 'BATCH_TX_NOT_FOUND' }
  const transaction = txRow as { id: string; amount: number; currency: string | null; date: string; journal_entry_id: string | null }
  if (transaction.journal_entry_id) return { ok: false, code: 'BATCH_TX_ALREADY_BOOKED' }
  if (transaction.amount === 0) return { ok: false, code: 'BATCH_TX_ZERO_AMOUNT' }

  const isCustomer = allocations[0]!.kind === 'customer_invoice'
  if ((isCustomer && transaction.amount <= 0) || (!isCustomer && transaction.amount >= 0)) {
    return { ok: false, code: 'BATCH_DIRECTION_MISMATCH' }
  }

  const ids = Array.from(
    new Set(allocations.map((a) => (a.kind === 'customer_invoice' ? a.invoice_id : a.supplier_invoice_id))),
  )
  const invoices = new Map<string, BatchAllocationPreviewInvoice>()
  if (isCustomer) {
    const { data, error } = await supabase
      .from('invoices')
      .select('id, currency, exchange_rate, remaining_amount, total')
      .in('id', ids)
      .eq('company_id', companyId)
    if (error) return failed(error)
    for (const row of (data ?? []) as ({ id: string } & BatchAllocationPreviewInvoice)[]) invoices.set(row.id, row)
  } else {
    const { data, error } = await supabase
      .from('supplier_invoices')
      .select('id, currency, exchange_rate, remaining_amount, total')
      .in('id', ids)
      .eq('company_id', companyId)
    if (error) return failed(error)
    for (const row of (data ?? []) as ({ id: string } & BatchAllocationPreviewInvoice)[]) invoices.set(row.id, row)
  }
  const missing = ids.filter((id) => !invoices.has(id))
  if (missing.length > 0) {
    return {
      ok: false,
      code: isCustomer ? 'BATCH_INVOICE_NOT_FOUND' : 'BATCH_SUPPLIER_INVOICE_NOT_FOUND',
      details: { missing },
    }
  }

  const totalAllocated = roundOre(allocations.reduce((sum, a) => sum + a.amount, 0))
  const txAbs = Math.abs(transaction.amount)
  if (totalAllocated - txAbs > 0.005) return { ok: false, code: 'BATCH_AMOUNT_EXCEEDS_TX', details: { total_allocated: totalAllocated, transaction_amount: txAbs } }
  if (txAbs - totalAllocated > 0.005) return { ok: false, code: 'BATCH_AMOUNT_BELOW_TX', details: { total_allocated: totalAllocated, transaction_amount: txAbs } }

  const expected = buildBatchAllocationPreview({
    transaction: { amount: transaction.amount, currency: transaction.currency ?? 'SEK', date: transaction.date },
    allocations,
    invoices,
  })

  return {
    ok: true,
    dryRun: true,
    preview: {
      transaction_id: transaction.id,
      transaction_amount: transaction.amount,
      transaction_currency: transaction.currency ?? 'SEK',
      allocations_count: allocations.length,
      allocations_kind: isCustomer ? 'customer_invoice' : 'supplier_invoice',
      total_allocated: totalAllocated,
      expected_entry_date: expected.entry_date,
      expected_description: expected.description,
      expected_lines: expected.lines,
      expected_lines_balanced: expected.balanced,
      expected_fx: expected.fx,
      ...(overridden ? { already_explained_override: true } : {}),
    },
  }
}
