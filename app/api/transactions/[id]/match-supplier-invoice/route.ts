import { NextResponse } from 'next/server'
import {
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { buildSupplierPaymentClearingLines } from '@/lib/bookkeeping/supplier-payment-lines'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { planSupplierPayment } from '@/lib/invoices/apply-supplier-payment'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { eventBus } from '@/lib/events/bus'
import { ensureInitialized } from '@/lib/init'
import type { SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

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

    // Pure SEK settlements route through the shared clearing builder so öre
    // rounding lands on 3740 and the invoice settles in full; foreign legs keep
    // the kursvinst/kursförlust path in createSupplierInvoicePaymentEntry.
    const isPureSek = transaction.currency === 'SEK' && invoice.currency === 'SEK'

    // Amount in the *invoice's* currency: used to update
    // supplier_invoices.paid_amount/remaining_amount and the
    // supplier_invoice_payments row (whose `currency` is the invoice's).
    // When the bank transaction is in a different currency from the
    // invoice (e.g. paying a USD invoice from a SEK account) we treat the
    // match as a full payment of whatever remains, rather than storing the
    // SEK number with the invoice's currency suffix: which would render
    // as "Betalt 239 USD" on a 25 USD invoice.
    const paymentAmountInvoiceCurrency =
      transaction.currency === invoice.currency
        ? txAmountAbs
        : invoice.remaining_amount

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'

    // Credit the cash account THIS transaction actually belongs to, never a
    // company-wide "last used" preference: last_supplier_payment_account is
    // written by the manual mark-paid flow (e.g. a private-funds payment
    // booked to 2893) and has no relationship to which bank account a real,
    // matched transaction settled from. Reusing it here silently misbooked a
    // genuine 1930 bank payment to 2893 once a private payment had set that
    // sticky default.
    const paymentAccount = await resolveSettlementAccount(
      supabase,
      companyId!,
      transaction.cash_account_id,
      txLog,
    )

    // Route on the supplier invoice's actual booking state: if 2440 was posted
    // at receipt (accrual), the match clears 2440 regardless of the company's
    // current setting. Only true kontantmetoden invoices (no registration JE)
    // book expense + input VAT here.
    const siAlreadyBooked = !!(invoice as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    // Ledger math + overshoot guard in one place (mirrors planInvoicePayment on
    // the customer side). Öre absorption applies ONLY to the accrual SEK clearing
    // path: there a whole-krona payment within 1 kr settles the invoice in full
    // and the residual is booked to 3740 by the line builder. Cash-method entries
    // book the full invoice total (not the bank amount), so absorbing there would
    // mark the invoice paid while leaving a hidden 1930 discrepancy: keep strict.
    // Rejecting here, BEFORE any JE is created, keeps a doomed overshoot from
    // burning a voucher number.
    const paymentPlan = planSupplierPayment(invoice, paymentAmountInvoiceCurrency, {
      absorbOreRounding: isPureSek && !useCashEntry,
    })
    if (!paymentPlan.ok) {
      return errorResponseFromCode('MATCH_SI_AMOUNT_EXCEEDS_REMAINING', txLog, {
        requestId,
        details: paymentPlan.details,
      })
    }

    // SEK that actually left the bank, when we know it. SEK transaction → the
    // absolute amount; foreign transaction with a stored amount_sek → that
    // value; foreign transaction WITHOUT amount_sek → unknown (null). The raw
    // foreign amount must never stand in here: treating 19 USD as 19 SEK is
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
    // bank figure to reconcile against"). The FX diff hits 7960/3960 so 2440
    // clears cleanly whenever bank-paid SEK genuinely differs from booked SEK.
    //
    // When BOTH are unknown (foreign bank line without amount_sek paying a
    // foreign invoice without exchange_rate) there is no SEK figure at all.
    // The old last resort was the raw foreign amount, which is precisely what
    // the comment above forbids: 19 USD posted as 19 kr on a ~175 kr payment,
    // and the entry still balances so no trigger catches it. Refuse instead,
    // same policy as the match_batch_allocate RPC (BATCH_FX_RATE_MISSING) and
    // toSekOrThrow() in the entry generators. Rejecting here, before any JE or
    // ledger write, leaves the match fully retryable once the rate is filled in.
    const actualBankSek = bankSekStored ?? bookedSek
    if (actualBankSek == null) {
      return errorResponseFromCode('SI_FX_RATE_MISSING', txLog, {
        requestId,
        details: {
          transaction_currency: transaction.currency,
          invoice_currency: invoice.currency,
        },
      })
    }
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

    // A full settlement pays off the whole remaining balance. Cross-currency
    // matches always do (paymentAmountInvoiceCurrency is clamped to
    // invoice.remaining_amount above); same-currency does when the bank amount
    // covers the remaining balance.
    const fullSettlement =
      transaction.currency !== invoice.currency ||
      txAmountAbs >= invoice.remaining_amount - 0.005

    // Cash method (kontantmetoden) collapses registration + payment into a
    // single entry. Under the cash method the expense is recognised AT PAYMENT
    // at the payment-date rate, so there is no kursvinst/kursförlust: we hand
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

    // Verifikat header description, shared by every booking branch below.
    const desc = invoice.supplier?.name
      ? `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}, ${invoice.supplier.name}`
      : `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}`

    let journalEntryId: string | null = null

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
          paymentAccount,
          // Pin a foreign-currency settlement to the payment-date rate so the
          // settlement account equals the bank movement (kontantmetoden books
          // the expense at payment). No-op for SEK invoices and same-rate
          // settlements.
          exchangeRateDifference !== 0 && fullSettlement ? actualBankSek : undefined,
        )
        if (journalEntry) journalEntryId = journalEntry.id
      } else if (isPureSek) {
        // SEK clearing through the shared builder: a sub-krona difference is
        // booked to 3740 and 2440 is cleared in full (invoice → paid); an exact
        // or ≥1 kr-short payment clears what moved. Byte-identical to the preview
        // (same payment account + line descriptions). No FX here by definition.
        const fiscalPeriodId = await findFiscalPeriod(supabase, companyId!, transaction.date)
        if (!fiscalPeriodId) {
          return errorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', txLog, {
            requestId,
            details: { paymentDate: transaction.date },
          })
        }
        const { lines } = buildSupplierPaymentClearingLines({
          apSek: invoice.remaining_amount,
          bankSek: txAmountAbs,
          paymentAccount,
        })
        const journalEntry = await createJournalEntry(supabase, companyId!, user.id, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: desc,
          source_type: 'supplier_invoice_paid',
          source_id: invoice.id,
          lines,
        })
        if (journalEntry) journalEntryId = journalEntry.id
      } else {
        const journalEntry = await createSupplierInvoicePaymentEntry(
          supabase, companyId, user.id, invoice as SupplierInvoice,
          paymentAmountSek, transaction.date,
          exchangeRateDifference !== 0 ? exchangeRateDifference : undefined,
          undefined, // supplierName (unchanged default)
          paymentAccount,
        )
        if (journalEntry) journalEntryId = journalEntry.id
      }
    } catch (err) {
      txLog.error('failed to create supplier invoice payment journal entry', err as Error)
      // A failed payment voucher must fail the whole match. Proceeding used to
      // mark the invoice paid with NO voucher: an unrecoverable half-state:
      // mark-paid rejects 'paid' invoices and this route rejects linked
      // transactions, so no flow could ever complete the booking afterwards.
      // The cash-method builder converts every leg through toSekOrThrow, so a
      // foreign invoice with no usable rate surfaces here as
      // SupplierInvoiceFxRateMissingError. Dispatch on its `code` (not
      // instanceof: the class is routinely vi.mock'ed away) so errorResponse
      // maps it to the registered 400 "ange fakturans växelkurs" entry instead
      // of a generic 500. Same code the preview returns for the same row.
      if ((err as { code?: unknown })?.code === 'SI_FX_RATE_MISSING') {
        return errorResponse(err, txLog, { requestId })
      }
      if (isBookkeepingError(err)) {
        return errorResponse(err, txLog, { requestId })
      }
      return errorResponseFromCode('MATCH_SI_JE_FAILED', txLog, {
        requestId,
        details: { reason: err instanceof Error ? getUserErrorMessage(err) : 'unknown' },
      })
    }

    if (!journalEntryId) {
      return errorResponseFromCode('MATCH_SI_JE_FAILED', txLog, { requestId })
    }

    // Ledger update from the plan computed up front. An öre-absorbed settlement
    // reports remaining 0 / status paid even though the bank paid a sub-krona
    // less (or more): the residual lives on 3740, not the supplier ledger.
    const { newRemaining, newPaidAmount, isFullyPaid, newStatus } = paymentPlan.plan
    const paidAt = isFullyPaid ? paidAtFromDate(transaction.date) : null

    const { data: updatedRows, error: updateInvError } = await supabase
      .from('supplier_invoices')
      .update({
        status: newStatus,
        remaining_amount: newRemaining,
        paid_amount: newPaidAmount,
        paid_at: paidAt,
        payment_journal_entry_id: journalEntryId,
        transaction_id: transactionId,
      })
      .eq('id', supplier_invoice_id)
      .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
      .select('id')

    if (updateInvError) {
      txLog.error('failed to update supplier invoice', updateInvError)
      return errorResponse(updateInvError, txLog, { requestId })
    }

    if (!updatedRows || updatedRows.length === 0) {
      // CAS guard: the invoice was settled by a concurrent request between
      // our read and write. The payment voucher we just posted belongs to no
      // payment: cancel it and document the gap (mirrors mark-paid).
      await cancelOrphanedPaymentEntry(
        supabase, companyId!, user.id, journalEntryId,
        'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
      )
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

    // The invoice is now settled, so every OTHER transaction still carrying a
    // suggestion pointer at it is dead: retire them (issue #1259). This
    // request's own row is cleared by the update just below.
    if (isFullyPaid) {
      await clearSettledInvoiceSuggestions(
        supabase,
        companyId!,
        'supplier_invoice',
        supplier_invoice_id,
        { exceptTransactionId: transactionId },
      )
    }

    const { error: updateTxError } = await supabase
      .from('transactions')
      .update({
        supplier_invoice_id,
        // Clear the suggestion now that it is a confirmed link, mirroring the
        // customer-invoice route. Leaving it set kept a pointer at an invoice
        // this very request just marked paid, i.e. the stale-pointer state
        // every read path now has to defend against.
        potential_supplier_invoice_id: null,
        journal_entry_id: journalEntryId,
        is_business: true,
      })
      .eq('id', transactionId)

    if (updateTxError) {
      txLog.error('failed to link transaction to supplier invoice', updateTxError)
      return errorResponseFromCode('MATCH_SI_LINK_TX_FAILED', txLog, { requestId })
    }

    // Propagate a document pinned to the transaction (via /attach-document or
    // MCP) onto the payment verifikat, mirroring the categorize route (BFL
    // 5 kap 6 §: the verifikation must reference its underlag). Guarded to
    // unlinked current-version docs only: a doc already serving another
    // verifikat (e.g. the supplier invoice's own document on the registration
    // entry) must not move. Non-fatal: the match is already committed.
    if (transaction.document_id) {
      const { error: docLinkError } = await supabase
        .from('document_attachments')
        .update({ journal_entry_id: journalEntryId })
        .eq('id', transaction.document_id)
        .eq('company_id', companyId)
        .is('journal_entry_id', null)
        .eq('is_current_version', true)
      if (docLinkError) {
        // Structured fields so the half-linked state (doc retained but not
        // anchored to the payment JE) can be reconstructed without an audit
        // trail dig.
        txLog.warn('failed to link transaction document to payment JE (non-critical)', {
          error: docLinkError,
          documentId: transaction.document_id,
          journalEntryId,
        })
      }
    }

    // Same requirement one table over: the SUPPLIER INVOICE's own retained
    // document must sit on a posted verifikat, or the payment verifikat we
    // just booked shows the invoice PDF while every missing-underlag surface
    // (which only accepts an anchored doc) warns "Underlag saknas". No-op when
    // it is already anchored, e.g. on the registration verifikat.
    await anchorSupplierInvoiceDocument(supabase, companyId, supplier_invoice_id)

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
          supplierInvoice: {
            ...invoice,
            status: newStatus,
            remaining_amount: newRemaining,
            paid_amount: newPaidAmount,
            paid_at: paidAt,
            payment_journal_entry_id: journalEntryId,
            transaction_id: transactionId,
          } as SupplierInvoice,
          transaction: {
            ...transaction,
            supplier_invoice_id,
            potential_supplier_invoice_id: null,
            journal_entry_id: journalEntryId,
            is_business: true,
          } as Transaction,
          userId: user.id,
          companyId,
        },
      })
    } catch (err) {
      txLog.warn('supplier_invoice.match_confirmed event emission failed', err as Error)
    }

    return NextResponse.json({
      success: true,
      invoice_status: newStatus,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
      journal_entry_id: journalEntryId,
    })
  },
  { requireWrite: true },
)
