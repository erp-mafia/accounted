/**
 * Allocate one bank transaction across N customer OR N supplier invoices:
 * one combined verifikat (samlingsverifikation) and N payment rows, built
 * atomically by the match_batch_allocate RPC behind the engine door
 * commitMatchBatchAllocation (lib/bookkeeping/engine.ts), which also emits
 * journal_entry.committed for the verifikat.
 *
 * One implementation behind the dashboard route
 * (POST /api/transactions/[id]/match-batch) and the operation
 * transactions.match-batch (lib/operations/transactions.ts), which serves
 * v1, the MCP tool gnubok_match_batch_allocate and its approval.
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
 * no behandlingshistorik. It says when the guard in 2 was bypassed
 * (already_explained_by names the vouchers) or could not run
 * (duplicate_check_failed), so the approver never takes it for a clean check.
 */
import type { z } from 'zod'
import type { MatchBatchSchema } from '@/lib/api/schemas'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { emitBatchAllocationEvents } from '@/lib/transactions/batch-allocation-events'
import { clearSettledBatchAllocationSuggestions } from '@/lib/invoices/clear-settled-batch-allocations'
import {
  alreadyExplainedDetails,
  describeExplainingSet,
  guardAlreadyExplained,
  recordExplainedOverride,
} from '@/lib/invoices/already-explained-guard'
import { findCashMethodUnbookedAllocations } from '@/lib/invoices/batch-cash-method-guard'
import {
  buildBatchAllocationPreview,
  type BatchAllocationPreviewInvoice,
} from '@/lib/invoices/batch-allocation-preview'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { commitMatchBatchAllocation } from '@/lib/bookkeeping/engine'
import { roundOre } from '@/lib/money'
import { ID_READ_CHUNK } from '@/lib/reconciliation/limits'
import { chunk } from '@/lib/utils'
import { scheduleCollectionForwardDrain } from '@/lib/collections/forward-hook'

