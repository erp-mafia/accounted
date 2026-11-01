/**
 * Allocate one bank transaction across N customer OR N supplier invoices:
 * one combined verifikat (samlingsverifikation) and N payment rows, built
 * atomically by the match_batch_allocate RPC behind the engine door
 * commitMatchBatchAllocation (lib/bookkeeping/engine.ts, reached through the
 * posting port's commitSqlPosting), which also emits journal_entry.committed
 * for the verifikat.
 *
 * One implementation behind the dashboard route
 * (POST /api/transactions/[id]/match-batch) and the operation
 * transactions.match-batch (lib/operations/transactions.ts), which serves
 * v1, the MCP tool gnubok_match_batch_allocate and its approval.
 *
 * Rules, in order (the dashboard's order, pinned by its tests):
 *   1. only fakturor carry a receivable: a proforma or quote is refused
 *      (the RPC gates on status alone), and so is a credit note or an
 *      original with an active credit note, as on the single match
 *      (invoiceDocumentRefusal);
 *   1b. the row: already booked or ignored is refused by the gate every
 *      booking door asks (decideBankRowRebooking), before anything is
 *      written; the RPC reads the same anchors under its row lock;
 *   1c. a foreign row is refused, as bulk book and the expense payout refuse
 *      one: the verifikat's columns are kronor and neither this door nor the
 *      RPC reads the row's SEK. Refused here so nothing is booked first for it;
 *   2. already-explained guard: posted vouchers that already book this bank
 *      row (each invoice marked paid by hand, a Bankgirot aggregate) refuse
 *      the batch unless force=true names exactly that set;
 *   3. kontantmetoden: an invoice with no booking yet has no 1510/2440 to
 *      clear. Customer invoices of SEK paid in full book their sale in the
 *      samlingsverifikat instead, each with the single cash match's lines
 *      (lib/invoices/batch-cash-method-guard.ts, the RPC's p_cash_lines); anything
 *      else (supplier invoices, a mix with booked invoices, a foreign
 *      currency, an installment) is refused, before anything is written;
 *   3b. faktureringsmetoden with defer_invoice_booking: a supplier invoice
 *      registered without its verifikat is booked first by the Bokför step,
 *      right before the RPC (lib/supplier-invoices/registration-first.ts);
 *      its dry run runs here, so a refusal refuses the batch before anything
 *      is written;
 *   3s. faktureringsmetoden with defer_invoice_booking: a customer invoice
 *      sent without its verifikat gets its sale booked first by the Bokför
 *      step, right before the RPC (lib/invoices/sale-first.ts); its dry run
 *      runs here, so a refusal refuses the batch before anything is written;
 *   4. the RPC: tenant scope, direction, sums, fee rows, periods, locks.
 *
 * A batch is all customer or all supplier invoices (the RPC refuses a mix),
 * so at most one of 3b and 3s books anything; both run, registrations first.
 *
 * Fee rows (input.fees, lib/bookkeeping/payout-fee-lines.ts): a payment
 * service's fee on the row, a debit on a class 6 cost account with no VAT.
 * The invoices less the fees (customer) or plus the fees (supplier) equal
 * the row; every invoice still settles for what it owed.
 *
 * A dry run runs 1-3s, then reads the transaction, the invoices and what the
 * ledger carries for a foreign one and projects the verifikat the RPC would
 * post (lib/invoices/batch-allocation-preview.ts mirrors the migration), with
 * the registrations 3b and the sales 3s would book before it
 * (registration_entries, sale_entries). It writes nothing: no RPC, no events,
 * no behandlingshistorik. It says when the guard in 2 was bypassed
 * (already_explained_by names the vouchers) or could not run
 * (duplicate_check_failed), so the approver never takes it for a clean check.
 */
