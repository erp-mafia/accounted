import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { carriedSekOf, paidOfClearedSek } from '@/lib/bookkeeping/ledger-carried-sek'
import { NextResponse } from 'next/server'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { requireAccountingMethod } from '@/lib/company/accounting-method'
import { MarkInvoicePaidSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { deriveCustomerSettlementAmount } from '@/lib/invoices/apply-invoice-payment'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import { invoicePayableRefusal } from '@/lib/invoices/invoice-payable'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { resolveInvoicePaymentAccount } from '@/lib/invoices/invoice-payee'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { sessionFailureResponse } from '@/lib/operations/session'
import { refundCreditNote, type RefundCreditNoteRow, type RefundCustomLine } from '@/lib/invoices/refund-credit-note'
import type { RouteContext } from '@/lib/api/with-route-context'
import type { Logger } from '@/lib/logger'
import type { Invoice } from '@/types'

/**
 * The refund of a kreditfaktura (follow-up of crm#1435): the body is the
 * mark-paid body, payment_date being the refund's date and lines the
 * person's own rows (Dr 1510 / Cr the bank). Without lines the whole amount
 * owed goes out of the account the customer paid to (the credit note's
 * payee, the primary bank account when none was chosen). The credit note keeps its status: the
 * response says so with refund: true.
 */
async function creditNoteRefundResponse(
  request: Request,
  ctx: RouteContext,
  creditNote: RefundCreditNoteRow,
  opLog: Logger,
): Promise<Response> {
  const { user, supabase, companyId, requestId } = ctx
  let rawBody: unknown
  try {
    const text = await request.text()
    if (text) rawBody = JSON.parse(text)
  } catch {
    // Empty / invalid body: the whole refund, today.
  }
  let body: { payment_date?: string; lines?: RefundCustomLine[]; force?: boolean; payment_account?: string } = {}
  if (rawBody) {
    const parsed = MarkInvoicePaidSchema.safeParse(rawBody)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ogiltig förfrågan', details: parsed.error.flatten() }, { status: 400 })
    }
    // A refund is in kronor (planCreditNoteRefund refuses another currency),
    // so it never carries an exchange difference.
    if (parsed.data.exchange_rate_difference) {
      return errorResponseFromCode('CREDIT_NOTE_REFUND_UNSUPPORTED', opLog, {
        requestId,
        details: { reason: 'foreign_currency' },
      })
    }
    body = parsed.data
  }

  // The account the refund leaves: the one the caller names, else the credit
  // note's payee, else the primary bank account.
  const refundAccount = await resolveInvoicePaymentAccount(supabase, companyId, creditNote, body.payment_account)
  if (!refundAccount.ok) {
    return errorResponseFromCode(refundAccount.code, opLog, { requestId, details: refundAccount.details })
  }
  const result = await refundCreditNote(supabase, companyId, user.id, {
    creditNote,
    refundDate: body.payment_date || todayIsoStockholm(),
    settlementAccountNumber: refundAccount.account,
    customLines: body.lines,
    force: body.force === true,
  })
  if (!result.ok) {
    if (result.code === 'BOOKKEEPING_ERROR' || result.code === 'DB_ERROR') {
      return errorResponse(result.error, opLog, { requestId })
    }
    return errorResponseFromCode(result.code, opLog, {
      requestId,
      ...('details' in result ? { details: result.details } : {}),
    })
  }
  return NextResponse.json({
    success: true,
    refund: true,
    status: creditNote.status,
    paid_at: result.refundedAt,
    paid_amount: result.paidAmount,
    refunded_amount: result.amount,
    owed_after: result.owedAfter,
    journal_entry_id: result.journalEntryId,
  })
}

/**
 * POST /api/invoices/[id]/mark-paid
 *
 * Manually marks an invoice as paid (for payments received outside bank sync).
 *
 * Faktureringsmetoden (accrual): Debit 1930, Credit 1510 (clearing entry)
 * Kontantmetoden (cash):         Debit 1930, Credit 30xx, Credit 26xx
 *
 * A company that books invoices in a separate step (defer_invoice_booking)
 * gets an unbooked invoice's sale booked first, by the Bokför step on its
 * invoice date, then the clearing (lib/invoices/sale-first.ts); a refusal
 * there refuses the payment with nothing written.
 *
 * The booking + status transition live in settleInvoicePayment (shared with
 * the Stripe payment sync); this route owns request parsing and the
 * duplicate-payment advisory.
 */