/** The request every door validates (MatchBatchSchema, the v1 and MCP contract). */
export type MatchBatchInput = z.output<typeof MatchBatchSchema>
export type MatchBatchAllocation = MatchBatchInput['allocations'][number]

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
    // Read in slices: a full batch of ids in one `.in()` overruns the
    // gateway's URL limit (lib/reconciliation/limits.ts).
    const docRows: { id: string; document_type: string | null }[] = []
    for (const part of chunk(customerInvoiceIds, ID_READ_CHUNK)) {
      const { data, error: docError } = await supabase
        .from('invoices')
        .select('id, document_type')
        .in('id', part)
        .eq('company_id', companyId)
      if (docError) {
        txLog.error('match-batch: document lookup failed', docError)
        return failed(docError)
      }
      docRows.push(...((data ?? []) as typeof docRows))
    }
    const offender = docRows.find((r) => r.document_type && r.document_type !== 'invoice')
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
  let detectFailed = false
  const explained = await guardAlreadyExplained(supabase, companyId, transactionId, input, {
    onDetectError: (err) => {
      detectFailed = true
      txLog.warn('match-batch: explaining-voucher detection failed', err as Error)
    },
  })
  if (explained.status === 'blocked') {
    // The row's cash account names the reconciliation account the vouchers
    // link through (bank:<cash_account_id>), for a refusal that says how.
    const { data: row } = await supabase
      .from('transactions')
      .select('cash_account_id')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .maybeSingle()
    return {
      ok: false,
      code: 'BATCH_TX_POSSIBLE_DUPLICATE',
      // Names the vouchers, so the approver and the dialog see which.
      messageSv: `${getErrorEntry('BATCH_TX_POSSIBLE_DUPLICATE')?.message_sv ?? ''} (${describeExplainingSet(explained.set)})`.trim(),
      details: {
        ...(alreadyExplainedDetails(explained) as unknown as Record<string, unknown>),
        transaction_id: transactionId,
        cash_account_id: (row as { cash_account_id?: string | null } | null)?.cash_account_id ?? null,
      },
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
    const numbers = cashCheck.unbooked.map((u) => u.invoice_number ?? u.id).join(', ')
    return {
      ok: false,
      code: 'BATCH_CASH_METHOD_UNBOOKED_INVOICE',
      messageSv: `${getErrorEntry('BATCH_CASH_METHOD_UNBOOKED_INVOICE')?.message_sv ?? ''} Obokförda fakturor: ${numbers}.`.trim(),
      details: { invoices: cashCheck.unbooked },
    }
  }

  if (options.dryRun) {
    return previewMatchBatch(ctx, transactionId, input, {
      overriddenBy: explained.status === 'overridden' ? describeExplainingSet(explained.set) : null,
      detectFailed,
    })
  }

  if (explained.status === 'overridden') {
    txLog.warn('match-batch: already-explained guard bypassed', {
      reason: 'force=true',
      journalEntryIds: explained.set.vouchers.map((v) => v.journal_entry_id),
      userId,
    })
  }

  // 4. The RPC is the atomicity boundary, behind the engine door that also
  // announces its verifikat with journal_entry.committed.
  const { data, error } = await commitMatchBatchAllocation(supabase, companyId, userId, {
    transactionId,
    allocations,
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

  // Payment rows the RPC wrote on an invoice under collection wait in the
  // forwarding outbox (a database trigger); report them once this request answers.
  scheduleCollectionForwardDrain(companyId)

  // One set of events per allocation (match_confirmed always, *.paid when the
  // allocation settled the invoice in full), shared with the MCP executor so
  // the doors cannot drift. Best-effort: the RPC has committed.
  await emitBatchAllocationEvents(
    supabase,
    { companyId, userId, transactionId, allocations: result.allocations },
    txLog,
  )

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
  guard: { overriddenBy: string | null; detectFailed: boolean },
): Promise<OperationOutcome<MatchBatchResult>> {
  const { supabase, companyId, log } = ctx
  const { allocations } = input

  const { data: txRow, error: txError } = await supabase
    .from('transactions')
    .select('id, description, merchant_name, amount, currency, date, journal_entry_id, cash_account_id')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (txError) return failed(txError)
  if (!txRow) return { ok: false, code: 'BATCH_TX_NOT_FOUND' }
  const transaction = txRow as {
    id: string
    description: string | null
    merchant_name: string | null
    amount: number
    currency: string | null
    date: string
    journal_entry_id: string | null
    cash_account_id: string | null
  }
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
  for (const part of chunk(ids, ID_READ_CHUNK)) {
    const { data, error } = await supabase
      .from(isCustomer ? 'invoices' : 'supplier_invoices')
      .select('id, currency, exchange_rate, remaining_amount, total')
      .in('id', part)
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

  // The bank leg the RPC posts: capture_bank_booking_context's account for
  // this row, which resolveSettlementAccount mirrors (issue #3097).
  const currency = transaction.currency ?? 'SEK'
  let bankAccount: string
  try {
    bankAccount = await resolveSettlementAccount(supabase, companyId, transaction.cash_account_id, log, currency)
  } catch (err) {
    return failed(err)
  }
  const expected = buildBatchAllocationPreview({
    transaction: { amount: transaction.amount, currency, date: transaction.date },
    bankAccount,
    allocations,
    invoices,
  })

  return {
    ok: true,
    dryRun: true,
    preview: {
      transaction_id: transaction.id,
      transaction_description: transaction.merchant_name || transaction.description || null,
      transaction_amount: transaction.amount,
      transaction_currency: transaction.currency ?? 'SEK',
      transaction_date: transaction.date,
      allocations_count: allocations.length,
      allocations_kind: isCustomer ? 'customer_invoice' : 'supplier_invoice',
      total_allocated: totalAllocated,
      expected_entry_date: expected.entry_date,
      expected_description: expected.description,
      expected_lines: expected.lines,
      expected_lines_balanced: expected.balanced,
      expected_fx: expected.fx,
      ...(guard.overriddenBy ? { already_explained_override: true, already_explained_by: guard.overriddenBy } : {}),
      ...(guard.detectFailed ? { duplicate_check_failed: true } : {}),
    },
  }
}
