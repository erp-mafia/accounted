import { NextResponse } from 'next/server'
import {
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'

ensureInitialized()

/**
 * POST /api/transactions/[id]/match-supplier-invoice
 *
 * Match a negative transaction (expense) to a supplier invoice.
 */
export const POST = withRouteContext(
  'transaction.match_supplier_invoice',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id: transactionId } = await params
    const { user, supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, MatchSupplierInvoiceSchema, {
      log,
      operation: 'transaction.match_supplier_invoice',
    })
    if (!validation.success) return validation.response
    const { supplier_invoice_id, lines: customLines } = validation.data

    const txLog = log.child({ transactionId, supplierInvoiceId: supplier_invoice_id })

    const { data: transaction, error: fetchTxError } = await supabase
      .from('transactions')
      .select('*')
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .single()

    if (fetchTxError || !transaction) {
      return errorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, { requestId })
    }

    if (transaction.amount >= 0) {
      return errorResponseFromCode('MATCH_SI_NOT_EXPENSE', txLog, {
        requestId,
        details: { amount: transaction.amount },
      })
    }

    if (transaction.supplier_invoice_id) {
      return errorResponseFromCode('MATCH_SI_TX_ALREADY_LINKED', txLog, {
        requestId,
        details: { existingSupplierInvoiceId: transaction.supplier_invoice_id },
      })
    }

    const { data: invoice, error: fetchInvError } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', supplier_invoice_id)
      .eq('company_id', companyId)
      .single()

    if (fetchInvError || !invoice) {
      return errorResponseFromCode('MATCH_SI_NOT_FOUND', txLog, { requestId })
    }

    if (invoice.status === 'paid' || invoice.status === 'credited') {
      return errorResponseFromCode('MATCH_SI_ALREADY_PAID', txLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    const txAmountAbs = Math.abs(transaction.amount)

    // Overshoot guard for the same-currency branch. The legacy code path used
    // txAmountAbs wholesale and would push supplier_invoices.paid_amount past
    // invoice.total whenever the bank transaction was larger than what was
    // owed. Reject and direct the user at the split-payment flow which can
    // allocate the excess to additional supplier invoices.
    // FX branch (currency mismatch) is already clamped below to
    // invoice.remaining_amount, so it cannot overshoot.
    if (
      transaction.currency === invoice.currency &&
      txAmountAbs > invoice.remaining_amount + 0.005
    ) {
      return errorResponseFromCode('MATCH_SI_AMOUNT_EXCEEDS_REMAINING', txLog, {
        requestId,
        details: {
          transaction_amount: txAmountAbs,
          remaining_amount: Math.round(invoice.remaining_amount * 100) / 100,
          excess: Math.round((txAmountAbs - invoice.remaining_amount) * 100) / 100,
        },
      })
    }

    // Amount in the *invoice's* currency — used to update
    // supplier_invoices.paid_amount/remaining_amount and the
    // supplier_invoice_payments row (whose `currency` is the invoice's).
    // When the bank transaction is in a different currency from the
    // invoice (e.g. paying a USD invoice from a SEK account) we treat the
    // match as a full payment of whatever remains, rather than storing the
    // SEK number with the invoice's currency suffix — which would render
    // as "Betalt 239 USD" on a 25 USD invoice.
    const paymentAmountInvoiceCurrency =
      transaction.currency === invoice.currency
        ? txAmountAbs
        : invoice.remaining_amount

    // SEK that actually left the bank, when we know it. SEK transaction → the
    // absolute amount; foreign transaction with a stored amount_sek → that
    // value; foreign transaction WITHOUT amount_sek → unknown (null). The raw
    // foreign amount must never stand in here — treating 19 USD as 19 SEK is
    // exactly the bug that books "19 kr" on a ~175 kr payment.
    const bankSekStored =
      transaction.currency === 'SEK'
        ? txAmountAbs
        : transaction.amount_sek != null
          ? Math.abs(transaction.amount_sek)
          : null

    // SEK the invoice was booked at for this payment portion:
    //   - SEK invoice: face value = paymentAmountInvoiceCurrency
    //   - Non-SEK invoice w/ exchange_rate: portion × rate
    //   - Non-SEK invoice w/o exchange_rate: can't compute (null)
    const invoiceFxRate = invoice.exchange_rate ?? null
    const bookedSek =
      invoice.currency === 'SEK'
        ? paymentAmountInvoiceCurrency
        : invoiceFxRate && invoiceFxRate > 0
          ? Math.round(paymentAmountInvoiceCurrency * invoiceFxRate * 100) / 100
          : null

    // Actual SEK leaving the bank. Prefer the stored bank figure; if a foreign
    // transaction has no amount_sek, fall back to the invoice's booked SEK so
    // the magnitude is right (→ exchangeRateDifference 0, i.e. "no independent
    // bank figure to reconcile against"). Last resort, with no invoice rate
    // either, is the raw amount. The FX diff hits 7960/3960 so 2440 clears
    // cleanly whenever bank-paid SEK genuinely differs from booked SEK.
    const actualBankSek = bankSekStored ?? bookedSek ?? txAmountAbs
    const originalBookedSek = bookedSek ?? actualBankSek

    // Positive = gain (AP credited at more SEK than the bank actually paid).
    // Negative = loss (bank paid more SEK than the AP we owed).
    const exchangeRateDifference =
      Math.round((originalBookedSek - actualBankSek) * 100) / 100

    // `paymentAmountSek` is what we pass to the payment-entry builder. In
    // the FX branch (non-zero exchangeRateDifference) it represents the
    // ORIGINAL booked SEK on 2440; the builder then computes actualSekPaid
    // as paymentAmountSek - exchangeRateDifference internally.
    const paymentAmountSek = exchangeRateDifference !== 0 ? originalBookedSek : actualBankSek

    const now = new Date().toISOString()

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'

    // Route on the supplier invoice's actual booking state — if 2440 was
    // posted at receipt (accrual), the match must clear 2440 regardless of
    // the company's current setting. Only true kontantmetoden invoices
    // (no registration JE) book expense + input VAT here.
    const siAlreadyBooked = !!(invoice as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    // A full settlement pays off the whole remaining balance. Cross-currency
    // matches always do (paymentAmountInvoiceCurrency is clamped to
    // invoice.remaining_amount above); same-currency does when the bank amount
    // covers the remaining balance.
    const fullSettlement =
      transaction.currency !== invoice.currency ||
      txAmountAbs >= invoice.remaining_amount - 0.005

    // Cash method (kontantmetoden) collapses registration + payment into a
    // single entry. Under the cash method the expense is recognised AT PAYMENT
    // at the payment-date rate, so there is no kursvinst/kursförlust — we hand
    // the builder the actual bank SEK (settledBankSek) and it translates the
    // whole verifikat to that, leaving 1930 equal to the bank transaction.
    // The only combination we still can't model is a PARTIAL cash-method
    // payment across rates: the cash builder books the full invoice, so a
    // partial bank amount can't pin the entry cleanly. That narrow case stays
    // blocked (switch to accrual or book manually).
    if (useCashEntry && exchangeRateDifference !== 0 && !fullSettlement) {
      return errorResponseFromCode('MATCH_SI_CASH_FX_UNSUPPORTED', txLog, {
        requestId,
        details: {
          exchangeRateDifference,
          invoiceCurrency: invoice.currency,
          transactionCurrency: transaction.currency,
        },
      })
    }

    let journalEntryId: string | null = null
    let journalEntryError: string | null = null

    try {
      if (customLines) {
        const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
        const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
        if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
          return errorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', txLog, {
            requestId,
            details: { totalDebit, totalCredit },
          })
        }
        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId!, transaction.date)
        if (!fiscalPeriodId) {
          return errorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', txLog, {
            requestId,
            details: { paymentDate: transaction.date },
          })
        }
        const sourceType = useCashEntry ? 'supplier_invoice_cash_payment' : 'supplier_invoice_paid'
        const desc = invoice.supplier?.name
          ? `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}, ${invoice.supplier.name}`
          : `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}`
        const journalEntry = await createJournalEntry(supabase, companyId!, user.id, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: desc,
          source_type: sourceType,
          source_id: invoice.id,
          lines: customLines,
        })
        if (journalEntry) journalEntryId = journalEntry.id
      } else if (useCashEntry) {
        const journalEntry = await createSupplierInvoiceCashEntry(
          supabase, companyId, user.id, invoice as SupplierInvoice,
          (invoice.items || []) as SupplierInvoiceItem[],
          transaction.date,
          invoice.supplier?.supplier_type || 'swedish_business',
          undefined, // supplierName (unchanged default)
          undefined, // paymentAccount (unchanged default 1930)
          // Pin a foreign-currency settlement to the payment-date rate so 1930
          // equals the bank movement (kontantmetoden books the expense at
          // payment). No-op for SEK invoices and same-rate settlements.
          exchangeRateDifference !== 0 && fullSettlement ? actualBankSek : undefined,
        )
        if (journalEntry) journalEntryId = journalEntry.id
      } else {
        const journalEntry = await createSupplierInvoicePaymentEntry(
          supabase, companyId, user.id, invoice as SupplierInvoice,
          paymentAmountSek, transaction.date,
          exchangeRateDifference !== 0 ? exchangeRateDifference : undefined,
        )
        if (journalEntry) journalEntryId = journalEntry.id
      }
    } catch (err) {
      txLog.error('failed to create supplier invoice payment journal entry', err as Error)
      // Bookkeeping errors with structured codes get a Swedish translation;
      // otherwise pass-through. Match still proceeds — the user can re-book.
      if (isBookkeepingError(err)) {
        journalEntryError = getErrorMessage(err, { context: 'supplier_invoice' })
      } else {
        journalEntryError = err instanceof Error ? err.message : 'Unknown error'
      }
    }

    const newRemaining = Math.max(0, Math.round((invoice.remaining_amount - paymentAmountInvoiceCurrency) * 100) / 100)
    const newPaidAmount = Math.round((invoice.paid_amount + paymentAmountInvoiceCurrency) * 100) / 100
    const isFullyPaid = newRemaining <= 0
    const newStatus = isFullyPaid ? 'paid' : 'partially_paid'

    const { data: updatedRows, error: updateInvError } = await supabase
      .from('supplier_invoices')
      .update({
        status: newStatus,
        remaining_amount: newRemaining,
        paid_amount: newPaidAmount,
        paid_at: isFullyPaid ? now : null,
        payment_journal_entry_id: journalEntryId,
        transaction_id: transactionId,
      })
      .eq('id', supplier_invoice_id)
      .in('status', ['registered', 'approved', 'partially_paid'])
      .select('id')

    if (updateInvError) {
      txLog.error('failed to update supplier invoice', updateInvError)
      return errorResponse(updateInvError, txLog, { requestId })
    }

    if (!updatedRows || updatedRows.length === 0) {
      return errorResponseFromCode('MATCH_SI_NOT_OPEN', txLog, { requestId })
    }

    const { error: paymentInsertError } = await supabase
      .from('supplier_invoice_payments')
      .insert({
        user_id: user.id,
        company_id: companyId,
        supplier_invoice_id,
        payment_date: transaction.date,
        amount: paymentAmountInvoiceCurrency,
        currency: invoice.currency,
        journal_entry_id: journalEntryId,
        transaction_id: transactionId,
      })

    if (paymentInsertError) {
      if (paymentInsertError.code === '23505') {
        return errorResponseFromCode('MATCH_SI_DUPLICATE_PAYMENT', txLog, { requestId })
      }
      txLog.error('failed to record supplier invoice payment', paymentInsertError)
      return errorResponseFromCode('MATCH_SI_RECORD_PAYMENT_FAILED', txLog, { requestId })
    }

    const { error: updateTxError } = await supabase
      .from('transactions')
      .update({
        supplier_invoice_id,
        journal_entry_id: journalEntryId,
        is_business: true,
      })
      .eq('id', transactionId)

    if (updateTxError) {
      txLog.error('failed to link transaction to supplier invoice', updateTxError)
      return errorResponseFromCode('MATCH_SI_LINK_TX_FAILED', txLog, { requestId })
    }

    logMatchEvent(supabase, user.id, transactionId, 'matched', {
      supplierInvoiceId: supplier_invoice_id,
      matchConfidence: 1.0,
      matchMethod: 'manual_confirm',
      newState: { status: newStatus, paid_amount: newPaidAmount, remaining_amount: newRemaining },
    })

    try {
      eventBus.emit({
        type: 'supplier_invoice.match_confirmed',
        payload: {
          supplierInvoice: invoice as SupplierInvoice,
          transaction: transaction as Transaction,
          userId: user.id,
          companyId,
        },
      })
    } catch (err) {
      txLog.warn('supplier_invoice.match_confirmed event emission failed', err as Error)
    }

    if (journalEntryError) {
      txLog.warn('supplier invoice match recorded but payment JE failed', {
        message: journalEntryError,
      })
    }

    return NextResponse.json({
      success: true,
      invoice_status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      journal_entry_id: journalEntryId,
      ...(journalEntryError ? { journal_entry_error: journalEntryError } : {}),
    })
  },
  { requireWrite: true },
)