export const POST = withRouteContext(
  'invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_PAID_NOT_FOUND', opLog, { requestId })
    }

    // A kreditfaktura is not paid by the customer: the company pays its
    // credit back. The same door records that refund (Dr 1510 / Cr bank).
    if (invoice.credited_invoice_id) {
      return creditNoteRefundResponse(request, ctx, invoice as RefundCreditNoteRow, opLog)
    }

    // Optional body. Backwards-compat: callers may POST with no body.
    let exchangeRateDifference: number | undefined
    let bodyPaymentDate: string | undefined
    let customLines: { account_number: string; debit_amount: number; credit_amount: number; line_description?: string }[] | undefined
    let force = false
    let paymentAccount: string | undefined
    let rawBody: unknown
    try {
      const text = await request.text()
      if (text) rawBody = JSON.parse(text)
    } catch {
      // Empty / invalid body: fall through to defaults.
    }

    if (rawBody) {
      const parsed = MarkInvoicePaidSchema.safeParse(rawBody)
      if (!parsed.success) {
        opLog.warn('mark-paid validation failed', {
          issueCount: parsed.error.issues.length,
        })
        return NextResponse.json(
          { error: 'Ogiltig förfrågan', details: parsed.error.flatten() },
          { status: 400 },
        )
      }
      exchangeRateDifference = parsed.data.exchange_rate_difference
      bodyPaymentDate = parsed.data.payment_date
      customLines = parsed.data.lines
      force = parsed.data.force === true
      paymentAccount = parsed.data.payment_account
    }

    // The Swedish calendar day, as on the v1 and agent doors: near midnight
    // the UTC date is still yesterday (possibly last month or a closed period).
    const paymentDate = bodyPaymentDate || todayIsoStockholm()

    // Before the duplicate guard: a document that cannot be paid hears that,
    // not a warning about a bank row (settleInvoicePayment asks again).
    const notPayable = await invoicePayableRefusal(supabase, companyId!, invoice, paymentDate)
    if (notPayable) {
      return errorResponseFromCode(notPayable.code, opLog, { requestId, details: notPayable.details })
    }

    // Duplicate-payment guard: surface a likely-matching unlinked inbound bank
    // transaction before booking. Skipped on partial payments (explicit,
    // deliberate action), on force=true, and on invoices without a resolved
    // customer name. Mirrors the supplier-side guard at
    // /api/supplier-invoices/[id]/mark-paid. The dialog always sends custom
    // lines, so the partial-payment skip is gated on total debit vs remaining,
    // not on the mere presence of customLines.
    const invForRemaining = invoice as Invoice & {
      remaining_amount?: number | null
      paid_amount?: number | null
    }
    const remainingAmount =
      invForRemaining.remaining_amount ?? invoice.total - (invForRemaining.paid_amount ?? 0)

    // Unit contract: total / paid_amount / remaining_amount are stored in the
    // INVOICE currency (total_sek carries the SEK view of total); custom lines
    // are journal lines, so they are always SEK. The SEK amount therefore has
    // to be converted before it is compared against, or subtracted from, the
    // invoice-currency remaining. The default path (no lines) already pays the
    // remaining in invoice currency and needs no rate at all.
    const isForeignCurrency = !!invoice.currency && invoice.currency !== 'SEK'
    const needsFxConversion = isForeignCurrency && customLines !== undefined
    const fxRate =
      invoice.exchange_rate && invoice.exchange_rate > 0 ? invoice.exchange_rate : null
    if (needsFxConversion && fxRate === null) {
      // Never fall back to rate 1: that reads an 11 496,70 kr payment against a
      // 1 000 EUR invoice as 11 496,70 EUR and corrupts the AR sub-ledger.
      // Same code as buildInvoicePaymentClearingLines' refusal
      // (MATCH_INVOICE_BOOKING_RATE_MISSING, lib/bookkeeping/invoice-payment-lines.ts):
      // one condition, one code across every invoice-settlement surface.
      opLog.warn('mark-paid rejected: foreign-currency invoice without exchange rate', {
        invoiceId: id,
        currency: invoice.currency,
      })
      return errorResponseFromCode('MATCH_INVOICE_BOOKING_RATE_MISSING', opLog, {
        requestId,
        details: { invoice_id: id, currency: invoice.currency },
      })
    }

    // Payment amount = customer settlement, not the gross debit sum: the
    // kontantmetoden ROT/RUT entry carries a second debit leg on 1513
    // (Skatteverket's share) while remaining_amount is stored net of the
    // deduction, so summing all debits would reject every such invoice with
    // MATCH_AMOUNT_EXCEEDS_REMAINING by exactly deduction_total (see
    // deriveCustomerSettlementAmount). deduction_total is invoice-currency;
    // the cap is converted to SEK to match the lines.
    //
    // Gated on the invoice NOT being booked yet: an invoice booked at send
    // already debited 1513 in its registration entry, so a 1513 debit in the
    // PAYMENT lines is always wrong there (it would double 1513 and, with
    // revenue credits, double 30xx/26xx). For those, the gross sum stays the
    // payment amount and the overpayment guard keeps rejecting the
    // wrong-shaped entry exactly as before.
    const invoiceAlreadyBooked = !!(invoice as { journal_entry_id?: string | null })
      .journal_entry_id
    const deductionTotal = invoiceAlreadyBooked
      ? 0
      : (invoice as { deduction_total?: number | null }).deduction_total ?? 0
    const deductionCapSek =
      deductionTotal > 0 && needsFxConversion
        ? sekOfForeign(deductionTotal, fxRate!)
        : deductionTotal
    const paymentAmount = customLines
      ? deriveCustomerSettlementAmount(customLines, deductionCapSek)
      : remainingAmount
    const paymentAmountInInvoiceCurrency = needsFxConversion
      ? paidOfClearedSek({
          sek: paymentAmount,
          remaining: remainingAmount,
          carried: await carriedSekOf(supabase, companyId!, 'customer', invoice),
          rate: fxRate!,
        })
      : paymentAmount

    const paidRounded = Math.round(paymentAmountInInvoiceCurrency * 100) / 100
    const remainingRounded = Math.round(remainingAmount * 100) / 100
    const guardApplies = paidRounded >= remainingRounded
    if (!force && guardApplies) {
      const customerName = (invoice as Invoice & { customer?: { name?: string } }).customer?.name
      if (!customerName) {
        opLog.warn('duplicate-payment guard skipped', {
          reason: 'missing_customer_name',
          invoiceId: id,
        })
      } else {
        // Invoice currency on purpose. The lookup scans transactions.amount,
        // which is denominated in the BANK ROW's currency, not necessarily
        // kronor; it therefore takes the payment in invoice currency plus the
        // invoice's stored conversion and bands each currency separately.
        // Handing it the raw SEK custom-line total would band a kronor figure
        // against a EUR column (and vice versa).
        const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
          companyId: companyId!,
          invoice: {
            invoice_number: invoice.invoice_number,
            customer_name: customerName,
            currency: invoice.currency ?? null,
            total: invoice.total ?? null,
            total_sek: invoice.total_sek ?? null,
            exchange_rate: invoice.exchange_rate ?? null,
          },
          paymentAmount: paymentAmountInInvoiceCurrency,
          paymentDate,
        })
        if (candidates.length > 0) {
          return errorResponseFromCode('INVOICE_PAID_LIKELY_DUPLICATE', opLog, {
            requestId,
            details: { candidates },
          })
        }
      }
    } else if (force) {
      opLog.warn('duplicate-payment guard bypassed', {
        reason: 'force=true',
        invoiceId: id,
        userId: user.id,
        paymentAmount,
      })
    }

    const settingsRead = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    // Fail closed (accounted#58): an unreadable method refuses, never books
    // a kontantmetod invoice's payment as a 1510 clearing.
    const accountingMethod = requireAccountingMethod(settingsRead)
    const entityType = await resolveCompanyEntityType(supabase, companyId, settingsRead.data?.entity_type)

    // paymentAmountInInvoiceCurrency was resolved above, before the
    // duplicate-payment guard, so the guard comparison and the ledger math run
    // in the same unit as remaining_amount.
    // The generated debit lands on the bank account the invoice asked to be
    // paid to (the primary bank account when none was chosen), or on the
    // account the caller says the money landed on (payment_account, crm#1823).
    // Custom lines carry their own.
    const settlementAccount = await resolveInvoicePaymentAccount(supabase, companyId!, invoice as Invoice, paymentAccount)
    if (!settlementAccount.ok) {
      return errorResponseFromCode(settlementAccount.code, opLog, { requestId, details: settlementAccount.details })
    }
    const settlementAccountNumber = settlementAccount.account
    const result = await settleInvoicePayment(supabase, companyId!, user.id, {
      invoice: invoice as Invoice & { customer?: { name?: string | null } | null },
      paymentAmountInInvoiceCurrency,
      paymentDate,
      accountingMethod,
      entityType,
      exchangeRateDifference,
      customLines,
      settlementAccountNumber,
      paymentSource: 'manual',
      // force on a partial overrides nothing: the guard never runs there.
      ...(force && guardApplies ? { duplicateGuardBypass: { user_id: user.id, actor_type: 'user' as const } } : {}),
    })

    if (!result.ok) {
      switch (result.code) {
        case 'SALE_FIRST_REFUSED':
          // The Bokför step's own code, details.sale_first: nothing was written.
          return sessionFailureResponse(result.refusal, opLog, requestId)
        case 'BOOKKEEPING_ERROR':
          return errorResponse(result.error, opLog, { requestId })
        case 'UPDATE_FAILED':
          opLog.error('failed to update invoice status', result.error as Error)
          return errorResponse(result.error, opLog, { requestId })
        case 'INVOICE_PAID_BOOK_FAILED':
          opLog.error('failed to create payment journal entry', undefined, {
            details: result.details,
          })
          return errorResponseFromCode(result.code, opLog, {
            requestId,
            details: result.details,
          })
        case 'INVOICE_PAID_RACE':
          return errorResponseFromCode(result.code, opLog, { requestId })
        default:
          return errorResponseFromCode(result.code, opLog, {
            requestId,
            details: result.details,
          })
      }
    }

    return NextResponse.json({
      success: true,
      status: result.newStatus,
      paid_at: result.paidAt,
      paid_amount: result.newPaidAmount,
      remaining_amount: result.newRemaining,
      journal_entry_id: result.journalEntryId,
      // The sale verifikat this payment booked first (defer_invoice_booking).
      ...(result.saleJournalEntryId ? { sale_journal_entry_id: result.saleJournalEntryId } : {}),
      ...(result.warnings.length > 0
        ? { warnings: result.warnings.map((w) => ({ code: w.code, message: w.message_sv })) }
        : {}),
    })
  },
  { requireWrite: true },
)
