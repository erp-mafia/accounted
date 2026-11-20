/**
 * A samlingsbetalning of ONE supplier invoice that kontantmetoden left
 * unbooked (PH 243): booked by the single bank match the dashboard's dialog
 * books (bookSupplierBankMatch), so there is no second kontantmetoden
 * booking.
 *
 * Under kontantmetoden a registered supplier invoice has no verifikat: the
 * cost and the ingående moms are booked when it is paid. match_batch_allocate
 * clears 2440 and carries kontantmetoden lines for customer invoices only, so
 * it refused this payment with BATCH_CASH_METHOD_UNBOOKED_INVOICE, and an
 * agent had no door to book it (gnubok_match_transaction_to_invoice takes
 * incoming rows only). One invoice on one bank row is exactly the single
 * match, so the batch hands it there: the same plan
 * (planSupplierBankMatch), the same lines (buildSupplierBankMatchLines) for
 * the dry run the approver sees, and the same function for the commit, with
 * every guard it runs (the booked-row gate, the duplicate detector, the
 * period gate, the full-payment rule).
 *
 * Only that shape is handed over (singleSupplierAllocation in
 * lib/transactions/match-batch.ts): one supplier allocation, no fee rows, the
 * allocation equal to the bank row (the batch's own sum rule). Several
 * invoices on one payment still refuse, as before. Reached through
 * batch-cash-method-guard.ts, the batch's one door to its kontantmetoden rules.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { MatchBatchAllocation, MatchBatchResult } from '@/lib/transactions/match-batch'
import { bookSupplierBankMatch, supplierBankMatchFx } from '@/lib/invoices/book-supplier-bank-match'
import { planSupplierBankMatch } from '@/lib/invoices/apply-supplier-payment'
import { buildSupplierBankMatchLines } from '@/lib/bookkeeping/supplier-bank-match-entry'
import { fetchChartVatTreatments } from '@/lib/bookkeeping/chart-vat-treatments'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import type { SupplierInvoice, Transaction } from '@/types'

export type SupplierAllocation = MatchBatchAllocation & { kind: 'supplier_invoice'; supplier_invoice_id: string }

export async function settleSingleSupplierPayment(
  ctx: OperationContext,
  transactionId: string,
  allocation: SupplierAllocation,
  options: { dryRun: boolean },
): Promise<OperationOutcome<MatchBatchResult>> {
  const { supabase, companyId, userId, log } = ctx

  const { data: txRow, error: txError } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (txError) return { ok: false, code: 'UNKNOWN_ERROR', error: txError }
  if (!txRow) return { ok: false, code: 'BATCH_TX_NOT_FOUND' }
  const transaction = txRow as Transaction
  if (transaction.amount === 0) return { ok: false, code: 'BATCH_TX_ZERO_AMOUNT' }
  if (transaction.amount > 0) return { ok: false, code: 'BATCH_DIRECTION_MISMATCH' }
  if (transaction.supplier_invoice_id) {
    return {
      ok: false,
      code: 'MATCH_SI_TX_ALREADY_LINKED',
      details: { existingSupplierInvoiceId: transaction.supplier_invoice_id },
    }
  }

  // The batch's own sum rule: the allocation is the whole row.
  const txAbs = Math.abs(transaction.amount)
  const sums = { total_allocated: allocation.amount, transaction_amount: txAbs }
  if (allocation.amount - txAbs > 0.005) return { ok: false, code: 'BATCH_AMOUNT_EXCEEDS_TX', details: sums }
  if (txAbs - allocation.amount > 0.005) return { ok: false, code: 'BATCH_AMOUNT_BELOW_TX', details: sums }

  const { data: invoiceRow, error: invoiceError } = await supabase
    .from('supplier_invoices')
    .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
    .eq('id', allocation.supplier_invoice_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (invoiceError) return { ok: false, code: 'UNKNOWN_ERROR', error: invoiceError }
  if (!invoiceRow) {
    return { ok: false, code: 'BATCH_SUPPLIER_INVOICE_NOT_FOUND', details: { missing: [allocation.supplier_invoice_id] } }
  }
  const invoice = invoiceRow as SupplierInvoice
  if (invoice.status === 'paid' || invoice.status === 'credited') {
    return {
      ok: false,
      code: 'BATCH_SUPPLIER_INVOICE_NOT_OPEN',
      details: { supplier_invoice_id: invoice.id, status: invoice.status },
    }
  }

  if (options.dryRun) {
    // The lines the dashboard's preview shows for the same row and invoice,
    // on the account the commit credits (bookSupplierBankMatch's own call).
    let paymentAccount: string
    try {
      paymentAccount = await resolveSettlementAccount(supabase, companyId, transaction.cash_account_id, log)
    } catch (err) {
      return { ok: false, code: 'UNKNOWN_ERROR', error: err }
    }
    const fx = await supplierBankMatchFx(supabase, companyId, invoice, transaction, { dryRun: true })
    const planned = planSupplierBankMatch({ invoice, transaction, accountingMethod: 'cash', ...fx })
    if (!planned.ok) return { ok: false, code: planned.code, details: planned.details }
    const { plan } = planned
    const chartVatTreatments =
      plan.booking.kind === 'cash' && invoice.reverse_charge ? await fetchChartVatTreatments(supabase, companyId) : undefined
    let built: ReturnType<typeof buildSupplierBankMatchLines>
    try {
      built = buildSupplierBankMatchLines(invoice, plan.booking, paymentAccount, chartVatTreatments)
    } catch (err) {
      if ((err as { code?: unknown })?.code === 'SI_FX_RATE_MISSING') {
        return { ok: false, code: 'SI_FX_RATE_MISSING', details: { invoice_currency: invoice.currency } }
      }
      return { ok: false, code: 'UNKNOWN_ERROR', error: err }
    }
    const lines = built.lines.map((line) => ({
      account_number: line.account_number,
      description: line.line_description ?? '',
      debit: line.debit_amount,
      credit: line.credit_amount,
    }))
    const balance = lineBalance(built.lines)
    return {
      ok: true,
      dryRun: true,
      preview: {
        transaction_id: transaction.id,
        transaction_description: transaction.merchant_name || transaction.description || null,
        transaction_amount: transaction.amount,
        transaction_currency: transaction.currency ?? 'SEK',
        transaction_date: transaction.date,
        allocations_count: 1,
        allocations_kind: 'supplier_invoice',
        total_allocated: allocation.amount,
        expected_entry_date: transaction.date,
        expected_description: built.description,
        expected_lines: lines,
        expected_lines_balanced: balance.balanced,
        expected_fx: 'none',
        // Kontantmetoden: the cost and the moms are booked here, at payment.
        books_cost_at_payment: plan.booking.kind === 'cash',
      },
    }
  }

  const booked = await bookSupplierBankMatch(supabase, {
    transaction,
    invoice,
    userId,
    companyId,
    log,
    match: { action: 'matched', method: 'batch_single_supplier', confidence: 1.0 },
    linkBasis: { basis: 'user_confirmed' },
  })
  if (!booked.ok) {
    return booked.error !== undefined
      ? { ok: false, code: booked.code, error: booked.error }
      : { ok: false, code: booked.code, ...(booked.details ? { details: booked.details } : {}) }
  }

  const { data: entry } = await supabase
    .from('journal_entries')
    .select('voucher_series, voucher_number')
    .eq('id', booked.journalEntryId)
    .eq('company_id', companyId)
    .maybeSingle()
  const voucher = (entry ?? {}) as { voucher_series?: string | null; voucher_number?: number | null }

  return {
    ok: true,
    data: {
      journal_entry_id: booked.journalEntryId,
      voucher_series: voucher.voucher_series ?? '',
      voucher_number: voucher.voucher_number ?? 0,
      allocations: [
        {
          kind: 'supplier_invoice',
          supplier_invoice_id: invoice.id,
          payment_id: booked.paymentRowId,
          status: booked.plan.newStatus === 'paid' ? 'paid' : 'partially_paid',
          paid_amount: booked.plan.newPaidAmount,
          remaining_amount: booked.plan.newRemaining,
          amount: allocation.amount,
        },
      ],
      total_allocated: allocation.amount,
      leftover: 0,
      ...(booked.registrationJournalEntryId
        ? { registration_journal_entry_ids: { [invoice.id]: booked.registrationJournalEntryId } }
        : {}),
    },
  }
}
