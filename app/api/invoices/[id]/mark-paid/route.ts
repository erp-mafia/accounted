import { NextResponse } from 'next/server'
import { MarkInvoicePaidSchema } from '@/lib/api/schemas'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
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
      .select('*, customer:customers(*), items:invoice_items(*)')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_PAID_NOT_FOUND', opLog, { requestId })
    }

    if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
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
    const paymentAmount = customLines
      ? customLines.reduce((s, l) => s + l.debit_amount, 0)
      : remainingAmount
    const paidRounded = Math.round(paymentAmount * 100) / 100
    const remainingRounded = Math.round(remainingAmount * 100) / 100
    if (!force && paidRounded >= remainingRounded) {
      const customerName = (invoice as Invoice & { customer?: { name?: string } }).customer?.name
      if (!customerName) {
        opLog.warn('duplicate-payment guard skipped', {
          reason: 'missing_customer_name',
          invoiceId: id,
        })
      } else {
        const candidates = await findDuplicatePaymentCandidatesForInvoice(supabase, {
          companyId: companyId!,
          invoice: { invoice_number: invoice.invoice_number, customer_name: customerName },
          paymentAmount,
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

    // paymentAmount and the duplicate-payment guard above operate in the
    // booking currency (SEK for custom lines); convert to invoice currency for
    // the ledger comparison so a foreign-currency invoice isn't falsely
    // rejected as overpaid.
    const fxRate =
      invoice.currency && invoice.currency !== 'SEK' && invoice.exchange_rate
        ? invoice.exchange_rate
        : 1
    const paymentAmountInInvoiceCurrency = customLines
      ? roundOre(paymentAmount / fxRate)
      : paymentAmount

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
