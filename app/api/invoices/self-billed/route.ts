import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { CreateSelfBillingInvoiceSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  createSelfBilledSaleInvoice,
  type SelfBilledSaleInput,
  type SelfBilledSaleFailure,
} from '@/lib/invoices/self-billed-sale'
import type { Logger } from '@/lib/logger'

ensureInitialized()

/**
 * POST /api/invoices/self-billed
 *
 * Register a self-billing invoice we RECEIVED (mottagen självfaktura, ML 17 kap
 * 15§). The customer issued the invoice on our behalf; for us it is a sale, so
 * it books exactly like a customer invoice (Debit 1510, Credit 30xx + 26xx) and
 * the output VAT lands in our momsdeklaration.
 *
 * It differs from a normal customer invoice in two ways:
 *   - We do NOT assign a number from our own series: the counterparty's number
 *     is stored in external_invoice_number and our invoice_number stays null
 *     (BFL 5 kap 6§). Enforced by the invoices_self_billed_numbering constraint.
 *   - There is no send step. Under faktureringsmetoden (accrual) we book the
 *     registration entry here. Under kontantmetoden (cash) we leave it unbooked
 *     until payment and the existing mark-paid flow books the cash entry then.
 *
 * The booking logic lives in lib/invoices/self-billed-sale.ts, shared with the
 * public v1 invoice-create endpoint (POST /api/v1/.../invoices with
 * is_self_billed=true), so the dashboard and the API can never drift.
 */
function mapSelfBilledFailure(failure: SelfBilledSaleFailure, log: Logger, requestId?: string) {
  switch (failure.code) {
    case 'customer_not_found':
      return errorResponseFromCode('INVOICE_CUSTOMER_NOT_FOUND', log, {
        requestId,
        details: { customerId: failure.customerId },
      })
    case 'vat_rule_violation':
      return errorResponseFromCode('INVOICE_CREATE_VAT_RULE_VIOLATION', log, {
        requestId,
        details: {
          attemptedRate: failure.attemptedRate,
          allowedRates: failure.allowedRates,
          customerType: failure.customerType,
        },
      })
    case 'fx_rate_unavailable':
      return NextResponse.json(
        {
          error: `Kunde inte hämta växelkurs för ${failure.currency} på fakturadatumet (${failure.invoiceDate}). Försök igen senare.`,
          type: 'validation_error',
        },
        { status: 400 },
      )
    case 'no_fiscal_period':
      return NextResponse.json(
        { error: 'Ingen öppen bokföringsperiod för fakturadatumet', type: 'validation_error' },
        { status: 400 },
      )
    case 'insert_failed':
      return errorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', log, {
        requestId,
        details: { stage: failure.stage, pgCode: failure.pgCode, pgMessage: failure.pgMessage },
      })
    case 'items_failed':
      return errorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', log, {
        requestId,
        details: { pgCode: failure.pgCode, pgMessage: failure.pgMessage },
      })
  }
}

export const POST = withRouteContext(
  'invoice.self_billed.create',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body', type: 'validation_error' },
        { status: 400 },
      )
    }

    const parsed = CreateSelfBillingInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) {
      log.warn('self-billed invoice validation failed', { issueCount: parsed.error.issues.length })
      return NextResponse.json(
        {
          error: 'Validation failed',
          type: 'validation_error',
          errors: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message, code: i.code })),
        },
        { status: 400 },
      )
    }
    const input = parsed.data

    const selfBilledInput: SelfBilledSaleInput = {
      customer_id: input.customer_id,
      external_invoice_number: input.external_invoice_number,
      self_billing_agreement_ref: input.self_billing_agreement_ref ?? null,
      invoice_date: input.invoice_date,
      received_date: input.received_date,
      due_date: input.due_date,
      currency: input.currency,
      notes: input.notes ?? null,
      items: input.items.map((it) => ({
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        unit_price: it.unit_price,
        vat_rate: it.vat_rate,
      })),
    }

    try {
      const result = await createSelfBilledSaleInvoice(supabase, companyId!, user.id, selfBilledInput)
      if (!result.ok) return mapSelfBilledFailure(result.failure, log, requestId)
      return NextResponse.json({ data: result.invoice })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
