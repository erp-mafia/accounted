import { NextResponse } from 'next/server'
import { MarkInvoicePaidSchema } from '@/lib/api/schemas'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { deriveCustomerSettlementAmount } from '@/lib/invoices/apply-invoice-payment'
import { findDuplicatePaymentCandidatesForInvoice } from '@/lib/invoices/duplicate-payment-candidates'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { roundOre } from '@/lib/money'
import type { EntityType, Invoice } from '@/types'

ensureInitialized()

/**
 * POST /api/invoices/[id]/mark-paid
 *
 * Manually marks an invoice as paid (for payments received outside bank sync).
 *
 * Faktureringsmetoden (accrual): Debit 1930, Credit 1510 (clearing entry)
 * Kontantmetoden (cash):         Debit 1930, Credit 30xx, Credit 26xx
 *
 * The booking + status transition live in settleInvoicePayment (shared with
 * the Stripe payment sync); this route owns request parsing, the payable
 * guard, and the duplicate-payment advisory.
 */
export const POST = withRouteContext(
  'invoice.mark_paid',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ invoiceId: id })

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('*, customer:customers(*), items:invoice_items(*), credit_notes:invoices!credited_invoice_id(id, status, creation_complete)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_PAID_NOT_FOUND', opLog, { requestId })
    }

    if (invoice.credited_invoice_id) {
      return errorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { reason: 'credit_note' },
      })
    }

    const activeCreditNotes = ((invoice as { credit_notes?: Array<{
      status: string
      creation_complete?: boolean
    }> }).credit_notes ?? []).filter(
      (creditNote) => creditNote.status !== 'cancelled' && creditNote.creation_complete !== false,
    )
    if (activeCreditNotes.length > 0) {
      return errorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { reason: 'active_credit_note' },
      })
    }

    // partially_paid is payable (#1717): an invoice stuck with a sub-krona
    // remaining (öresavrundning) or an ordinary open partial is completed
    // here. settleInvoicePayment's plan math and CAS guard already handle
    // the state; only this route-level gate excluded it.
    // A quote is an offer, not a claim: nothing is owed until it has been
    // converted to a faktura.
    if (invoice.document_type === 'quote') {
      return errorResponseFromCode('INVOICE_QUOTE_NOT_PAYABLE', opLog, { requestId })
    }

    if (
      invoice.status !== 'sent' &&
      invoice.status !== 'overdue' &&
      invoice.status !== 'partially_paid'
    ) {
      return errorResponseFromCode('INVOICE_PAID_NOT_PAYABLE', opLog, {
        requestId,
        details: { currentStatus: invoice.status },
      })
    }

    // Optional body. Backwards-compat: callers may POST with no body.
    let exchangeRateDifference: number | undefined
    let bodyPaymentDate: string | undefined
    let customLines: { account_number: string; debit_amount: number; credit_amount: number; line_description?: string }[] | undefined
    let force = false
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
    }

    const now = new Date().toISOString()
    const paymentDate = bodyPaymentDate || now.split('T')[0]

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
        ? roundOre(deductionTotal * fxRate!)
        : deductionTotal
    const paymentAmount = customLines
      ? deriveCustomerSettlementAmount(customLines, deductionCapSek)
      : remainingAmount
    const paymentAmountInInvoiceCurrency = needsFxConversion
      ? roundOre(paymentAmount / fxRate!)
      : paymentAmount

    const paidRounded = Math.round(paymentAmountInInvoiceCurrency * 100) / 100
    const remainingRounded = Math.round(remainingAmount * 100) / 100
    if (!force && paidRounded >= remainingRounded) {
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

    const { data: settings } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .single()

    const accountingMethod = settings?.accounting_method || 'accrual'
    const entityType = (settings?.entity_type as EntityType) || 'enskild_firma'

    // paymentAmountInInvoiceCurrency was resolved above, before the
    // duplicate-payment guard, so the guard comparison and the ledger math run
    // in the same unit as remaining_amount.
    const result = await settleInvoicePayment(supabase, companyId!, user.id, {
      invoice: invoice as Invoice & { customer?: { name?: string | null } | null },
      paymentAmountInInvoiceCurrency,
      paymentDate,
      accountingMethod,
      entityType,
      exchangeRateDifference,
      customLines,
    })

    if (!result.ok) {
      switch (result.code) {
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
    })
  },
  { requireWrite: true },
)
