/**
 * POST /api/v1/companies/{companyId}/transactions/{id}/match-invoice
 *
 * Match a positive (income) transaction to an open customer invoice. The
 * full flow:
 *   1. Storno any conflicting auto-categorization JE.
 *   2. Create the payment journal entry (resolved bank account debit / 1510
 *      credit under accrual, built by the shared
 *      buildInvoicePaymentClearingLines helper; cash-method path delegates to
 *      createInvoiceCashEntry). The debited account is resolved from this
 *      transaction's own cash_account_id via resolveSettlementAccount, never
 *      hardcoded to 1930 (mirrors the fix on the supplier-invoice side).
 *      Cross-currency settlement uses the same Riksbanken spot-rate path as
 *      the dashboard route so both doors post the same verifikat.
 *   3. Re-attach the invoice PDF to the new payment JE (BFL 7 kap underlag).
 *   4. Update invoice status (paid / partially_paid) with optimistic lock.
 *   5. Insert invoice_payments row; link transaction to invoice.
 *
 * A company that books invoices in a separate step (defer_invoice_booking)
 * gets an unbooked invoice's sale booked first, by the :book step on its
 * invoice date, before step 1 (lib/invoices/sale-first.ts); a refusal there
 * refuses the match with nothing written.
 *
 * Mirrors the internal route's failure ordering exactly. Idempotent on
 * (transaction, key). NOT dry-runnable: the multi-row interlock makes a
 * meaningful preview infeasible without staging the JE for real, and dry-
 * run is reserved for endpoints where the caller benefits from a fully
 * resolved preview before commit. Skip the flag here; document it.
 */
