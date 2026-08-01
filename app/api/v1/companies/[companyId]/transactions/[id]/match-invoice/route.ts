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
 * Mirrors the internal route's failure ordering exactly. Idempotent on
 * (transaction, key). NOT dry-runnable: the multi-row interlock makes a
 * meaningful preview infeasible without staging the JE for real, and dry-
 * run is reserved for endpoints where the caller benefits from a fully
 * resolved preview before commit. Skip the flag here; document it.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { MatchInvoiceSchema } from '@/lib/api/schemas'
import { createInvoiceCashEntry } from '@/lib/bookkeeping/invoice-entries'
import { buildInvoicePaymentClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { coerceDimensionsBag } from '@/lib/bookkeeping/dimension-resolver'
import { resolveSettlementAccount } from '@/lib/bookkeeping/settlement-account'
import { findUnresolvableAccounts } from '@/lib/bookkeeping/account-validation'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { reverseEntry, createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { planInvoicePayment } from '@/lib/invoices/apply-invoice-payment'
import { detectDuplicatePaymentVoucher } from '@/lib/invoices/duplicate-payment-detection'
import { clearSettledInvoiceSuggestions } from '@/lib/invoices/clear-settled-invoice-suggestions'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { eventBus } from '@/lib/events/bus'
import type { Currency, EntityType, Invoice, Transaction } from '@/types'

const MatchInvoiceResponse = z.object({
  success: z.boolean(),
  invoice_status: z.string(),
  paid_at: z.string().nullable(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  journal_entry_id: z.string().uuid().nullable(),
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

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = MatchInvoiceSchema.safeParse(rawBody)
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
        // `amount` is in `currency`; the 19xx legs the detector compares it
        // against are always SEK. Selected above via select('*').
        transactionCurrency: transaction.currency ?? null,
        transactionAmountSek: transaction.amount_sek ?? null,
        transactionExchangeRate: transaction.exchange_rate ?? null,
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

    if (transaction.journal_entry_id) {
      try {
        await reverseEntry(ctx.supabase, ctx.companyId!, ctx.userId, transaction.journal_entry_id)
        const { error: clearErr } = await ctx.supabase
          .from('transactions')
          .update({ journal_entry_id: null })
          .eq('id', txId)
          .eq('company_id', ctx.companyId!)
        if (clearErr) {
          txLog.warn('failed to clear journal_entry_id after storno', clearErr)
        }
        logMatchEvent(ctx.supabase, ctx.userId, txId, 'storno_conflict_resolved', {
          invoiceId: invoice_id,
          previousState: { journal_entry_id: transaction.journal_entry_id },
          newState: { journal_entry_id: null },
        })
      } catch (err) {
        txLog.error('storno failed', err as Error)
        return v1ErrorResponse(err, txLog, { requestId: ctx.requestId })
      }
    }

    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', ctx.companyId!)
      .single()
    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType: EntityType =
      (settings?.entity_type as EntityType) || 'enskild_firma'

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

    // Reject cash-method partial payments ONLY for pure kontantmetoden
    // invoices (no prior JE). Under kontantmetoden utgående moms must be
    // reported in the period of actual receipt (ML 13 kap 8 §); the
    // partial-payment branch uses the accrual-style clearing entry which
    // doesn't model the per-installment moms event. When the invoice was
    // already booked under accrual, the clearing entry IS the correct
    // partial path regardless of the company's current setting.
    if (!invoiceAlreadyBooked && accountingMethod === 'cash' && !isFullyPaid) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', txLog, {
        requestId: ctx.requestId,
        details: {
          field: 'accounting_method',
          message:
            'Kontantmetoden does not support partial-payment matching via this endpoint. ' +
            'Match the full payment when received, or switch to accrual (faktureringsmetoden).',
          accounting_method: 'cash',
          payment_amount: paidAmount,
          invoice_total: invoice.total,
        },
      })
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

    // Strict-mode for the public API: if the payment JE can't be created we
    // ABORT before touching invoice / payment / transaction state. The
    // dashboard's internal route soft-fails here and surfaces a banner so
    // the user can re-book manually; the v1 caller is an automation with
    // no UI, so a partial state (invoice marked paid, GL has no entry) is
    // strictly worse than a clean failure to retry.
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
        const sourceType = useCashEntry ? 'invoice_cash_payment' : 'invoice_paid'
        const desc = invoice.customer?.name
          ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
          : `Inbetalning kundfaktura ${invoice.invoice_number}`
        const je = await createJournalEntry(ctx.supabase, ctx.companyId!, ctx.userId, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: desc,
          source_type: sourceType,
          source_id: invoice.id,
          lines: customLines,
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
        )
        journalEntryId = je?.id ?? null
      } else {
        // Clearing entry against 1510, built by the SAME shared helper the
        // dashboard route and its preview use, so all three produce byte-
        // identical lines: bank leg = the actual SEK that hit the account,
        // 1510 credited at the invoice's booking rate, and a 3960/7960 FX-diff
        // line (or a 3740 öresavrundning line on pure SEK) making the verifikat
        // balance per BFL 5 kap 4-5§.
        const fiscalPeriodId = await findFiscalPeriod(
          ctx.supabase,
          ctx.companyId!,
          transaction.date,
        )
        if (!fiscalPeriodId) {
          return v1ErrorResponseFromCode('INVOICE_PAID_NO_FISCAL_PERIOD', txLog, {
            requestId: ctx.requestId,
            details: { payment_date: transaction.date },
          })
        }
        const desc = invoice.customer?.name
          ? `Inbetalning kundfaktura ${invoice.invoice_number}, ${invoice.customer.name}`
          : `Inbetalning kundfaktura ${invoice.invoice_number}`
        const { lines: clearingLines } = buildInvoicePaymentClearingLines(
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
          },
          desc,
          fx.required ? fx.paidInInvoiceCurrency : undefined,
          paymentAccount,
        )
        // Re-propagate the invoice's default dimension bag onto every leg,
        // including the FX result lines, so a project's kursvinst/kursförlust
        // stays inside the project P&L. createInvoicePaymentJournalEntry did
        // this for v1 before; keeping it means the switch to the shared
        // line-builder is not a silent regression for dimension users. Copied
        // per line: a shared object would let one line's mutation leak.
        const defaultDimensions = coerceDimensionsBag(
          (invoice as { default_dimensions?: unknown }).default_dimensions,
        )
        if (defaultDimensions) {
          for (const line of clearingLines) line.dimensions = { ...defaultDimensions }
        }
        const je = await createJournalEntry(ctx.supabase, ctx.companyId!, ctx.userId, {
          fiscal_period_id: fiscalPeriodId,
          entry_date: transaction.date,
          description: desc,
          source_type: 'invoice_paid',
          source_id: invoice.id,
          lines: clearingLines,
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
        details: { reason: getErrorMessage(err, { context: 'invoice' }) },
      })
    }

    // Re-attach invoice PDF to the payment JE (BFL 7 kap underlag).
    if (journalEntryId && invoice.journal_entry_id) {
      try {
        const { data: invoiceDoc } = await ctx.supabase
          .from('document_attachments')
          .select('storage_path, file_name, file_size_bytes, mime_type, sha256_hash')
          .eq('journal_entry_id', invoice.journal_entry_id)
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
      .in('status', ['sent', 'overdue', 'partially_paid'])
      .select('id')
    if (updateInvErr) return v1ErrorResponse(updateInvErr, txLog, { requestId: ctx.requestId })
    if (!updatedRows || updatedRows.length === 0) {
      return v1ErrorResponseFromCode('MATCH_INVOICE_ALREADY_PAID', txLog, {
        requestId: ctx.requestId,
      })
    }

    // The "intäkt bokförs vid slutbetalning" note only applies to genuine
    // kontantmetoden partials: never-booked invoices. When the invoice was
    // booked under accrual, the clearing entry handles the partial cleanly
    // and the note would be misleading.
    const cashMethodNote =
      !invoiceAlreadyBooked && accountingMethod === 'cash' && !isFullyPaid
        ? 'Kontantmetoden: intäkt bokförs vid slutbetalning'
        : null

    // Provenance for a caller-supplied FX rate. A Riksbanken spot rate is
    // self-documenting (rate + date are reproducible); a rate passed in the
    // request body overrides the ML 8 kap 21-23§ obligation and must leave a
    // trail on the payment row (BFL 5 kap 6-7§).
    const manualRateNote =
      fx.required && fx.source === 'manual'
        ? `Manuell valutakurs ${fx.rate} ${invoice.currency}/SEK (betalningsdatum ${transaction.date})`
        : null

    const paymentNotes = [cashMethodNote, manualRateNote].filter(Boolean).join(' · ') || null

    // amount and currency must agree: the row stores the payment in INVOICE
    // currency (the column's unit), never a SEK magnitude wearing the invoice's
    // foreign currency code. exchange_rate is the rate ACTUALLY USED for this
    // payment (Riksbanken or the caller's override on the payment date, per
    // ML 8 kap 21-23§), falling back to the invoice's booking rate only when no
    // conversion was needed.
    const { error: paymentInsertErr } = await ctx.supabase
      .from('invoice_payments')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        invoice_id,
        payment_date: transaction.date,
        amount: paidAmount,
        currency: invoice.currency,
        exchange_rate: fx.required ? fx.rate : invoice.exchange_rate,
        journal_entry_id: journalEntryId,
        transaction_id: txId,
        notes: paymentNotes,
      })
    if (paymentInsertErr) {
      if (paymentInsertErr.code === '23505') {
        return v1ErrorResponseFromCode('MATCH_INVOICE_DUPLICATE_PAYMENT', txLog, {
          requestId: ctx.requestId,
        })
      }
      txLog.error('failed to record payment', paymentInsertErr)
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

    logMatchEvent(ctx.supabase, ctx.userId, txId, 'matched', {
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

    try {
      eventBus.emit({
        type: 'invoice.match_confirmed',
        payload: {
          invoice: {
            ...invoice,
            status: newStatus,
            paid_at: paidAt,
            paid_amount: newPaidAmount,
            remaining_amount: newRemaining,
          } as Invoice,
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

    return ok(
      {
        success: true,
        invoice_status: newStatus,
        paid_at: paidAt,
        paid_amount: newPaidAmount,
        remaining_amount: newRemaining,
        journal_entry_id: journalEntryId,
        category: existingTxCategory,
      },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)
