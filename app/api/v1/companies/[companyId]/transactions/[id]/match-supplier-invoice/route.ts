/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-supplier-invoice
 *
 * Match a negative (expense) bank transaction to an open supplier invoice.
 * Mirrors the dashboard's internal route: same FX-difference handling,
 * same cash-method-FX rejection, same optimistic-lock interlock.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { MatchSupplierInvoiceSchema } from '@/lib/api/schemas'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import {
  createSupplierInvoicePaymentEntry,
  createSupplierInvoiceCashEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { reverseEntry, createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { anchorSupplierInvoiceDocument } from '@/lib/core/documents/supplier-invoice-underlag'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { eventBus } from '@/lib/events/bus'
import type { SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'

const MatchSIResponse = z.object({
  success: z.boolean(),
  invoice_status: z.string(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
})

registerEndpoint({
  operation: 'transactions.match-supplier-invoice',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/match-supplier-invoice',
  summary: 'Match a negative bank transaction to a supplier invoice.',
  description:
    'Confirms a supplier invoice payment match. Creates the payment journal entry (accrual: 2440 debit, credit on the transaction\'s own settlement account, 1930 when unlinked; cash-method: collapsed registration+payment), updates supplier_invoices, inserts a supplier_invoice_payments row, and links the transaction. Handles FX differences for cross-currency payments (7960 gain / 3960 loss).',
  useWhen:
    'You have a bank payment and a known open supplier invoice. The transaction must be negative (expense) and unlinked.',
  doNotUseFor:
    'Categorizing a direct supplier expense without an invoice: use `:categorize`. Matching to a customer invoice: use `:match-invoice`. Bulk auto-match: `POST /reconciliation/bank/run`.',
  pitfalls: [
    'Cash-method companies can settle a foreign invoice in full (booked at the payment-date rate); only a PARTIAL cash-method payment across currencies is rejected (MATCH_SI_CASH_FX_UNSUPPORTED): pay in full, switch to accrual, or book manually.',
    'Transaction must be negative (amount < 0). Positive returns MATCH_SI_NOT_EXPENSE.',
    'Supplier invoice must NOT be paid/credited already. paid/credited returns MATCH_SI_ALREADY_PAID; registered/approved/partially_paid/overdue are matchable.',
    'Idempotency-Key is mandatory.',
  ],
  example: {
    request: { supplier_invoice_id: 'si_…' },
    response: {
      data: {
        success: true,
        invoice_status: 'paid',
        paid_amount: 5000,
        remaining_amount: 0,
        journal_entry_id: 'je_…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: MatchSupplierInvoiceSchema },
  response: { success: dataEnvelope(MatchSIResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.match-supplier-invoice',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Transaction id must be a UUID.' },
      })
    }
    const txId = idParse.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = MatchSupplierInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const { supplier_invoice_id, lines: customLines } = parsed.data
    const txLog = ctx.log.child({ transactionId: txId, supplierInvoiceId: supplier_invoice_id })

    const { data: transaction, error: fetchTxErr } = await ctx.supabase
      .from('transactions')
      .select('*')
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
      .single()
    if (fetchTxErr || !transaction) {
      return v1ErrorResponseFromCode('TX_CATEGORIZE_TX_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }
    if (transaction.amount >= 0) {
      return v1ErrorResponseFromCode('MATCH_SI_NOT_EXPENSE', txLog, {
        requestId: ctx.requestId,
        details: { amount: transaction.amount },
      })
    }
    if (transaction.supplier_invoice_id) {
      return v1ErrorResponseFromCode('MATCH_SI_TX_ALREADY_LINKED', txLog, {
        requestId: ctx.requestId,
        details: { existingSupplierInvoiceId: transaction.supplier_invoice_id },
      })
    }

    const { data: invoice, error: fetchInvErr } = await ctx.supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*), items:supplier_invoice_items(*)')
      .eq('id', supplier_invoice_id)
      .eq('company_id', ctx.companyId!)
      .single()
    if (fetchInvErr || !invoice) {
      return v1ErrorResponseFromCode('MATCH_SI_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }
    if (invoice.status === 'paid' || invoice.status === 'credited') {
      return v1ErrorResponseFromCode('MATCH_SI_ALREADY_PAID', txLog, {
        requestId: ctx.requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Credit the cash account THIS transaction actually belongs to, never a
    // hardcoded 1930: cash_account_id -> cash_accounts.ledger_account is the
    // only source of truth for which bank account a matched transaction
    // settled from (mirrors the dashboard route's #985 fix). Threaded through
    // every booking branch below (pure-SEK accrual, FX, and cash-method);
    // customLines specify their own accounts directly (#1000).
    const paymentAccount = await resolveSettlementAccount(
      ctx.supabase,
      ctx.companyId!,
      transaction.cash_account_id,
      txLog,
    )

    // Guard the resolved account against the chart (mirrors the categorize
    // routes): an inactive cash_accounts.ledger_account would otherwise reach
    // the engine as a generic MATCH_SI_RECORD_PAYMENT_FAILED instead of
    // ACCOUNTS_NOT_IN_CHART. Gated on !customLines: custom lines specify their
    // own accounts directly; every other branch consumes paymentAccount.
    // This MUST run before the conflicting-JE storno below: a request rejected
    // here must leave no trace, and reversing the existing categorization JE
    // is an irreversible side effect (posted vouchers are immutable).
    if (!customLines) {
      const missingAccounts = await findUnresolvableAccounts(
        ctx.supabase,
        ctx.companyId!,
        [paymentAccount],
      )
      if (missingAccounts.length > 0) {
        txLog.warn('resolved settlement account is inactive/unknown', { missingAccounts })
        return v1ErrorResponse(new AccountsNotInChartError(missingAccounts), txLog, {
          requestId: ctx.requestId,
        })
      }
    }

    // Amount resolution runs BEFORE the storno below for the same reason the
    // chart guard does: it is pure arithmetic that can reject the request, and
    // a rejected request must leave no trace (reversing the transaction's
    // existing categorization verifikat is irreversible).
    const txAmountAbs = Math.abs(transaction.amount)
    const paymentAmountInvoiceCurrency =
      transaction.currency === invoice.currency ? txAmountAbs : invoice.remaining_amount
    // SEK that actually left the bank, when known. A foreign transaction with
    // no stored amount_sek is `null` here: the raw foreign amount must never
    // stand in (treating 19 USD as 19 SEK books "19 kr" on a ~175 kr payment).
    const bankSekStored =
      transaction.currency === 'SEK'
        ? txAmountAbs
        : transaction.amount_sek != null
          ? Math.abs(transaction.amount_sek)
          : null
    const invoiceFxRate = invoice.exchange_rate ?? null
    // SEK the invoice was booked at for this payment portion (null if the
    // invoice is foreign and carries no exchange_rate).
    const bookedSek =
      invoice.currency === 'SEK'
        ? paymentAmountInvoiceCurrency
        : invoiceFxRate && invoiceFxRate > 0
          ? Math.round(paymentAmountInvoiceCurrency * invoiceFxRate * 100) / 100
          : null
    // Prefer the stored bank SEK; fall back to the invoice's booked SEK (right
    // magnitude, FX diff 0). With NEITHER on file the SEK value is unknown and
    // the old last resort (the raw foreign amount) violated the rule stated
    // above, so refuse: same policy as the match_batch_allocate RPC
    // (BATCH_FX_RATE_MISSING) and toSekOrThrow() in the entry generators.
    // Byte-identical to the dashboard route so both surfaces agree.
    const actualBankSek = bankSekStored ?? bookedSek
    if (actualBankSek == null) {
      return v1ErrorResponseFromCode('SI_FX_RATE_MISSING', txLog, {
        requestId: ctx.requestId,
        details: {
          transaction_currency: transaction.currency,
          invoice_currency: invoice.currency,
        },
      })
    }
    const originalBookedSek = bookedSek ?? actualBankSek
    const exchangeRateDifference =
      Math.round((originalBookedSek - actualBankSek) * 100) / 100
    const paymentAmountSek =
      exchangeRateDifference !== 0 ? originalBookedSek : actualBankSek

    // Storno any conflicting auto-categorization JE before booking the
    // payment. Mirrors the match-invoice path. Without this, an earlier
    // :categorize of the same transaction (e.g. as expense_office with a
    // 5460/1930 entry) would leave its JE posted alongside the new
    // 2440/1930 supplier-invoice payment entry: two verifikationer for
    // one affärshändelse violates BFL 5 kap 6 §. If storno fails, abort
    // before any further state change.
    if (transaction.journal_entry_id) {
      try {
        await reverseEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          transaction.journal_entry_id,
        )
        const { error: clearErr } = await ctx.supabase
          .from('transactions')
          .update({ journal_entry_id: null })
          .eq('id', txId)
          .eq('company_id', ctx.companyId!)
        if (clearErr) {
          txLog.warn('failed to clear journal_entry_id after storno', clearErr)
        }
      } catch (err) {
        txLog.error('match-supplier-invoice: storno of conflicting JE failed', err as Error, {
          conflictingJournalEntryId: transaction.journal_entry_id,
        })
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
    }

    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', ctx.companyId!)
      .single()
    const accountingMethod = settings?.accounting_method || 'accrual'

    // Route on the supplier invoice's actual booking state. An invoice
    // booked at receipt (registration_journal_entry_id set) must clear
    // 2440 regardless of the company's current setting.
    const siAlreadyBooked = !!(invoice as { registration_journal_entry_id?: string | null }).registration_journal_entry_id
    const useCashEntry = !siAlreadyBooked && accountingMethod === 'cash'

    // Full settlement = the bank amount pays off the whole remaining balance.
    // Cross-currency always settles the remaining (paymentAmountInvoiceCurrency
    // is clamped to invoice.remaining_amount above).
    const fullSettlement =
      transaction.currency !== invoice.currency ||
      txAmountAbs >= invoice.remaining_amount - 0.005

    // Under kontantmetoden the expense is recognised AT PAYMENT (payment-date
    // rate), so a full foreign-currency settlement has no kursdifferens: the
    // builder translates the whole entry to the actual bank SEK (settledBankSek)
    // below, leaving 1930 equal to the bank line. Only a PARTIAL cash-method
    // payment across rates can't be modelled cleanly (the builder books the
    // full invoice), so that narrow case stays blocked.
    if (useCashEntry && exchangeRateDifference !== 0 && !fullSettlement) {
      return v1ErrorResponseFromCode('MATCH_SI_CASH_FX_UNSUPPORTED', txLog, {
        requestId: ctx.requestId,
        details: {
          exchangeRateDifference,
          invoiceCurrency: invoice.currency,
          transactionCurrency: transaction.currency,
        },
      })
    }

    // Strict-mode for the public API: abort before mutating state if the
    // payment JE can't be created. See the parallel comment in match-invoice.
    let journalEntryId: string | null = null
    try {
      if (customLines) {
        const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
        const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
        if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
          return v1ErrorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', txLog, {
            requestId: ctx.requestId,
            details: { totalDebit, totalCredit },
          })
        }
        const fiscalPeriodId = await findFiscalPeriod(ctx.supabase, ctx.companyId!, transaction.date)
        if (!fiscalPeriodId) {
          return v1ErrorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', txLog, {
            requestId: ctx.requestId,
            details: { payment_date: transaction.date },
          })
        }
        const sourceType = useCashEntry ? 'supplier_invoice_cash_payment' : 'supplier_invoice_paid'
        const desc = invoice.supplier?.name
          ? `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}, ${invoice.supplier.name}`
          : `Utbetalning leverantörsfaktura ${invoice.supplier_invoice_number}`
        const je = await createJournalEntry(ctx.supabase, ctx.companyId!, ctx.userId, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: desc,
          source_type: sourceType,
          source_id: invoice.id,
          lines: customLines,
        })
        if (je) journalEntryId = je.id
      } else if (useCashEntry) {
        const je = await createSupplierInvoiceCashEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          invoice as SupplierInvoice,
          (invoice.items || []) as SupplierInvoiceItem[],
          transaction.date,
          invoice.supplier?.supplier_type || 'swedish_business',
          undefined, // supplierName (unchanged default)
          // Settle from the transaction's own resolved cash account; the
          // internal 1930 default only stands for unlinked transactions, via
          // resolveSettlementAccount's own fallback (#1000).
          paymentAccount,
          // Pin a foreign-currency settlement to the payment-date rate so the
          // settlement account equals the bank movement. No-op for SEK /
          // same-rate settlements.
          exchangeRateDifference !== 0 && fullSettlement ? actualBankSek : undefined,
        )
        if (je) journalEntryId = je.id
      } else {
        const je = await createSupplierInvoicePaymentEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          invoice as SupplierInvoice,
          paymentAmountSek,
          transaction.date,
          exchangeRateDifference !== 0 ? exchangeRateDifference : undefined,
          undefined, // supplierName (unchanged default)
          // Resolved settlement account for pure-SEK and FX matches alike:
          // the internal 1930 default only stands for unlinked transactions,
          // via resolveSettlementAccount's own fallback (#1000).
          paymentAccount,
        )
        if (je) journalEntryId = je.id
      }
    } catch (err) {
      txLog.error('match-supplier-invoice: payment JE creation failed: aborting before state mutation', err as Error)
      // AccountsNotInChartError means the account was deactivated between our
      // pre-validation above and the engine call (race): return the same
      // structured error rather than falling through to the generic
      // MATCH_SI_RECORD_PAYMENT_FAILED, mirroring the categorize routes.
      if (err instanceof AccountsNotInChartError) {
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
      // The cash-method builder converts every leg through toSekOrThrow, so a
      // foreign invoice with no usable rate surfaces here as
      // SupplierInvoiceFxRateMissingError. Dispatch on its `code` (not
      // instanceof: the class is routinely vi.mock'ed away) so the envelope
      // carries the registered 400 rather than a generic 500. Mirrors the
      // dashboard route and the preview for the same row.
      if ((err as { code?: unknown })?.code === 'SI_FX_RATE_MISSING') {
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
      return v1ErrorResponseFromCode('MATCH_SI_RECORD_PAYMENT_FAILED', txLog, {
        requestId: ctx.requestId,
        details: { reason: getErrorMessage(err, { context: 'supplier_invoice' }) },
      })
    }

    const newRemaining = Math.max(
      0,
      Math.round((invoice.remaining_amount - paymentAmountInvoiceCurrency) * 100) / 100,
    )
    const newPaidAmount =
      Math.round((invoice.paid_amount + paymentAmountInvoiceCurrency) * 100) / 100
    const isFullyPaid = newRemaining <= 0
    const newStatus = isFullyPaid ? 'paid' : 'partially_paid'
    const paidAt = isFullyPaid ? paidAtFromDate(transaction.date) : null

    const { data: updatedRows, error: updateInvErr } = await ctx.supabase
      .from('supplier_invoices')
      .update({
        status: newStatus,
        remaining_amount: newRemaining,
        paid_amount: newPaidAmount,
        paid_at: paidAt,
        payment_journal_entry_id: journalEntryId,
        transaction_id: txId,
      })
      .eq('id', supplier_invoice_id)
      .eq('company_id', ctx.companyId!)
      // 'overdue' must appear here: the early status guard accepts it as
      // matchable, so excluding it here would return MATCH_SI_NOT_OPEN
      // for a legitimately payable invoice.
      .in('status', ['registered', 'approved', 'partially_paid', 'overdue'])
      .select('id')
    if (updateInvErr) return v1ErrorResponse(updateInvErr, txLog, { requestId: ctx.requestId })
    if (!updatedRows || updatedRows.length === 0) {
      // CAS guard: the invoice was settled by a concurrent request between
      // our read and write. The payment voucher we just posted belongs to no
      // payment: cancel it and document the gap (mirrors mark-paid).
      if (journalEntryId) {
        await cancelOrphanedPaymentEntry(
          ctx.supabase, ctx.companyId!, ctx.userId, journalEntryId,
          'Automatiskt makulerad: dubblettbokning förhindrad av samtidighetsskydd',
        )
      }
      return v1ErrorResponseFromCode('MATCH_SI_NOT_OPEN', txLog, {
        requestId: ctx.requestId,
      })
    }

    const { error: paymentInsertErr } = await ctx.supabase
      .from('supplier_invoice_payments')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        supplier_invoice_id,
        payment_date: transaction.date,
        amount: paymentAmountInvoiceCurrency,
        currency: invoice.currency,
        journal_entry_id: journalEntryId,
        transaction_id: txId,
      })
    if (paymentInsertErr) {
      if (paymentInsertErr.code === '23505') {
        return v1ErrorResponseFromCode('MATCH_SI_DUPLICATE_PAYMENT', txLog, {
          requestId: ctx.requestId,
        })
      }
      txLog.error('failed to record payment', paymentInsertErr)
      return v1ErrorResponseFromCode('MATCH_SI_RECORD_PAYMENT_FAILED', txLog, {
        requestId: ctx.requestId,
      })
    }

    // The invoice is now settled, so every OTHER transaction still carrying a
    // suggestion pointer at it is dead: retire them (issue #1259). This
    // request's own row is cleared by the update just below.
    if (isFullyPaid) {
      await clearSettledInvoiceSuggestions(
        ctx.supabase,
        ctx.companyId!,
        'supplier_invoice',
        supplier_invoice_id,
        { exceptTransactionId: txId },
      )
    }

    const { error: updateTxErr } = await ctx.supabase
      .from('transactions')
      .update({
        supplier_invoice_id,
        // Parity with the dashboard route: the confirmed link supersedes the
        // suggestion, so the hint must not survive it (issue #1259).
        potential_supplier_invoice_id: null,
        journal_entry_id: journalEntryId,
        is_business: true,
      })
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
    if (updateTxErr) {
      return v1ErrorResponseFromCode('MATCH_SI_LINK_TX_FAILED', txLog, {
        requestId: ctx.requestId,
      })
    }

    // Propagate a document pinned to the transaction onto the payment
    // verifikat, mirroring the dashboard route (BFL 5 kap 6 §). Guarded to
    // unlinked current-version docs only: a doc already serving another
    // verifikat (e.g. the supplier invoice's own document on the registration
    // entry) must not move. Non-fatal: the match is already committed.
    if (transaction.document_id) {
      const { error: docLinkErr } = await ctx.supabase
        .from('document_attachments')
        .update({ journal_entry_id: journalEntryId })
        .eq('id', transaction.document_id)
        .eq('company_id', ctx.companyId!)
        .is('journal_entry_id', null)
        .eq('is_current_version', true)
      if (docLinkErr) {
        // Structured fields so the half-linked state (doc retained but not
        // anchored to the payment JE) can be reconstructed without an audit
        // trail dig.
        txLog.warn('failed to link transaction document to payment JE (non-critical)', {
          error: docLinkErr,
          documentId: transaction.document_id,
          journalEntryId,
        })
      }
    }

    // Same requirement for the SUPPLIER INVOICE's own retained document: it
    // must sit on a posted verifikat or the missing-underlag surfaces (which
    // only accept an anchored doc) warn on a verifikat that plainly shows the
    // invoice. No-op when it is already anchored. Never throws.
    await anchorSupplierInvoiceDocument(ctx.supabase, ctx.companyId!, supplier_invoice_id)

    logMatchEvent(ctx.supabase, ctx.userId, txId, 'matched', {
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
            transaction_id: txId,
          } as SupplierInvoice,
          transaction: {
            ...transaction,
            supplier_invoice_id,
            potential_supplier_invoice_id: null,
            journal_entry_id: journalEntryId,
            is_business: true,
          } as Transaction,
          userId: ctx.userId,
          companyId: ctx.companyId!,
        },
      })
    } catch (err) {
      txLog.warn('event emit failed (non-critical)', err as Error)
    }

    return ok(
      {
        success: true,
        invoice_status: newStatus,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
        journal_entry_id: journalEntryId,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