import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import { releaseDoubtfulReserveAfterChange } from '@/lib/customer-loss/doubtful'
import { z } from 'zod'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { MatchInvoiceSchema } from '@/lib/api/schemas'
import { createInvoiceCashEntry } from '@/lib/bookkeeping/invoice-entries'
import {
  buildInvoiceMatchClearingLines,
  invoiceMatchPaymentDescription,
} from '@/lib/bookkeeping/invoice-payment-lines'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import {
  invoicePaymentBusinessEvent,
  matchedBankLineStornoBusinessEvent,
  type InvoicePaymentPostingContext,
} from '@/lib/bookkeeping/invoice-business-events'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { postingPort } from '@/lib/posting/port'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { recordInvoicePaymentRow } from '@/lib/invoices/invoice-payment-row'
import { detectDuplicatePaymentVoucher } from '@/lib/invoices/duplicate-payment-detection'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { emitInvoicePaidIfSettled } from '@/lib/invoices/paid-events'
import { roundOre } from '@/lib/money'
import { eventBus } from '@/lib/events/bus'
import type { CreateJournalEntryInput, Currency, EntityType, Invoice, Transaction } from '@/types'
import { MATCHABLE_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'
import { linkBasisColumns } from '@/lib/links/stamp'
import {
  bookSaleBeforeSettlement,
  clearsReceivable,
  planSaleBeforeSettlement,
  SALE_FIRST_NOT_REQUIRED,
} from '@/lib/invoices/sale-first'
import { v1OutcomeResponse } from '@/lib/operations/v1'

const MatchInvoiceResponse = z.object({
  success: z.boolean(),
  invoice_status: z.string(),
  paid_at: z.string().nullable(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
  sale_journal_entry_id: z
    .string()
    .uuid()
    .optional()
    .describe('The sale verifikat this match booked first (defer_invoice_booking); absent when none was booked.'),
  // Preserved from the prior :categorize call (or whatever the existing
  // value was). Returns null when the transaction had never been
  // categorized: the v1 surface no longer guesses 'income_services'
  // for unmatched-revenue rows because the wrong default flows into
  // BAS 3001/3041/3530 selection and INK2R/SRU reporting.
  category: z.string().nullable(),
})

registerEndpoint({
  operation: 'transactions.match-invoice',
  method: 'POST',
  path: '/api/v1/companies/:companyId/transactions/:id/match-invoice',
  summary: 'Match a positive bank transaction to a customer invoice.',
  description:
    'Confirms an invoice match for a transaction. Storno any conflicting auto-categorization JE, create the payment journal entry, update the invoice status (paid / partially_paid), insert into invoice_payments, and link the transaction. Idempotent.',
  useWhen:
    'You have a bank receipt and a known open invoice it pays. The transaction must be positive (income) and unlinked.',
  doNotUseFor:
    'Categorizing a transaction without an invoice: use `:categorize`. Matching to a supplier invoice: use `:match-supplier-invoice`. Bulk auto-match: use `POST /reconciliation/bank/run`.',
  pitfalls: [
    'Proforma + delivery notes are rejected (MATCH_INVOICE_NOT_INVOICE_TYPE): only document_type=\'invoice\' can be matched.',
    'Transaction must be positive (amount > 0): negative transactions return MATCH_INVOICE_NOT_INCOME.',
    'Invoice must be in sent / overdue / partially_paid status: paid or draft invoices return MATCH_INVOICE_NOT_OPEN.',
    'Kontantmetoden: an invoice never booked at issue is matched only by one payment of its whole amount. A partial payment, or the final payment of an invoice already part-paid, returns INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED (details.reason partial_payment | previously_partially_paid); book that payment as a manual journal entry.',
    'Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): an invoice sent without its verifikat is booked first by the invoices :book step (dated on the invoice date), then the payment clears that 1510; sale_journal_entry_id names it. When the book step refuses (PERIOD_LOCKED on the invoice date, INVOICE_BOOK_NO_FISCAL_PERIOD, INVOICE_BOOK_INVALID_STATUS for a partially paid invoice) or the transaction date is locked (PERIOD_LOCKED with details.payment_date), the match is refused with that code, details.sale_first is true, and nothing is booked.',
    'Idempotency-Key is mandatory.',
  ],
  example: {
    request: { invoice_id: 'inv_…' },
    response: {
      data: {
        success: true,
        invoice_status: 'paid',
        paid_amount: 12500,
        remaining_amount: 0,
        journal_entry_id: 'je_…',
        category: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'transactions:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { body: MatchInvoiceSchema },
  response: { success: dataEnvelope(MatchInvoiceResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'transactions.match-invoice',
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

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body
    const parsed = MatchInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const { invoice_id, force, expected_journal_entry_id, lines: customLines } = parsed.data
    const txLog = ctx.log.child({ transactionId: txId, invoiceId: invoice_id })

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
    // Preserve any prior category (e.g. income_products for goods sales).
    // Only fall back to the generic 'income_services' default if the
    // transaction has never been categorized: Greptile + Swedish-compliance
    // flagged the dashboard's hardcode-on-write as a wrong BAS classification
    // for goods/rental income flows.
    const existingTxCategory = (transaction as { category?: string | null }).category ?? null
    if (transaction.amount <= 0) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_INCOME', txLog, {
        requestId: ctx.requestId,
        details: { amount: transaction.amount },
      })
    }
    if (transaction.invoice_id) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_TX_ALREADY_LINKED', txLog, {
        requestId: ctx.requestId,
        details: { existingInvoiceId: transaction.invoice_id },
      })
    }

    const { data: invoice, error: fetchInvErr } = await ctx.supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', invoice_id)
      .eq('company_id', ctx.companyId!)
      .single()
    if (fetchInvErr || !invoice) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_FOUND', txLog, {
        requestId: ctx.requestId,
      })
    }
    const docType = (invoice as { document_type?: string }).document_type ?? 'invoice'
    if (docType !== 'invoice') {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_INVOICE_TYPE', txLog, {
        requestId: ctx.requestId,
        details: { documentType: docType },
      })
    }
    if (invoice.credited_invoice_id) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_CREDIT_NOTE', txLog, {
        requestId: ctx.requestId,
      })
    }
    if (
      invoice.status !== 'sent' &&
      invoice.status !== 'overdue' &&
      invoice.status !== 'partially_paid'
    ) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_NOT_OPEN', txLog, {
        requestId: ctx.requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Cross-currency settlement. Byte-for-byte the dashboard route's block
    // (app/api/transactions/[id]/match-invoice/route.ts): same guard, same
    // helpers, same order, so the same action through either door produces the
    // same ledger. Before this, v1 had no FX path at all: it fed the raw
    // transactions.amount straight into createInvoicePaymentJournalEntry, which
    // re-read it as if it were already in the INVOICE's currency and multiplied
    // by the invoice's booking rate, and then stored that SEK magnitude on
    // invoice_payments under the invoice's foreign currency code.
    //
    // A bank row is stored in ITS OWN currency: transactions.amount is
    // denominated in transactions.currency, and the SEK value lives either in
    // amount_sek (pre-computed at ingest) or is derivable from exchange_rate.
    // Every journal entry line is SEK, so a foreign row whose SEK value cannot
    // be established must not be booked or allocated at all: substituting the
    // raw foreign number would settle a 500 USD receipt as 500 SEK, a tenth of
    // the real payment. Rows in exactly that shape exist: when the Riksbanken
    // lookup fails at ingest the transaction is written with neither field
    // (lib/transactions/ingest.ts). Refuse loudly, the same way the
    // match_batch_allocate RPC refuses with BATCH_FX_RATE_MISSING.
    const txIsForeign = !!transaction.currency && transaction.currency !== 'SEK'
    if (
      txIsForeign &&
      transaction.amount_sek == null &&
      !(transaction.exchange_rate != null && transaction.exchange_rate > 0)
    ) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_TX_FX_RATE_MISSING', txLog, {
        requestId: ctx.requestId,
        details: {
          transaction_currency: transaction.currency,
          transaction_date: transaction.date,
        },
      })
    }
    // Actual SEK that hit the bank, resolved through the same helper
    // buildInvoicePaymentClearingLines uses for the bank leg (amount_sek first,
    // then amount * exchange_rate). SEK rows return Math.abs(amount) unchanged.
    const txAbsSek =
      Math.round(
        resolveSekAmount(
          Math.abs(transaction.amount),
          transaction.amount_sek != null ? Math.abs(transaction.amount_sek) : null,
          transaction.currency,
          transaction.exchange_rate,
        ) * 100,
      ) / 100

    type FxConversion =
      | { required: false }
      | {
          required: true
          rate: number
          rate_date: string
          paidInInvoiceCurrency: number
          // Provenance of the rate actually used (BFL 5 kap 6-7§; ML 8 kap
          // 21-23§): 'manual' = caller-supplied, 'riksbanken' = spot rate on
          // the payment date.
          source: 'manual' | 'riksbanken'
        }

    let fx: FxConversion = { required: false }
    if (transaction.currency !== invoice.currency) {
      const manualRate =
        typeof parsed.data.manual_exchange_rate === 'number' &&
        parsed.data.manual_exchange_rate > 0
          ? parsed.data.manual_exchange_rate
          : null
      let rate = manualRate
      let rateDate = transaction.date
      if (rate == null) {
        const rateInfo = await fetchExchangeRate(
          invoice.currency as Currency,
          new Date(transaction.date),
        )
        if (rateInfo && rateInfo.rate > 0) {
          rate = rateInfo.rate
          rateDate = rateInfo.date
        }
      }
      if (rate == null || rate <= 0) {
        return v1ErrorResponseFromCode('MATCH_INVOICE_FX_RATE_UNAVAILABLE', txLog, {
          requestId: ctx.requestId,
          details: {
            transaction_currency: transaction.currency,
            invoice_currency: invoice.currency,
            payment_date: transaction.date,
          },
        })
      }
      fx = {
        required: true,
        rate,
        rate_date: rateDate,
        paidInInvoiceCurrency: Math.round((txAbsSek / rate) * 10000) / 10000,
        source: manualRate != null ? 'manual' : 'riksbanken',
      }
    }

    // Hard-duplicate guard: status leak: the invoice still says
    // 'sent'/'overdue' but already has a payment voucher attached. Mirror
    // of the internal route's defensive check.
    if (invoice.status === 'sent' || invoice.status === 'overdue') {
      const { data: existingPayments } = await ctx.supabase
        .from('invoice_payments')
        .select('journal_entry_id')
        .eq('company_id', ctx.companyId!)
        .eq('invoice_id', invoice_id)
        .not('journal_entry_id', 'is', null)
        .limit(1)
      if (existingPayments && existingPayments.length > 0) {
        return v1ErrorResponseFromCode('MATCH_INVOICE_ALREADY_HAS_PAYMENT_VOUCHER', txLog, {
          requestId: ctx.requestId,
          details: {
            existing_journal_entry_id:
              (existingPayments[0] as { journal_entry_id: string }).journal_entry_id,
          },
        })
      }
    }

    // Soft-duplicate guard: a manual verifikation already books this
    // bank receipt. Bypassed only when the caller echoes the candidate's
    // journal_entry_id back in expected_journal_entry_id (validated by
    // the schema). The Idempotency-Key body hash already prevents replay
    // with a different body, and re-detecting the candidate here means an
    // automation can't fabricate or stale-roll an id past the guard.
    let dismissedCandidateId: string | null = null
    try {
      const candidate = await detectDuplicatePaymentVoucher(ctx.supabase, {
        companyId: ctx.companyId!,
        transactionId: txId,
        transactionDate: transaction.date,
        transactionAmount: transaction.amount,
        // `amount` is in `currency`; the ledger legs the detector compares it
        // against are always SEK, on the account cash_account_id says the
        // money landed on. Selected above via select('*').
        transactionCurrency: transaction.currency ?? null,
        transactionAmountSek: transaction.amount_sek ?? null,
        transactionExchangeRate: transaction.exchange_rate ?? null,
        cashAccountId: transaction.cash_account_id ?? null,
      })
      if (!force) {
        if (candidate) {
          return v1ErrorResponseFromCode('MATCH_INVOICE_POSSIBLE_DUPLICATE', txLog, {
            requestId: ctx.requestId,
            details: { candidate },
          })
        }
      } else {
        if (!candidate || candidate.journal_entry_id !== expected_journal_entry_id) {
          return v1ErrorResponseFromCode('MATCH_INVOICE_FORCE_CANDIDATE_MISMATCH', txLog, {
            requestId: ctx.requestId,
            details: {
              expected_journal_entry_id,
              detected_journal_entry_id: candidate?.journal_entry_id ?? null,
            },
          })
        }
        dismissedCandidateId = candidate.journal_entry_id
      }
    } catch (err) {
      if (force) {
        txLog.error('duplicate-payment-voucher detection failed under force=true', err as Error)
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
      txLog.warn('duplicate-payment-voucher detection failed (continuing)', err as Error)
    }

    if (force && dismissedCandidateId) {
      txLog.warn('soft-duplicate guard bypassed', {
        reason: 'force=true',
        requestId: ctx.requestId,
        transactionId: txId,
        invoiceId: invoice_id,
        // Attribute the override to the calling user AND the API key. The
        // user identifier alone is not enough for v1: a single user can
        // hold multiple keys (CI bot, integration, personal), and revocation
        // / abuse triage needs to know which key was used.
        userId: ctx.userId,
        apiKeyId: ctx.apiKeyId,
        // The verifikation the caller acknowledged and dismissed.
        dismissedJournalEntryId: dismissedCandidateId,
      })
    }

    // paidAmount is denominated in INVOICE currency: that is the unit of
    // invoices.paid_amount / remaining_amount and of invoice_payments.amount.
    // Same-currency → the raw tx amount; cross-currency → the spot-rate
    // conversion computed above. Feeding a SEK figure in here for a foreign
    // invoice corrupts the column units (and the stored payment row's
    // currency label).
    const paidAmount = fx.required ? fx.paidInInvoiceCurrency : transaction.amount

    // Overshoot guard + paid/remaining math: shared with the dashboard and
    // agent (commit) paths via planInvoicePayment. Without this, the public API
    // silently overpaid an invoice (recording paid_amount > total, over-crediting
    // AR). Runs BEFORE the storno + strict-mode JE creation, so a rejected match
    // touches no state. Pure-SEK settlements absorb sub-krona öresavrundning
    // (booked to 3740 by buildInvoicePaymentClearingLines) so a whole-krona
    // payment settles in full, exactly as on the dashboard route.
    const pureSek = transaction.currency === 'SEK' && invoice.currency === 'SEK'
    const payment = planInvoicePayment(invoice, paidAmount, {
      absorbOreRounding: pureSek,
    })
    if (!payment.ok) {
      return v1ErrorResponseFromCode('MATCH_AMOUNT_EXCEEDS_REMAINING', txLog, {
        requestId: ctx.requestId,
        details: payment.details,
      })
    }
    const { newPaidAmount, newRemaining, isFullyPaid, newStatus } = payment.plan
    const paidAt = isFullyPaid ? paidAtFromDate(transaction.date) : null

    // A payment date outside an open period leaves the entry builders with
    // nothing to book (the cash entry returns null), and the invoice used to
    // be marked paid with no verifikat. Refuse before any write, the storno
    // below included, exactly as the dashboard routes do.
    const fiscalPeriodId = await findFiscalPeriod(ctx.supabase, ctx.companyId!, transaction.date)
    if (!fiscalPeriodId) {
      return v1ErrorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', txLog, {
        requestId: ctx.requestId,
        details: { payment_date: transaction.date },
      })
    }

    // Every refusal that can be decided from the request and the current state
    // runs from here down to the storno, the dashboard route's order, so a
    // refused match never reverses the transaction's prior verifikat.
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', ctx.companyId!)
      .single()
    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType: EntityType = await resolveCompanyEntityType(ctx.supabase, ctx.companyId!, settings?.entity_type)

    // Debit the cash account THIS transaction actually belongs to, never a
    // hardcoded 1930: cash_account_id -> cash_accounts.ledger_account is the
    // only source of truth for which bank/cash account a real, matched
    // transaction settled into.
    const paymentAccount = await resolveSettlementAccount(
      ctx.supabase,
      ctx.companyId!,
      transaction.cash_account_id,
      txLog,
    )

    // The JE shape is driven by the INVOICE'S booking state, not the
    // company's current setting. If the invoice already has a JE (Dr 1510
    // posted at send), the match must clear 1510: otherwise the receivable
    // stays orphaned and 30xx + 26xx get double-counted. The current
    // accounting_method only governs the cash-method fast path for
    // invoices that were never booked.
    const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null }).journal_entry_id
    const useCashEntry = !invoiceAlreadyBooked && accountingMethod === 'cash' && isFullyPaid

    // Reject cash-method partial payments and part-paid completions for pure
    // kontantmetoden invoices (no prior JE) through the predicate the dashboard
    // and agent doors use. Under kontantmetoden utgående moms is reported per
    // payment received (bokslutsmetoden), and createInvoiceCashEntry always
    // books the FULL invoice: a completion after an installment already
    // recognised elsewhere would book that installment's revenue and moms a
    // second time. When the invoice was already booked under accrual, the
    // clearing entry IS the correct partial path whatever the current setting.
    const cashBlock = cashPartialBlockReason({
      invoiceAlreadyBooked,
      accountingMethod,
      priorPaidAmount: (invoice as { paid_amount?: number | null }).paid_amount,
      paysRemainingInFull: isFullyPaid,
    })
    if (cashBlock) {
      return v1ErrorResponseFromCode('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED', txLog, {
        requestId: ctx.requestId,
        details: {
          reason: cashBlock,
          payment_amount: paidAmount,
          invoice_total: invoice.total,
        },
      })
    }

    // Custom rows must balance.
    if (customLines) {
      const totalDebit = customLines.reduce((s, l) => s + l.debit_amount, 0)
      const totalCredit = customLines.reduce((s, l) => s + l.credit_amount, 0)
      if (Math.round((totalDebit - totalCredit) * 100) !== 0 || totalDebit <= 0) {
        return v1ErrorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', txLog, {
          requestId: ctx.requestId,
          details: { totalDebit, totalCredit },
        })
      }
    }

    // Guard the resolved account against the chart (mirrors the categorize
    // routes and the same fix on match-supplier-invoice): an inactive
    // cash_accounts.ledger_account would otherwise reach the engine as a
    // generic INVOICE_PAID_BOOK_FAILED instead of ACCOUNTS_NOT_IN_CHART.
    // Only reachable where the account is actually used: customLines specify
    // their own accounts directly and never consume paymentAccount.
    if (!customLines) {
      const missingAccounts = await findUnresolvableAccounts(ctx.supabase, ctx.companyId!, [
        paymentAccount,
      ])
      if (missingAccounts.length > 0) {
        txLog.warn('resolved settlement account is inactive/unknown', { missingAccounts })
        return v1ErrorResponse(new AccountsNotInChartError(missingAccounts), txLog, {
          requestId: ctx.requestId,
        })
      }
    }

    // Faktureringsmetoden with defer_invoice_booking: an invoice sent without
    // its verifikat gets its sale booked first, by the :book step on its
    // invoice date, and the payment then clears the 1510 it debits
    // (lib/invoices/sale-first.ts). The plan is the :book step's dry run and
    // the payment date's lock, so a refusal comes before anything is written.
    // Custom lines that book the revenue themselves carry the sale already.
    const saleCtx = { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: txLog }
    const salePlan =
      customLines && !clearsReceivable(customLines)
        ? SALE_FIRST_NOT_REQUIRED
        : await planSaleBeforeSettlement(saleCtx, invoice, { settlementDate: transaction.date })
    if (!salePlan.ok) return v1OutcomeResponse(salePlan, ctx)

    // A RECONCILIATION link (reconciliation_method set) is not a conflicting
    // booking: the entry is an independent verifikat that may evidence OTHER
    // affärshändelser; reversing it wholesale would be an over-broad rättelse
    // (BFL 5 kap 5 §). Nothing is detached here: the final transaction update
    // overwrites the pointer and clears reconciliation_method in the same
    // write, so a failure in between leaves the existing link intact.
    const priorReconciliationLink =
      transaction.journal_entry_id && transaction.reconciliation_method
        ? {
            journalEntryId: transaction.journal_entry_id as string,
            method: transaction.reconciliation_method as string,
          }
        : null

    // The sale first: a correct booking of the sent invoice whatever happens
    // to the match after it.
    const sale = await bookSaleBeforeSettlement(saleCtx, salePlan)
    if (!sale.ok) return v1OutcomeResponse(sale, ctx)
    const saleJournalEntryId = sale.bookedHere ? sale.journalEntryId : null

    if (transaction.journal_entry_id && !priorReconciliationLink) {
      try {
        // Through the posting port: while POSTING_EVENTS is on, the storno
        // records ledger.storno of the bank line (system_derived: the match
        // replaces the booking, no one chose the storno itself).
        await postingPort.reverseJournalEntry({
          supabase: ctx.supabase,
          companyId: ctx.companyId!,
          userId: ctx.userId,
          entryId: transaction.journal_entry_id,
          event: () => matchedBankLineStornoBusinessEvent(txId, todayIsoStockholm(), linkBasisColumns('system_derived')),
          role: 'reversal',
        })
        const { error: clearErr } = await ctx.supabase
          .from('transactions')
          .update({ journal_entry_id: null })
          .eq('id', txId)
          .eq('company_id', ctx.companyId!)
        if (clearErr) {
          txLog.warn('failed to clear journal_entry_id after storno', clearErr)
        }
        await logMatchEvent(ctx.supabase, ctx.userId, txId, 'storno_conflict_resolved', {
          invoiceId: invoice_id,
          previousState: { journal_entry_id: transaction.journal_entry_id },
          newState: { journal_entry_id: null },
        })
      } catch (err) {
        txLog.error('storno failed', err as Error)
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
    }

    // Strict-mode for the public API: if the payment JE can't be created we
    // ABORT before touching invoice / payment / transaction state. The
    // dashboard's internal route soft-fails here and surfaces a banner so
    // the user can re-book manually; the v1 caller is an automation with
    // no UI, so a partial state (invoice marked paid, GL has no entry) is
    // strictly worse than a clean failure to retry.
    let journalEntryId: string | null = null
    // Posting port (step 2f-2): what this door saw, read only while
    // POSTING_EVENTS is on: the caller named this bank line for this invoice
    // (the payment row's basis, client_asserted on an API key), and the debt
    // the payment settles.
    const posting = (): InvoicePaymentPostingContext => ({
      linkBasis: linkBasisColumns('user_confirmed'),
      settledAmount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
    })
    try {
      if (customLines) {
        const sourceType = useCashEntry ? 'invoice_cash_payment' : 'invoice_paid'
        const input: CreateJournalEntryInput = {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: invoiceMatchPaymentDescription(invoice),
          source_type: sourceType,
          source_id: invoice.id,
          bank_booking_context: [bankBookingContext(transaction, paymentAccount)],
          lines: customLines,
        }
        // The caller's own rows: no rule made them and no payment account is
        // named, so the event carries no rule version and no kronor.
        const je = await postingPort.postJournalEntry({
          supabase: ctx.supabase,
          companyId: ctx.companyId!,
          userId: ctx.userId,
          event: () =>
            invoicePaymentBusinessEvent(invoice as Invoice, input, { paymentAccount: null, generated: false, bankLine: true }, posting()),
          input,
        })
        journalEntryId = je?.id ?? null
      } else if (useCashEntry) {
        const je = await createInvoiceCashEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          invoice as Invoice,
          transaction.date,
          entityType,
          invoice.customer?.name,
          paymentAccount,
          transaction,
          undefined,
          posting,
        )
        journalEntryId = je?.id ?? null
      } else {
        // Clearing entry against 1510, built by the SAME shared helper the
        // dashboard route and its preview use, so all three produce byte-
        // identical lines: bank leg = the actual SEK that hit the account,
        // 1510 credited at the invoice's booking rate, and a 3960/7960 FX-diff
        // line (or a 3740 öresavrundning line on pure SEK) making the verifikat
        // balance per BFL 5 kap 4-5§.
        // The invoice's dimension bag rides every leg, FX result lines
        // included, so a project's kursvinst/kursförlust stays inside the
        // project's result (the builder stamps it).
        const { description, lines: clearingLines } = buildInvoiceMatchClearingLines(
          {
            amount: transaction.amount,
            amount_sek: transaction.amount_sek ?? null,
            currency: transaction.currency,
            exchange_rate: transaction.exchange_rate ?? null,
          },
          {
            currency: invoice.currency,
            exchange_rate: invoice.exchange_rate ?? null,
            remaining_amount: invoice.remaining_amount ?? null,
            total: invoice.total,
            paid_amount: invoice.paid_amount ?? null,
            invoice_number: invoice.invoice_number,
            customer: invoice.customer,
            default_dimensions: (invoice as { default_dimensions?: unknown }).default_dimensions,
          },
          fx.required ? fx.paidInInvoiceCurrency : undefined,
          paymentAccount,
        )
        const input: CreateJournalEntryInput = {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description,
          source_type: 'invoice_paid',
          source_id: invoice.id,
          bank_booking_context: [bankBookingContext(transaction, paymentAccount)],
          lines: clearingLines,
        }
        const je = await postingPort.postJournalEntry({
          supabase: ctx.supabase,
          companyId: ctx.companyId!,
          userId: ctx.userId,
          event: () =>
            invoicePaymentBusinessEvent(invoice as Invoice, input, { paymentAccount, generated: true, bankLine: true }, posting()),
          input,
        })
        journalEntryId = je?.id ?? null
      }
    } catch (err) {
      if (err instanceof AccountsNotInChartError) {
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
      // buildInvoicePaymentClearingLines refuses a foreign invoice with no
      // booking rate rather than valuing the 1510 credit at a fabricated one.
      // Surface the registered 400 ("komplettera fakturans växelkurs") instead
      // of the generic INVOICE_PAID_BOOK_FAILED, so the caller learns which
      // field to fill in. Dispatch on `code` (not instanceof) for the same
      // reason as the supplier route: the class's module is vi.mock'ed away in
      // route tests, and the string literal can't degrade into a catch-all.
      if ((err as { code?: unknown })?.code === 'MATCH_INVOICE_BOOKING_RATE_MISSING') {
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
      txLog.error('match-invoice: payment JE creation failed: aborting before state mutation', err as Error)
      return v1ErrorResponseFromCode('INVOICE_PAID_BOOK_FAILED', txLog, {
        requestId: ctx.requestId,
        details: {
          reason: getErrorMessage(err, { context: 'invoice' }),
          // The sale booked first stands: a retry settles against it.
          ...(saleJournalEntryId ? { sale_journal_entry_id: saleJournalEntryId } : {}),
        },
      })
    }
    // Fail closed, as the dashboard route does: a builder that booked nothing
    // must never leave the invoice marked paid without its verifikat.
    if (!journalEntryId) {
      return v1ErrorResponseFromCode('INVOICE_PAID_BOOK_FAILED', txLog, {
        requestId: ctx.requestId,
        details: {
          reason: 'no_journal_entry_created',
          ...(saleJournalEntryId ? { sale_journal_entry_id: saleJournalEntryId } : {}),
        },
      })
    }

    // Re-attach invoice PDF to the payment JE (BFL 7 kap underlag), from the
    // invoice's own verifikat: linked at issue, or booked first above.
    const invoiceJournalEntryId = invoice.journal_entry_id ?? sale.journalEntryId
    if (journalEntryId && invoiceJournalEntryId) {
      try {
        const { data: invoiceDoc } = await ctx.supabase
          .from('document_attachments')
          .select('storage_path, file_name, file_size_bytes, mime_type, sha256_hash')
          .eq('journal_entry_id', invoiceJournalEntryId)
          .eq('company_id', ctx.companyId!)
          .eq('is_current_version', true)
          .limit(1)
          .maybeSingle()
        if (invoiceDoc) {
          const { error: attachErr } = await ctx.supabase
            .from('document_attachments')
            .insert({
              user_id: ctx.userId,
              company_id: ctx.companyId!,
              uploaded_by: ctx.userId,
              upload_source: 'system',
              storage_path: invoiceDoc.storage_path,
              file_name: invoiceDoc.file_name,
              file_size_bytes: invoiceDoc.file_size_bytes,
              mime_type: invoiceDoc.mime_type,
              sha256_hash: invoiceDoc.sha256_hash,
              journal_entry_id: journalEntryId,
              // The invoice's own PDF follows it onto its payment verifikat.
              ...linkBasisColumns('system_derived', { rule_id: 'invoice_document_on_payment' }),
            })
          if (attachErr) {
            txLog.warn('failed to attach invoice PDF to payment JE', {
              attachError: attachErr.message,
            })
          }
        }
      } catch (err) {
        txLog.warn('attach invoice PDF threw', err as Error)
      }
    }

    const { data: updatedRows, error: updateInvErr } = await ctx.supabase
      .from('invoices')
      .update({
        status: newStatus,
        paid_at: paidAt,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
      })
      .eq('id', invoice_id)
      .eq('company_id', ctx.companyId!)
      .in('status', [...MATCHABLE_INVOICE_STATUSES])
      .select('id')
    if (updateInvErr) return v1ErrorResponse(updateInvErr, txLog, { requestId: ctx.requestId })
    if (!updatedRows || updatedRows.length === 0) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_ALREADY_PAID', txLog, {
        requestId: ctx.requestId,
      })
    }

    // Provenance for a caller-supplied FX rate. A Riksbanken spot rate is
    // self-documenting (rate + date are reproducible); a rate passed in the
    // request body overrides the ML 8 kap 21-23§ obligation and must leave a
    // trail on the payment row (BFL 5 kap 6-7§).
    const manualRateNote =
      fx.required && fx.source === 'manual'
        ? `Manuell valutakurs ${fx.rate} ${invoice.currency}/SEK (betalningsdatum ${transaction.date})`
        : null

    const paymentNotes = manualRateNote

    // The AR sub-ledger row goes through the single writer
    // (lib/invoices/invoice-payment-row.ts): amount = the amount APPLIED to
    // the invoice (new paid_amount minus the prior one) in INVOICE currency,
    // never a SEK magnitude wearing the invoice's foreign currency code and
    // never the cash received (a whole-krona overshoot absorbed on 3740 is
    // part of the voucher, not of the receivable, #2250). exchange_rate is
    // the rate ACTUALLY USED for this payment (Riksbanken or the caller's
    // override on the payment date, per ML 8 kap 21-23§), falling back to the
    // invoice's booking rate only when no conversion was needed.
    const recorded = await recordInvoicePaymentRow(ctx.supabase, {
      userId: ctx.userId,
      companyId: ctx.companyId!,
      invoice: {
        id: invoice_id,
        currency: invoice.currency,
        exchange_rate: invoice.exchange_rate,
        paid_amount: invoice.paid_amount,
      },
      paymentDate: transaction.date,
      newPaidAmount,
      journalEntryId,
      transactionId: txId,
      exchangeRate: fx.required ? fx.rate : invoice.exchange_rate,
      notes: paymentNotes,
      source: 'bank',
      // The caller named this bank line for this invoice.
      linkBasis: { basis: 'user_confirmed' },
    })
    if (!recorded.ok) {
      if (recorded.code === '23505') {
        return v1ErrorResponseFromCode('MATCH_INVOICE_DUPLICATE_PAYMENT', txLog, {
          requestId: ctx.requestId,
        })
      }
      txLog.error('failed to record payment', undefined, { error: recorded.error })
      return v1ErrorResponseFromCode('MATCH_INVOICE_RECORD_PAYMENT_FAILED', txLog, {
        requestId: ctx.requestId,
      })
    }

    // The invoice is now settled, so every OTHER transaction still carrying a
    // suggestion pointer at it is dead: retire them (issue #1259). This
    // request's own row is cleared by the update just below.
    if (isFullyPaid) {
      await clearSettledInvoiceSuggestions(ctx.supabase, ctx.companyId!, 'invoice', invoice_id, {
        exceptTransactionId: txId,
      })
    }

    // When the tx already has a category (set by a prior :categorize call,
    // could be income_products / rental / etc.), preserve it. When there is
    // none, leave the column UNTOUCHED: the existing default ('uncategorized')
    // persists. Writing a hardcoded 'income_services' here was the source of
    // a known mis-classification for goods/rental flows (BAS 3001/3041/3530
    // distinct accounts → wrong INK2R field → wrong SRU).
    const txUpdate: Record<string, unknown> = {
      invoice_id,
      potential_invoice_id: null,
      journal_entry_id: journalEntryId,
      is_business: true,
      // The invoice match supersedes any prior reconciliation link (deferred
      // detach, see the priorReconciliationLink block above). Unconditional:
      // null is already the value on every non-reconciliation-linked row.
      reconciliation_method: null,
      // The caller named this bank line for this invoice.
      ...linkBasisColumns('user_confirmed'),
    }
    if (existingTxCategory) txUpdate.category = existingTxCategory

    const { error: updateTxErr } = await ctx.supabase
      .from('transactions')
      .update(txUpdate)
      .eq('id', txId)
      .eq('company_id', ctx.companyId!)
    if (updateTxErr) {
      txLog.error('failed to link transaction to invoice', updateTxErr)
      return v1ErrorResponseFromCode('MATCH_INVOICE_LINK_TX_FAILED', txLog, {
        requestId: ctx.requestId,
      })
    }

    // Record the release of the prior reconciliation link now that the
    // re-point has committed (behandlingshistorik, BFNAR 2013:2 kap 8).
    if (priorReconciliationLink) {
      await logMatchEvent(ctx.supabase, ctx.userId, txId, 'unmatched', {
        invoiceId: invoice_id,
        previousState: {
          journal_entry_id: priorReconciliationLink.journalEntryId,
          reconciliation_method: priorReconciliationLink.method,
        },
        newState: { journal_entry_id: journalEntryId, reconciliation_method: null },
      })
    }

    await logMatchEvent(ctx.supabase, ctx.userId, txId, 'matched', {
      invoiceId: invoice_id,
      matchConfidence: 1.0,
      matchMethod: 'manual_confirm',
      // rate_source / exchange_rate live inside new_state so a caller-supplied
      // rate on a money path stays distinguishable from an automatic
      // Riksbanken lookup in the audit trail. Same shape as the dashboard
      // route; same-currency matches carry rate_source: null.
      newState: {
        status: newStatus,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
        rate_source: fx.required ? fx.source : null,
        exchange_rate: fx.required ? fx.rate : null,
      },
    })

    const settledInvoice = {
      ...invoice,
      status: newStatus,
      paid_at: paidAt,
      paid_amount: newPaidAmount,
      remaining_amount: newRemaining,
    } as Invoice
    try {
      await eventBus.emit({
        type: 'invoice.match_confirmed',
        payload: {
          invoice: settledInvoice,
          transaction: {
            ...transaction,
            invoice_id,
            potential_invoice_id: null,
            journal_entry_id: journalEntryId,
            is_business: true,
            ...(existingTxCategory ? { category: existingTxCategory } : {}),
          } as Transaction,
          userId: ctx.userId,
          companyId: ctx.companyId!,
        },
      })
    } catch (err) {
      txLog.warn('event emit failed (non-critical)', err as Error)
    }
    // A match that settles the invoice in full is its invoice.paid transition;
    // a partial match is not. Same helper as every other settlement door.
    await emitInvoicePaidIfSettled({
      newStatus,
      invoice: settledInvoice,
      paymentAmount: roundOre(newPaidAmount - (invoice.paid_amount ?? 0)),
      paymentDate: transaction.date,
      userId: ctx.userId,
      companyId: ctx.companyId!,
    })
    // A befarad kundförlust reserve the payment made unnecessary comes back
    // (Dr 1519 / Cr 6352), as on every payment path. Never throws.
    await releaseDoubtfulReserveAfterChange(ctx.supabase, ctx.companyId!, ctx.userId, {
      invoiceId: invoice.id,
      entryDate: transaction.date,
      trigger: 'payment',
    })

    return ok(
      {
        success: true,
        invoice_status: newStatus,
        paid_at: paidAt,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
        journal_entry_id: journalEntryId,
        ...(saleJournalEntryId ? { sale_journal_entry_id: saleJournalEntryId } : {}),
        category: existingTxCategory,
      },
      {
        requestId: ctx.requestId,
        ...(sale.warnings.length > 0 ? { warnings: sale.warnings } : {}),
      },
    )
  },
  { requireIdempotencyKey: true },
)