import type { z } from 'zod'
import type { MatchBatchSchema } from '@/lib/api/schemas'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { emitBatchAllocationEvents } from '@/lib/transactions/batch-allocation-events'
import { propagateUnderlagForBookedTransaction } from '@/lib/transactions/inbox-underlag'
import { clearSettledBatchAllocationSuggestions } from '@/lib/invoices/clear-settled-batch-allocations'
import {
  alreadyExplainedDetails,
  describeExplainingSet,
  guardAlreadyExplained,
  recordExplainedOverride,
} from '@/lib/invoices/already-explained-guard'
import {
  findCashMethodUnbookedAllocations,
  planBatchCashLines,
  type BatchCashLine,
} from '@/lib/invoices/batch-cash-method-guard'
import { backfillStandardBASAccounts } from '@/lib/bookkeeping/account-backfill'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { isKronorCurrency } from '@/lib/bookkeeping/currency-utils'
import { fxDeviationTooLarge } from '@/lib/bookkeeping/fx-settlement'
import { carriedSekOf, clearedSek } from '@/lib/bookkeeping/ledger-carried-sek'
import {
  buildBatchAllocationPreview,
  type BatchAllocationPreviewInvoice,
} from '@/lib/invoices/batch-allocation-preview'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import type { SqlBusinessEventLink } from '@/lib/bookkeeping/business-event-link'
import { batchAllocationBusinessEvent, type BatchAllocationFacts } from '@/lib/bookkeeping/sql-posting-business-events'
import { linkBasisColumns } from '@/lib/links/stamp'
import { postingPort } from '@/lib/posting/port'
import type { BusinessEventDraft } from '@/lib/posting/types'
import { roundOre } from '@/lib/money'
import { payoutBankAmount, payoutFeeLines, payoutFeeTotal } from '@/lib/bookkeeping/payout-fee-lines'
import { ID_READ_CHUNK } from '@/lib/reconciliation/limits'
import { invoiceDocumentRefusal, type InvoiceDocumentFields } from '@/lib/transactions/invoice-document-refusal'
import { bankRowRefusalCode, decideBankRowRebookingById } from '@/lib/transactions/is-booked'
import { chunk } from '@/lib/utils'
import { scheduleCollectionForwardDrain } from '@/lib/collections/forward-hook'
import {
  bookRegistrationsBeforeBatchSettlement,
  planRegistrationsBeforeBatchSettlement,
  type RegistrationFirstPlan,
} from '@/lib/supplier-invoices/registration-first'
import {
  bookSalesBeforeBatchSettlement,
  planSalesBeforeBatchSettlement,
  type RequiredSaleFirstPlan,
} from '@/lib/invoices/sale-first'

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
  /** The fee rows booked on the verifikat together; absent without fee rows. */
  total_fees?: number
  /**
   * Supplier invoice id to the registration verifikat the batch booked first
   * (defer_invoice_booking); absent when it booked none.
   */
  registration_journal_entry_ids?: Record<string, string>
  /**
   * Customer invoice id to the sale verifikat the batch booked first
   * (defer_invoice_booking); absent when it booked none.
   */
  sale_journal_entry_ids?: Record<string, string>
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
    const docRows: ({ id: string } & InvoiceDocumentFields)[] = []
    for (const part of chunk(customerInvoiceIds, ID_READ_CHUNK)) {
      const { data, error: docError } = await supabase
        .from('invoices')
        .select('id, document_type, credited_invoice_id, credit_notes:invoices!credited_invoice_id(id, status, creation_complete)')
        .in('id', part)
        .eq('company_id', companyId)
      if (docError) {
        txLog.error('match-batch: document lookup failed', docError)
        return failed(docError)
      }
      docRows.push(...((data ?? []) as typeof docRows))
    }
    for (const row of docRows) {
      const refusal = invoiceDocumentRefusal(row)
      if (refusal) return { ok: false, code: refusal.code, details: { invoiceId: row.id, ...refusal.details } }
    }
  }

  // 1b. A row already booked or ignored, on a dry run and a commit alike and
  // before a sale or registration is booked for it. A row that is not there
  // is the RPC's refusal, and the dry run's.
  const rebooking = await decideBankRowRebookingById(supabase, companyId, transactionId, { replace: false })
  if (rebooking.outcome === 'refuse') {
    return {
      ok: false,
      code: bankRowRefusalCode(rebooking, 'BATCH_TX_ALREADY_BOOKED'),
      details: { journal_entry_id: rebooking.journalEntryId, voucher: rebooking.voucher, via: rebooking.via, undo: rebooking.undo },
    }
  }

  // 1c. A foreign row, on a dry run and a commit alike, before a sale or
  // registration is booked for it.
  if (rebooking.outcome === 'open' && !isKronorCurrency(rebooking.currency)) {
    return { ok: false, code: 'BATCH_FOREIGN_CURRENCY', details: { currency: rebooking.currency } }
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
  // The sale of each unbooked customer invoice is booked in the
  // samlingsverifikat itself (crm#1539); what that entry cannot carry keeps
  // the refusal, with the reason.
  let cashLines: Record<string, BatchCashLine[]> | undefined
  if (cashCheck.unbooked.length > 0) {
    const plan = await planBatchCashLines(supabase, companyId, transactionId, allocations, cashCheck.unbooked)
    if (!plan.ok && 'error' in plan) {
      txLog.error('match-batch: kontantmetoden plan failed', plan.error as Error)
      return failed(plan.error)
    }
    if (!plan.ok) {
      const numbers = cashCheck.unbooked.map((u) => u.invoice_number ?? u.id).join(', ')
      return {
        ok: false,
        code: 'BATCH_CASH_METHOD_UNBOOKED_INVOICE',
        messageSv: `${getErrorEntry('BATCH_CASH_METHOD_UNBOOKED_INVOICE')?.message_sv ?? ''} Obokförda fakturor: ${numbers}.`.trim(),
        details: {
          invoices: cashCheck.unbooked,
          unsupported: plan.unsupported,
          ...(plan.invoiceId ? { invoice_id: plan.invoiceId } : {}),
        },
      }
    }
    cashLines = plan.cashLines
    // The engine seeds a standard BAS account the chart lacks (3740 the
    // first time a payment lands a sub-krona off); the RPC cannot, and
    // refuses an account that is not active. A deactivated or non-BAS
    // account refuses here, before anything is written.
    const accounts = cashLineAccounts(cashLines)
    let unresolvable: string[]
    try {
      unresolvable = await findUnresolvableAccounts(supabase, companyId, accounts)
    } catch (err) {
      return failed(err)
    }
    if (unresolvable.length > 0) {
      return { ok: false, code: 'BATCH_CASH_LINES_INVALID', details: { reason: 'account', accounts: unresolvable } }
    }
  }

  // 3b. A deferring company's unbooked supplier invoices are booked first,
  // dated as the Bokför step dates them; the batch's own date must take the
  // samlingsverifikation, checked before anything is booked.
  const supplierInvoiceIds = allocations.flatMap((a) =>
    a.kind === 'supplier_invoice' && a.supplier_invoice_id ? [a.supplier_invoice_id] : [],
  )
  const registrations = await planRegistrationsBeforeBatchSettlement(ctx, supplierInvoiceIds, {
    settlementDate: async () => {
      const { data } = await supabase
        .from('transactions')
        .select('date')
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .maybeSingle()
      return (data as { date?: string | null } | null)?.date ?? null
    },
  })
  if (!registrations.ok) return registrations

  // 3s. A deferring company's unbooked customer invoices are booked first,
  // dated as the Bokför step dates them; the batch's own date must take the
  // samlingsverifikation, checked before anything is booked.
  const sales = await planSalesBeforeBatchSettlement(ctx, customerInvoiceIds, {
    settlementDate: async () => {
      const { data } = await supabase
        .from('transactions')
        .select('date')
        .eq('id', transactionId)
        .eq('company_id', companyId)
        .maybeSingle()
      return (data as { date?: string | null } | null)?.date ?? null
    },
  })
  if (!sales.ok) return sales

  if (options.dryRun) {
    return previewMatchBatch(ctx, transactionId, input, {
      overriddenBy: explained.status === 'overridden' ? describeExplainingSet(explained.set) : null,
      detectFailed,
      registrations: registrations.plans,
      sales: sales.plans,
      cashLines,
    })
  }

  if (cashLines) await backfillStandardBASAccounts(supabase, companyId, userId, cashLineAccounts(cashLines))

  if (explained.status === 'overridden') {
    txLog.warn('match-batch: already-explained guard bypassed', {
      reason: 'force=true',
      journalEntryIds: explained.set.vouchers.map((v) => v.journal_entry_id),
      userId,
    })
  }

  // 3b, committed: the registrations first, so the RPC's 2440 debits clear
  // a skuld the ledger carries. Each one posted is a correct booking of its
  // invoice and stays if anything after it fails (named in partialPostedIds).
  const booked = await bookRegistrationsBeforeBatchSettlement(ctx, registrations.plans)
  if (!booked.ok) {
    const { postedJournalEntryIds, ...refusal } = booked
    return Object.keys(postedJournalEntryIds).length > 0
      ? { ...refusal, partialPostedIds: registrationPostedIds(postedJournalEntryIds) }
      : refusal
  }
  const postedRegistrations = registrationPostedIds(booked.postedJournalEntryIds)

  // 3s, committed: the sales next, so the RPC's 1510 credits clear a
  // receivable the ledger carries. Each one posted stays as well; a refusal
  // here names every registration and sale posted before it.
  const bookedSales = await bookSalesBeforeBatchSettlement(ctx, sales.plans)
  if (!bookedSales.ok) {
    const { postedJournalEntryIds, ...refusal } = bookedSales
    const partial = { ...postedRegistrations, ...salePostedIds(postedJournalEntryIds) }
    return Object.keys(partial).length > 0 ? { ...refusal, partialPostedIds: partial } : refusal
  }
  const postedFirst = { ...postedRegistrations, ...salePostedIds(bookedSales.postedJournalEntryIds) }
  const withPosted = <F extends { ok: false }>(failure: F): F =>
    Object.keys(postedFirst).length > 0 ? { ...failure, partialPostedIds: postedFirst } : failure

  // The posting port (its SQL step): one payment event per allocation
  // (sale.payment_received or purchase.paid, as the single bank match
  // records), which the RPC links to its samlingsverifikat before the number
  // is drawn. Off: nothing is read or built and the RPC is called as before.
  let businessEvents: SqlBusinessEventLink | undefined
  try {
    businessEvents = await postingPort.recordEventsForSql({
      supabase,
      companyId,
      events: () => batchAllocationEvents(ctx, transactionId, allocations),
    })
  } catch (err) {
    // strict: an event that could not be recorded stops the booking before any number.
    txLog.error('match-batch: business events not recorded (strict)', err)
    return withPosted({ ok: false, code: 'BATCH_RPC_FAILED', details: { message: getUserErrorMessage(err) } })
  }

  // 4. The RPC is the atomicity boundary, behind the engine door (through
  // the posting port) that also announces its verifikat with
  // journal_entry.committed.
  const feeLines = payoutFeeLines(input.fees)
  const { data, error } = await postingPort.commitSqlPosting({
    supabase,
    companyId,
    userId,
    fn: 'match_batch_allocate',
    args: [
      {
        transactionId,
        allocations,
        ...(feeLines.length > 0 ? { feeLines } : {}),
        ...(cashLines ? { cashLines } : {}),
        ...(businessEvents ? { businessEvents } : {}),
      },
    ],
  })
  if (error) {
    txLog.error('match_batch_allocate RPC error', error)
    return withPosted({ ok: false, code: 'BATCH_RPC_FAILED', details: { message: getUserErrorMessage(error) } })
  }

  const result = data as RpcOk | RpcErr | null
  if (!result || !result.ok) {
    const code = (result as RpcErr | null)?.code ?? 'BATCH_RPC_FAILED'
    return withPosted({ ok: false, code, details: (result as RpcErr | null)?.details })
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

  // The bank row's own underlag, as on every booking of a row: one row, one
  // samlingsverifikat, so its document has one verifikat to land on. Never throws.
  await propagateUnderlagForBookedTransaction(supabase, companyId, transactionId, result.journal_entry_id)

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
      ...(feeLines.length > 0 ? { total_fees: result.total_fees ?? payoutFeeTotal(feeLines) } : {}),
      ...(Object.keys(booked.journalEntryIds).length > 0
        ? { registration_journal_entry_ids: booked.journalEntryIds }
        : {}),
      ...(Object.keys(bookedSales.journalEntryIds).length > 0
        ? { sale_journal_entry_ids: bookedSales.journalEntryIds }
        : {}),
    },
    ...(booked.warnings.length + bookedSales.warnings.length > 0
      ? { warnings: [...booked.warnings, ...bookedSales.warnings] }
      : {}),
  }
}

