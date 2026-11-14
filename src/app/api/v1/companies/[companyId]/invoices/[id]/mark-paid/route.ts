/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/mark-paid
 *
 * Manually marks an invoice as paid: for payments received outside the
 * bank-sync flow.
 *
 * Accounting:
 *   - Faktureringsmetoden (accrual): Debit the bank / Credit 1510. The invoice
 *     was already booked as revenue at :mark-sent; this just settles the AR.
 *   - Kontantmetoden (cash): Debit the bank / Credit 30xx + Credit 26xx. Revenue
 *     recognition happens here (no entry at :mark-sent under cash basis).
 *   The bank is the account the invoice asked to be paid to, else the company's
 *   primary bank account; payment_account names another of the company's
 *   cash accounts when the money landed there (resolveInvoicePaymentAccount).
 *   - Faktureringsmetoden with defer_invoice_booking: an invoice sent without
 *     its verifikat gets its sale booked first by the :book step (dated on
 *     the invoice date), then the clearing above (lib/invoices/sale-first.ts).
 *
 * Optional request body (all fields optional: empty POST = book full payment
 * on today's date with default lines):
 *   - payment_date              ISO date; defaults to today
 *   - exchange_rate_difference  SEK adjustment for foreign-currency invoices
 *   - lines                     Custom balanced journal lines (partial payments)
 *   - payment_account           The 19xx cash account the payment landed on
 *
 * Idempotent (mandatory Idempotency-Key). Dry-runnable.
 *
 * On commit the payment goes through settleInvoicePayment, the write path
 * the dashboard and the Stripe sync use (journal entry, invoice_payments row,
 * CAS-guarded status update that makulerar the voucher on a lost race,
 * invoice.paid). This route owns parsing, the payable guards, the FX and
 * settlement-amount derivation, the duplicate guard and the dry run.
 */

import { isKronorCurrency, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { carriedSekOf, paidOfClearedSek } from '@/lib/bookkeeping/ledger-carried-sek'
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { MarkInvoicePaidSchema } from '@/lib/api/schemas'
import { resolveInvoicePaymentAccount } from '@/lib/invoices/invoice-payee'
import { cashPartialBlockReason } from '@/lib/bookkeeping/booking-mode'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import {
  deriveCustomerSettlementAmount,
  planInvoicePaymentForLines,
} from '@/lib/invoices/apply-invoice-payment'
import { paidAtFromDate } from '@/lib/invoices/paid-at'
import { invoicePayableRefusal } from '@/lib/invoices/invoice-payable'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { refundCreditNote, type RefundCreditNoteRow } from '@/lib/invoices/refund-credit-note'
import { requireAccountingMethod } from '@/lib/company/accounting-method'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import {
  clearsReceivable,
  planSaleBeforeSettlement,
  SALE_FIRST_NOT_REQUIRED,
  saleFirstPreview,
} from '@/lib/invoices/sale-first'
import { v1OutcomeResponse } from '@/lib/operations/v1'
import { INVOICE_ITEM_FULL_COLUMNS } from '@/lib/api/v1/invoice-columns'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import type { EntityType, Invoice } from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'

// default_dimensions must stay in this projection: the fetched row feeds the
// payment/cash JE generators, which re-propagate the bag onto every leg —
// dropping the column here silently untags the payment voucher.
const INVOICE_MARK_PAID_RESPONSE_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, vat_rate, moms_ruta, vat_treatment_override, delivery_country, your_reference, our_reference, notes, reverse_charge_text, credited_invoice_id, document_type, converted_from_id, paid_at, paid_amount, remaining_amount, default_dimensions, payment_cash_account_id, created_at, updated_at'

const InvoiceMarkPaidResponse = z.object({
  id: z.string().uuid(),
  invoice_number: z.string(),
  status: z
    .enum(['paid', 'partially_paid', 'sent', 'overdue'])
    .describe('A credit note keeps its status: its refund shows in paid_amount (negative, like its total) and paid_at.'),
  total: z.number(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  paid_at: z.string().nullable(),
  journal_entry_id: z.string().uuid().nullable(),
  sale_journal_entry_id: z
    .string()
    .uuid()
    .optional()
    .describe('The sale verifikat this payment booked first (defer_invoice_booking); absent when none was booked.'),
  refunded_amount: z
    .number()
    .optional()
    .describe('Credit notes only: the kronor this call refunded to the customer.'),
})

registerEndpoint({
  operation: 'invoices.mark-paid',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices/:id/mark-paid',
  summary: 'Record a payment against an invoice.',
  description:
    'Marks a sent / overdue / partially_paid invoice as paid (or partially_paid). Books the payment via Debit the bank account (`payment_account` when the body names one, else the one the invoice asked to be paid to, else the company\'s primary bank account) / Credit 1510 under faktureringsmetoden, or Debit the bank account / Credit revenue + Credit output VAT under kontantmetoden. Optional body supports partial payments via custom balanced journal lines and exchange-rate adjustments for foreign-currency invoices. On a credit note (kreditfaktura) it records the refund paid back to the customer instead: Debit 1510 / Credit the bank account, for what the customer has tillgodo. Idempotent and dry-runnable. Emits invoice.paid (not for a refund).',
  useWhen:
    'A customer paid an invoice via a channel other than the synced bank account (cash, manual transfer, separate processor). Use dry-run to confirm the booking before committing.',
  doNotUseFor:
    'Reverting a payment: the public API does not expose unmark-paid. Issue a credit note via POST /:id/credit to cancel the underlying invoice instead. Bank-matched payments: those flow through the transactions endpoints.',
  pitfalls: [
    'Idempotency-Key is mandatory. Retried marks with the same key replay the cached response.',
    'Not payable: a quote (400 INVOICE_QUOTE_NOT_PAYABLE), a delivery note, a document outside sent/overdue/partially_paid, or an invoice with an active credit note, a draft included (400 INVOICE_PAID_NOT_PAYABLE; details.reason says which). A payment_date after today (Swedish calendar day) returns 400 PAYMENT_DATE_IN_FUTURE. All of these fire under dry-run too.',
    '`payment_account` is the 19xx account the money landed on, for a company that receives customer payments on another bank account than the invoice names or the primary. It must be the ledger account of one of the company\'s own enabled cash accounts (GET /cash-accounts): anything else returns 400 INVOICE_PAID_PAYMENT_ACCOUNT_INVALID with details.available_payment_accounts and books nothing, under dry-run too. It is not sent together with `lines` (400 VALIDATION_ERROR). The dry run answers the resolved account as payment_account.',
    'Custom `lines` must balance (sum of debits = sum of credits, both > 0). Otherwise returns 400 INVOICE_PAID_LINES_UNBALANCED.',
    'For foreign-currency invoices, supply `exchange_rate_difference` (SEK delta vs the invoice\'s booked rate) to book the FX adjustment correctly: the bank takes that figure plus the delta, 1510 clears what it carries and the gap lands on 3960/7960. Omitting it on a non-SEK invoice books the bank at what 1510 carries, with no FX gain/loss.',
    'Custom `lines` are journal lines and therefore SEK, while `total` / `paid_amount` / `remaining_amount` are stored in the invoice currency. A line total equal to what 1510 carries pays the whole remainder, any other its share of that (at `invoice.exchange_rate` when the ledger cannot say); a non-SEK invoice with no exchange_rate on file returns 400 MATCH_INVOICE_BOOKING_RATE_MISSING rather than silently treating the SEK amount as invoice currency.',
    'Cash basis (kontantmetoden) recognizes revenue HERE, not at :mark-sent. The dashboard tracks this via company_settings.accounting_method.',
    'Faktureringsmetoden with defer_invoice_booking (Registrera men bokför inte): an invoice sent without its verifikat is booked first by the :book step (Debit 1510 / Credit revenue + output VAT, dated on the invoice date), then the payment clears that 1510. sale_journal_entry_id in the response names it, and the dry run returns it as sale_entry. When the book step refuses (invoice date in a locked period PERIOD_LOCKED, no fiscal year INVOICE_BOOK_NO_FISCAL_PERIOD, a partially paid invoice INVOICE_BOOK_INVALID_STATUS), or the payment date is locked (PERIOD_LOCKED with details.payment_date), the payment is refused with that code, details.sale_first is true, and nothing is booked.',
    'Credit notes: the refund is recorded for an issued SEK credit note with its verifikat and no ROT/RUT, up to what the customer has tillgodo (409 CREDIT_NOTE_REFUND_UNSUPPORTED or CREDIT_NOTE_REFUND_NOTHING_OWED otherwise). Custom `lines` must debit 1510 only. 409 CREDIT_NOTE_REFUND_LIKELY_BOOKED when a manual verifikat already debits 1510 with the amount; `force: true` (fresh Idempotency-Key) books it anyway.',
    'Duplicate-payment guard: if an unlinked inbound bank transaction looks like this payment, returns 409 INVOICE_PAID_LIKELY_DUPLICATE with candidate transactions. Retry with `force: true` to bypass, but the retry MUST use a fresh Idempotency-Key (the original is body-hash bound; reusing it returns 400 IDEMPOTENCY_KEY_REUSE). The guard is also evaluated under dry-run, so a successful dry-run does not guarantee a successful commit.',
  ],
  example: {
    request: { payment_date: '2026-05-12' },
    response: {
      data: {
        id: '0e9c…',
        invoice_number: '2026-0042',
        status: 'paid',
        total: 12500,
        paid_amount: 12500,
        remaining_amount: 0,
        paid_at: '2026-05-12',
        journal_entry_id: '7b3a…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: true,
  request: { body: MarkInvoicePaidSchema },
  response: { success: dataEnvelope(InvoiceMarkPaidResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.mark-paid',
  async (request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    // Body is optional. Empty POST → book full payment today.
    let rawBody: unknown = null
    try {
      const text = await request.text()
      if (text.trim()) rawBody = JSON.parse(text)
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    let exchangeRateDifference: number | undefined
    let bodyPaymentDate: string | undefined
    let customLines:
      | {
          account_number: string
          debit_amount: number
          credit_amount: number
          line_description?: string
          dimensions?: Record<string, string>
        }[]
      | undefined
    let force = false
    let paymentAccount: string | undefined
    if (rawBody) {
      const parsed = MarkInvoicePaidSchema.safeParse(rawBody)
      if (!parsed.success) return v1ValidationError(ctx, parsed.error)
      exchangeRateDifference = parsed.data.exchange_rate_difference
      bodyPaymentDate = parsed.data.payment_date
      customLines = parsed.data.lines
      force = parsed.data.force === true
      paymentAccount = parsed.data.payment_account
    }

    // Pre-flight: fetch invoice with relations needed for journal entry.
    // journal_entry_id (booking-state routing) and deduction_total (ROT/RUT
    // settlement derivation) are fetched ad hoc: they stay out of
    // INVOICE_MARK_PAID_RESPONSE_COLUMNS so the response contract is
    // unchanged. The items carry every column the booking builders read
    // (INVOICE_ITEM_FULL_COLUMNS, pinned by its test): without
    // deduction_type/_amount a kontantmetod ROT/RUT payment books no 1513 leg
    // and debits the bank for the full total, and without revenue_account an
    // override account lands on the default 30xx.
    const { data: invoice, error: fetchErr } = await ctx.supabase
      .from('invoices')
      .select(
        `${INVOICE_MARK_PAID_RESPONSE_COLUMNS}, journal_entry_id, deduction_total, customer:customers(id, name, customer_type), items:invoice_items(${INVOICE_ITEM_FULL_COLUMNS})`,
      )
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!invoice) {
      ctx.log.warn('invoices.mark-paid: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('INVOICE_PAID_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    const typed = invoice as unknown as Invoice & { customer?: { name?: string } }

    // The account the entry debits (a refund credits): the one the caller
    // names, else the invoice's payee, else the primary bank account. Asked
    // before anything is written, on the dry run too.
    const settlementAccountOrRefusal = async (): Promise<string | Response> => {
      const resolved = await resolveInvoicePaymentAccount(ctx.supabase, ctx.companyId!, typed, paymentAccount)
      if (resolved.ok) return resolved.account
      return v1ErrorResponseFromCode(resolved.code, ctx.log, {
        requestId: ctx.requestId,
        details: resolved.details,
      })
    }

    // A kreditfaktura: the company pays its credit back to the customer. The
    // same door records that refund (Dr 1510 / Cr bank), dry run included.
    if (typed.credited_invoice_id) {
      if (exchangeRateDifference) {
        return v1ErrorResponseFromCode('CREDIT_NOTE_REFUND_UNSUPPORTED', ctx.log, {
          requestId: ctx.requestId,
          details: { reason: 'foreign_currency' },
        })
      }
      const refundAccount = await settlementAccountOrRefusal()
      if (typeof refundAccount !== 'string') return refundAccount
      const refund = await refundCreditNote(ctx.supabase, ctx.companyId!, ctx.userId, {
        creditNote: typed as unknown as RefundCreditNoteRow,
        refundDate: bodyPaymentDate || todayIsoStockholm(),
        settlementAccountNumber: refundAccount,
        customLines,
        force,
        dryRun: ctx.dryRun,
      })
      if (!refund.ok) {
        if (refund.code === 'BOOKKEEPING_ERROR' || refund.code === 'DB_ERROR') {
          return v1ErrorResponse(refund.error, ctx.log, { requestId: ctx.requestId })
        }
        return v1ErrorResponseFromCode(refund.code, ctx.log, {
          requestId: ctx.requestId,
          ...('details' in refund ? { details: refund.details } : {}),
        })
      }
      const { items: _refundItems, customer: _refundCustomer, journal_entry_id: _creditVoucher, deduction_total: _refundDeduction, ...refundHeader } =
        typed as Invoice & { deduction_total?: number | null }
      if (refund.dryRun) {
        return dryRunPreview(
          {
            ...refundHeader,
            paid_amount: refund.paidAmount,
            paid_at: refund.refundedAt,
            refunded_amount: refund.amount,
            would_create_journal_entry: true,
            journal_entry_preview: refund.lines,
          },
          { requestId: ctx.requestId, log: ctx.log },
        )
      }
      const { data: storedCreditNote } = await ctx.supabase
        .from('invoices')
        .select(INVOICE_MARK_PAID_RESPONSE_COLUMNS)
        .eq('company_id', ctx.companyId!)
        .eq('id', invoiceId)
        .maybeSingle()
      return ok(
        {
          ...((storedCreditNote ?? { ...refundHeader, paid_amount: refund.paidAmount, paid_at: refund.refundedAt }) as object),
          journal_entry_id: refund.journalEntryId,
          refunded_amount: refund.amount,
        },
        { requestId: ctx.requestId },
      )
    }

    const paymentDate = bodyPaymentDate || todayIsoStockholm()
    const paidAt = paidAtFromDate(paymentDate)

    // The one answer of every door, here so a dry run hears it too and it
    // comes before the duplicate guard (settleInvoicePayment asks again).
    const notPayable = await invoicePayableRefusal(ctx.supabase, ctx.companyId!, typed, paymentDate)
    if (notPayable) {
      return v1ErrorResponseFromCode(notPayable.code, ctx.log, {
        requestId: ctx.requestId,
        details: notPayable.details,
      })
    }

    // Validate custom lines balance (if supplied).
    if (customLines) {
      const { balanced, totalDebit, totalCredit } = lineBalance(customLines)
      if (!balanced) {
        return v1ErrorResponseFromCode('INVOICE_PAID_LINES_UNBALANCED', ctx.log, {
          requestId: ctx.requestId,
          details: { total_debit: totalDebit, total_credit: totalCredit },
        })
      }
    }

    // Fetch settings for accounting method + entity type. Fail closed
    // (accounted#58): an unreadable method or form refuses instead of
    // defaulting to faktureringsmetoden or enskild firma.
    const settingsRead = await ctx.supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const accountingMethod = requireAccountingMethod(settingsRead)
    const entityType: EntityType = await resolveCompanyEntityType(
      ctx.supabase,
      ctx.companyId!,
      (settingsRead.data as { entity_type?: string } | null)?.entity_type,
    )

    // The JE shape is driven by the invoice's actual booking state, not the
    // company's current accounting_method. An invoice that was booked at send
    // under accrual (Dr 1510) must be cleared at payment regardless of where
    // the setting sits today: otherwise the receivable orphans and 30xx +
    // VAT double-count. Only true kontantmetoden invoices (never booked)
    // recognise revenue + VAT here.
    const invoiceAlreadyBooked = !!(typed as { journal_entry_id?: string | null }).journal_entry_id

    // Unit contract: total / paid_amount / remaining_amount are stored in the
    // INVOICE currency (total_sek carries the SEK view of total, and there is
    // no remaining_amount_sek twin); custom lines are journal lines, so they
    // are always SEK. The SEK amount therefore has to be converted before it is
    // compared against, or subtracted from, the invoice-currency remaining. The
    // default path (no lines) already pays the remaining in invoice currency
    // and needs no rate at all.
    const isForeignCurrency = !!typed.currency && typed.currency !== 'SEK'
    const needsFxConversion = isForeignCurrency && customLines !== undefined
    const fxRate: number | null =
      typed.exchange_rate && typed.exchange_rate > 0 ? typed.exchange_rate : null
    if (needsFxConversion && fxRate === null) {
      // Never fall back to rate 1: that reads an 11 496,70 kr payment against a
      // 1 000 EUR invoice as 11 496,70 EUR and corrupts the AR sub-ledger.
      // Same code as buildInvoicePaymentClearingLines' refusal
      // (MATCH_INVOICE_BOOKING_RATE_MISSING, lib/bookkeeping/invoice-payment-lines.ts):
      // one condition, one code across every invoice-settlement surface.
      ctx.log.warn('mark-paid rejected: foreign-currency invoice without exchange rate', {
        invoiceId,
        currency: typed.currency,
      })
      return v1ErrorResponseFromCode('MATCH_INVOICE_BOOKING_RATE_MISSING', ctx.log, {
        requestId: ctx.requestId,
        details: { invoice_id: invoiceId, currency: typed.currency },
      })
    }

    // Compute the would-be payment amount. Default path (no customLines):
    // use remaining_amount, not total: protects against over-crediting AR
    // when a concurrent partial payment slips through the pre-flight check
    // (pre-flight sees status='sent' but the race-guard UPDATE later sees
    // status='partially_paid' so a second full-total amount would be booked
    // against an already-reduced AR balance). For legacy rows where
    // remaining_amount was never written, derive it from total - paid_amount
    // rather than the full total. This is the booking-currency amount (SEK for
    // custom lines) used by the duplicate guard, the JE builder, and the event.
    //
    // Custom lines yield the customer settlement, not the gross debit sum: the
    // kontantmetoden ROT/RUT entry carries a second debit leg on 1513
    // (Skatteverket's share) while remaining_amount is stored net of the
    // deduction, so summing all debits would reject every such invoice with
    // MATCH_AMOUNT_EXCEEDS_REMAINING by exactly deduction_total (see
    // deriveCustomerSettlementAmount). deduction_total is invoice-currency;
    // the cap is converted to SEK to match the lines.
    //
    // Gated on the invoice NOT being booked yet: an invoice booked at send
    // already debited 1513 in its registration entry, so a 1513 debit in the
    // PAYMENT lines is always wrong there (double 1513, double 30xx/26xx).
    // For those, the gross sum stays the payment amount and the overpayment
    // guard keeps rejecting the wrong-shaped entry exactly as before.
    const deductionTotal = invoiceAlreadyBooked
      ? 0
      : (typed as { deduction_total?: number | null }).deduction_total ?? 0
    const deductionCapSek =
      deductionTotal > 0 && needsFxConversion
        ? sekOfForeign(deductionTotal, fxRate!)
        : deductionTotal
    const remainingAmount = typed.remaining_amount ?? typed.total - (typed.paid_amount ?? 0)
    const paymentAmount = customLines
      ? deriveCustomerSettlementAmount(customLines, deductionCapSek)
      : remainingAmount
    const paymentAmountInInvoiceCurrency = needsFxConversion
      ? paidOfClearedSek({
          sek: paymentAmount,
          remaining: remainingAmount,
          carried: await carriedSekOf(ctx.supabase, ctx.companyId!, 'customer', typed),
          rate: fxRate!,
        })
      : paymentAmount

    // Ledger math + overpayment guard via the shared planInvoicePayment helper:
    // the single source of truth across all three mark-paid surfaces (this route,
    // the dashboard route, and the agent commit path), so the paid/remaining/
    // status math can never drift again. It is FX-agnostic by contract, so it
    // gets the converted amount.
    // Custom-line SEK settlements absorb a sub-krona öresavrundning residual
    // (rounded "Att betala" vs the stored öre total), but ONLY when the lines
    // actually carry the residual on 3740: otherwise the strict plan applies
    // (sub-krona partials stay partial, overshoot rejects), mirroring the
    // dashboard mark-paid flow. The default path pays the exact remaining, so
    // absorption is a no-op there.
    // Lines for a SEK invoice whose issue verifikat booked the öresavrundning
    // carry only the rest of it on 3740 (carriedSekOf).
    const linesCarriedSek =
      customLines && invoiceAlreadyBooked && isKronorCurrency(typed.currency)
        ? await carriedSekOf(ctx.supabase, ctx.companyId!, 'customer', typed)
        : null
    const payment = planInvoicePaymentForLines(
      typed,
      paymentAmountInInvoiceCurrency,
      customLines,
      typed.currency ?? 'SEK',
      linesCarriedSek,
    )
    if (!payment.ok) {
      return v1ErrorResponseFromCode('MATCH_AMOUNT_EXCEEDS_REMAINING', ctx.log, {
        requestId: ctx.requestId,
        details: payment.details,
      })
    }
    const { newPaidAmount, newRemaining, newStatus, isFullyPaid } = payment.plan
    const isPartial = customLines !== undefined && !isFullyPaid

    // The generated cash entry books the FULL invoice and takes no payment
    // amount: reject partials and part-paid completions for never-booked
    // kontantmetoden invoices (mirrors the v1 match-invoice guard;
    // bokslutsmetoden reports moms at payment, so each installment's moms
    // belongs to its own receipt period). Custom lines are not exempt: they would book
    // the same full-invoice shape under a user-shaped label.
    const cashBlock = cashPartialBlockReason({
      invoiceAlreadyBooked,
      accountingMethod,
      priorPaidAmount: typed.paid_amount,
      paysRemainingInFull: isFullyPaid,
    })
    if ((!typed.document_type || typed.document_type === 'invoice') && cashBlock) {
      return v1ErrorResponseFromCode('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: cashBlock,
          payment_amount: paymentAmountInInvoiceCurrency,
          paid_amount: typed.paid_amount ?? 0,
          invoice_total: typed.total,
        },
      })
    }

    // Duplicate-payment guard: surface a likely-matching unlinked inbound
    // bank transaction before booking (or before dry-run preview, so a
    // successful dry-run can't mask the warning). Skipped on partial
    // payments (paymentAmount < remaining is an explicit, deliberate action),
    // on force=true, and on invoices without a resolved customer name.
    // Both sides in invoice currency: remaining_amount is stored that way, so
    // the SEK custom-line total must be the converted one, never the raw SEK.
    // The candidate lookup below takes the same converted figure: it scans
    // transactions.amount, which is denominated in the BANK ROW's currency
    // (not necessarily kronor), and bands each currency separately from the
    // invoice's stored conversion.
    const remainingForGuard = typed.remaining_amount ?? typed.total
    const paidRoundedGuard = Math.round(paymentAmountInInvoiceCurrency * 100) / 100
    const remainingRoundedGuard = Math.round(remainingForGuard * 100) / 100
    const guardApplies = paidRoundedGuard >= remainingRoundedGuard
    if (!force && guardApplies) {
      const customerName = typed.customer?.name
      if (!customerName) {
        ctx.log.warn('duplicate-payment guard skipped', {
          reason: 'missing_customer_name',
          invoiceId,
        })
      } else {
        const candidates = await findDuplicatePaymentCandidatesForInvoice(ctx.supabase, {
          companyId: ctx.companyId!,
          invoice: {
            invoice_number: typed.invoice_number,
            customer_name: customerName,
            currency: typed.currency ?? null,
            total: typed.total ?? null,
            total_sek: typed.total_sek ?? null,
            exchange_rate: typed.exchange_rate ?? null,
          },
          paymentAmount: paymentAmountInInvoiceCurrency,
          paymentDate,
        })
        if (candidates.length > 0) {
          return v1ErrorResponseFromCode('INVOICE_PAID_LIKELY_DUPLICATE', ctx.log, {
            requestId: ctx.requestId,
            details: { candidates },
          })
        }
      }
    } else if (force) {
      ctx.log.warn('duplicate-payment guard bypassed', {
        reason: 'force=true',
        invoiceId,
        userId: ctx.userId,
        paymentAmount,
      })
    }

    if (ctx.dryRun) {
      // The commit books a deferring company's unbooked invoice first, through
      // the :book step (lib/invoices/sale-first.ts): its dry run is every check
      // that booking runs, so a preview shows both verifikat and cannot mask a
      // refusal. Custom lines that book the revenue themselves need none.
      const salePlan =
        customLines && !clearsReceivable(customLines)
          ? SALE_FIRST_NOT_REQUIRED
          : await planSaleBeforeSettlement(
              { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
              typed,
              { settlementDate: paymentDate },
            )
      if (!salePlan.ok) return v1OutcomeResponse(salePlan, ctx)
      const previewAccount = await settlementAccountOrRefusal()
      if (typeof previewAccount !== 'string') return previewAccount
      return dryRunPreview(
        {
          ...typed,
          status: newStatus,
          paid_amount: newPaidAmount,
          remaining_amount: newRemaining,
          paid_at: paidAt,
          would_create_journal_entry: !typed.document_type || typed.document_type === 'invoice',
          accounting_method: accountingMethod,
          would_use_custom_lines: customLines !== undefined,
          // The account the committed entry will debit, already resolved, so a
          // caller can verify the routing before committing.
          payment_account: previewAccount,
          ...saleFirstPreview(salePlan),
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Commit: the dashboard's write path. Journal entry (custom lines | cash
    // entry for a never-booked kontantmetod invoice | clearing entry against
    // 1510), invoice_payments row, CAS-guarded status update (a lost race or a
    // failed update makulerar the voucher and removes the row), suggestion
    // cleanup and invoice.paid. The generated debit lands on the bank account
    // the invoice asked to be paid to (the primary bank account when none was
    // chosen).
    const settlementAccountNumber = await settlementAccountOrRefusal()
    if (typeof settlementAccountNumber !== 'string') return settlementAccountNumber
    const result = await settleInvoicePayment(ctx.supabase, ctx.companyId!, ctx.userId, {
      invoice: typed,
      paymentAmountInInvoiceCurrency,
      paymentDate,
      accountingMethod,
      entityType,
      exchangeRateDifference,
      customLines,
      settlementAccountNumber,
      paymentSource: 'manual',
      // force on a partial overrides nothing: the guard never runs there.
      ...(force && guardApplies
        ? {
            duplicateGuardBypass: {
              user_id: ctx.userId,
              actor_id: ctx.apiKeyId ?? null,
              actor_type: ctx.actor.type,
              actor_label: ctx.actor.label ?? null,
            },
          }
        : {}),
    })

    if (!result.ok) {
      switch (result.code) {
        case 'SALE_FIRST_REFUSED':
          // The :book step's own code, details.sale_first: nothing was written.
          return v1OutcomeResponse(result.refusal, ctx)
        case 'BOOKKEEPING_ERROR':
          return v1ErrorResponse(result.error, ctx.log, { requestId: ctx.requestId })
        case 'UPDATE_FAILED':
          ctx.log.error('mark-paid: invoice update failed', result.error as Error, {
            invoiceId,
            companyId: ctx.companyId,
          })
          return v1ErrorResponseFromCode('INVOICE_PAID_BOOK_FAILED', ctx.log, {
            requestId: ctx.requestId,
          })
        case 'INVOICE_PAID_BOOK_FAILED': {
          // The raw driver text stays in the server log; API callers get the
          // reason code, or the engine's message in Swedish.
          ctx.log.error('mark-paid: payment not booked', undefined, {
            invoiceId,
            companyId: ctx.companyId,
            details: result.details,
          })
          const reason = String(result.details.reason ?? '')
          return v1ErrorResponseFromCode('INVOICE_PAID_BOOK_FAILED', ctx.log, {
            requestId: ctx.requestId,
            details: {
              reason:
                reason === 'no_journal_entry_created' || reason === 'payment_row_insert_failed'
                  ? reason
                  : getErrorMessage({ message: reason }, { context: 'invoice' }),
            },
          })
        }
        case 'INVOICE_PAID_NO_FISCAL_PERIOD':
          return v1ErrorResponseFromCode(result.code, ctx.log, {
            requestId: ctx.requestId,
            details: { payment_date: paymentDate },
          })
        case 'INVOICE_PAID_RACE':
          // Status transitioned (concurrent mark-paid / credit) between
          // pre-flight and the update; the voucher is already makulerad.
          return v1ErrorResponseFromCode(result.code, ctx.log, { requestId: ctx.requestId })
        default:
          return v1ErrorResponseFromCode(result.code, ctx.log, {
            requestId: ctx.requestId,
            details: result.details,
          })
      }
    }
    const { newStatus: settledStatus, journalEntryId } = result

    // The response is the row as stored (the public projection, never the
    // pre-flight's items or customer).
    const { data: stored } = await ctx.supabase
      .from('invoices')
      .select(INVOICE_MARK_PAID_RESPONSE_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()
    const { items: _items, customer: _customer, journal_entry_id: _registration, deduction_total: _deduction, ...header } =
      typed as Invoice & { deduction_total?: number | null }
    const updated = stored ?? {
      ...header,
      status: settledStatus,
      paid_amount: result.newPaidAmount,
      remaining_amount: result.newRemaining,
      paid_at: result.paidAt ?? typed.paid_at,
    }

    ctx.log.info('invoices.mark-paid success', {
      invoiceId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      newStatus: settledStatus,
      journalEntryId,
      paymentAmount,
      isPartial,
    })

    return ok(
      {
        ...(updated as object),
        journal_entry_id: journalEntryId,
        ...(result.saleJournalEntryId ? { sale_journal_entry_id: result.saleJournalEntryId } : {}),
      },
      {
        requestId: ctx.requestId,
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      },
    )
  },
  { requireIdempotencyKey: true },
)