/** The accounts the kontantmetoden lines book on, each once. */
function cashLineAccounts(cashLines: Record<string, BatchCashLine[]>): string[] {
  return Array.from(new Set(Object.values(cashLines).flatMap((lines) => lines.map((line) => line.account_number))))
}

/** The registrations a batch posted, keyed for partialPostedIds. */
function registrationPostedIds(byInvoice: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(byInvoice).map(([invoiceId, entryId]) => [`registration:${invoiceId}`, entryId]),
  )
}

/** The sales a batch posted, keyed for partialPostedIds. */
function salePostedIds(byInvoice: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(byInvoice).map(([invoiceId, entryId]) => [`sale:${invoiceId}`, entryId]))
}

/**
 * The events of a batch allocation, one per allocation in the request's
 * order: the bank line's date and currency and each invoice's party,
 * currency and remainder, read as the RPC reads them. None (the RPC is then
 * called as before, and refuses as before) when the bank line or an invoice
 * is not there or the allocations mix customer and supplier invoices. A
 * read error throws: the port logs it under shadow and stops the booking
 * under strict.
 */
async function batchAllocationEvents(
  ctx: OperationContext,
  transactionId: string,
  allocations: MatchBatchAllocation[],
): Promise<BusinessEventDraft[]> {
  const { supabase, companyId } = ctx
  const kinds = new Set(allocations.map((a) => a.kind))
  if (kinds.size !== 1) return []
  const isCustomer = kinds.has('customer_invoice')

  const { data: txRow, error: txError } = await supabase
    .from('transactions')
    .select('date, currency')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (txError) throw txError
  if (!txRow) return []
  const transaction = txRow as { date: string; currency: string | null }

  const ids = Array.from(new Set(allocations.map((a) => (a.kind === 'customer_invoice' ? a.invoice_id : a.supplier_invoice_id))))
  const invoices = new Map<string, { partyId: string; invoice: BatchAllocationFacts['invoice'] }>()
  for (const part of chunk(ids, ID_READ_CHUNK)) {
    if (isCustomer) {
      const { data, error } = await supabase
        .from('invoices')
        .select('id, customer_id, currency, remaining_amount, total')
        .in('id', part)
        .eq('company_id', companyId)
      if (error) throw error
      for (const row of (data ?? []) as Array<{ id: string; customer_id: string; currency: string | null; remaining_amount: number | null; total: number }>) {
        invoices.set(row.id, { partyId: row.customer_id, invoice: row })
      }
    } else {
      const { data, error } = await supabase
        .from('supplier_invoices')
        .select('id, supplier_id, currency, remaining_amount, total')
        .in('id', part)
        .eq('company_id', companyId)
      if (error) throw error
      for (const row of (data ?? []) as Array<{ id: string; supplier_id: string; currency: string | null; remaining_amount: number | null; total: number }>) {
        invoices.set(row.id, { partyId: row.supplier_id, invoice: row })
      }
    }
  }
  if (ids.some((id) => !invoices.has(id))) return []

  const linkBasis = linkBasisColumns('user_confirmed')
  return allocations.map((a) => {
    const invoiceId = a.kind === 'customer_invoice' ? a.invoice_id : a.supplier_invoice_id
    const { partyId, invoice } = invoices.get(invoiceId)!
    return batchAllocationBusinessEvent({ kind: a.kind, invoiceId, partyId, amount: a.amount, invoice }, transaction, linkBasis)
  })
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
  guard: {
    overriddenBy: string | null
    detectFailed: boolean
    registrations: Extract<RegistrationFirstPlan, { required: true }>[]
    sales: RequiredSaleFirstPlan[]
    /** Kontantmetoden: the lines each unbooked invoice books in place of 1510. */
    cashLines?: Record<string, BatchCashLine[]>
  },
): Promise<OperationOutcome<MatchBatchResult>> {
  const { supabase, companyId, log } = ctx
  const { allocations } = input

  const { data: txRow, error: txError } = await supabase
    .from('transactions')
    .select('id, description, merchant_name, amount, currency, date, cash_account_id')
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
    cash_account_id: string | null
  }
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

  // What a foreign invoice clears: what the ledger carries, read here as the
  // RPC reads it under its locks. A sale or registration booked first has no
  // voucher yet, so its dry run says. An amount past the limit is the RPC's
  // refusal, answered on the dry run so a staged booking never waits for an
  // approval that cannot post.
  const bookedFirst = new Map<string, number>([
    ...guard.registrations.map((plan): [string, number] => [plan.supplierInvoiceId, plan.payableSek]),
    ...guard.sales.map((plan): [string, number] => [plan.invoiceId, plan.receivableSek]),
  ])
  for (const allocation of allocations) {
    const id = allocation.kind === 'customer_invoice' ? allocation.invoice_id : allocation.supplier_invoice_id
    const invoice = invoices.get(id)
    if (!invoice || isKronorCurrency(invoice.currency)) continue
    try {
      invoice.carried_sek =
        bookedFirst.get(id) ?? (await carriedSekOf(supabase, companyId, isCustomer ? 'customer' : 'supplier', { id, currency: invoice.currency }))
    } catch (err) {
      return failed(err)
    }
    const remaining = invoice.remaining_amount ?? invoice.total
    if (remaining == null || !(Number(invoice.exchange_rate) > 0)) continue
    const bookedSek = clearedSek({ amount: remaining, remaining, carried: invoice.carried_sek, rate: Number(invoice.exchange_rate) })
    if (fxDeviationTooLarge(allocation.amount, bookedSek)) {
      return {
        ok: false,
        code: 'BATCH_FX_DEVIATION_TOO_LARGE',
        details: { invoice_id: id, allocation_amount: allocation.amount, expected_sek: bookedSek },
      }
    }
  }

  const totalAllocated = roundOre(allocations.reduce((sum, a) => sum + a.amount, 0))
  const txAbs = Math.abs(transaction.amount)
  const totalFees = payoutFeeTotal(input.fees)
  const settled = payoutBankAmount(allocations[0]!.kind, totalAllocated, totalFees)
  const sums = { total_allocated: totalAllocated, ...(totalFees > 0 ? { total_fees: totalFees } : {}), transaction_amount: txAbs }
  if (settled - txAbs > 0.005) return { ok: false, code: 'BATCH_AMOUNT_EXCEEDS_TX', details: sums }
  if (txAbs - settled > 0.005) return { ok: false, code: 'BATCH_AMOUNT_BELOW_TX', details: sums }

  // A fee books on an active account of the company's chart, as the RPC
  // checks at commit (BATCH_FEE_ACCOUNT_INVALID).
  const feeAccounts = Array.from(new Set((input.fees ?? []).map((fee) => fee.account)))
  if (feeAccounts.length > 0) {
    const { data: chartRows, error: chartError } = await supabase
      .from('chart_of_accounts')
      .select('account_number')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .in('account_number', feeAccounts)
    if (chartError) return failed(chartError)
    const active = new Set(((chartRows ?? []) as { account_number: string }[]).map((row) => row.account_number))
    const inactive = feeAccounts.find((account) => !active.has(account))
    if (inactive) return { ok: false, code: 'BATCH_FEE_ACCOUNT_INVALID', details: { account: inactive } }
  }

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
    transaction: { amount: transaction.amount, date: transaction.date },
    bankAccount,
    allocations,
    invoices,
    fees: input.fees,
    cashLines: guard.cashLines,
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
      ...(totalFees > 0 ? { total_fees: totalFees } : {}),
      expected_entry_date: expected.entry_date,
      expected_description: expected.description,
      expected_lines: expected.lines,
      expected_lines_balanced: expected.balanced,
      expected_fx: expected.fx,
      ...(guard.overriddenBy ? { already_explained_override: true, already_explained_by: guard.overriddenBy } : {}),
      ...(guard.detectFailed ? { duplicate_check_failed: true } : {}),
      // The registration verifikat booked first per supplier invoice
      // (defer_invoice_booking), before the samlingsverifikation.
      ...(guard.registrations.length > 0
        ? {
            books_registration_first: true,
            registration_entries: guard.registrations.map((plan) => ({
              supplier_invoice_id: plan.supplierInvoiceId,
              journal_entry: plan.entry,
            })),
          }
        : {}),
      // The sale verifikat booked first per customer invoice
      // (defer_invoice_booking), before the samlingsverifikation.
      ...(guard.sales.length > 0
        ? {
            books_sale_first: true,
            sale_entries: guard.sales.map((plan) => ({ invoice_id: plan.invoiceId, journal_entry: plan.entry })),
          }
        : {}),
    },
  }
}
