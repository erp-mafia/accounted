import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SetQuoteStatusSchema } from '@/lib/api/schemas'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * POST /api/invoices/[id]/quote-status
 *
 * Records the customer's decision on a quote (offert): open, accepted or
 * declined. Any transition between the three is allowed until the quote has
 * been converted to an invoice, after which the decision is locked. "expired"
 * is never written: it is derived from valid_until (lib/invoices/quote-status).
 *
 * Accepting a quote past valid_until is permitted here; the UI asks first.
 * A cancelled quote cannot be decided.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.quote_status',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, SetQuoteStatusSchema, {
      log,
      operation: 'invoice.quote_status',
    })
    if (!validation.success) return validation.response
    const nextStatus = validation.data.status
    const nextValidUntil = validation.data.valid_until

    const { data: quote, error: fetchError } = await supabase
      .from('invoices')
      .select('id, document_type, status, quote_status, quote_decided_at')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !quote) {
      return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    }
    if (quote.document_type !== 'quote') {
      return errorResponseFromCode('INVOICE_NOT_A_QUOTE', log, {
        requestId,
        details: { documentType: quote.document_type },
      })
    }
    if (quote.status === 'cancelled') {
      return errorResponseFromCode('INVOICE_QUOTE_NOT_DECIDABLE', log, { requestId })
    }

    const { data: converted, error: convertedError } = await supabase
      .from('invoices')
      .select('id, invoice_number')
      .eq('company_id', companyId)
      .eq('converted_from_id', id)
      .neq('status', 'cancelled')
      .limit(1)
      .maybeSingle()
    if (convertedError) {
      log.error('quote conversion lookup failed', convertedError, { quoteId: id })
      return errorResponse(convertedError, log, { requestId })
    }
    if (converted) {
      return errorResponseFromCode('INVOICE_QUOTE_ALREADY_INVOICED', log, {
        requestId,
        details: { invoiceId: converted.id, invoiceNumber: converted.invoice_number },
      })
    }

    // Compare-and-set on what was just read: a conversion (which writes
    // 'accepted') or a cancel that lands between the checks above and this
    // write turns it into a 0-row update instead of overwriting the newer
    // state. maybeSingle: 0 rows is the race, not a DB error.
    const { data: updated, error: updateError } = await supabase
      .from('invoices')
      .update({
        quote_status: nextStatus,
        // Re-sending the same decision keeps its original timestamp.
        quote_decided_at:
          nextStatus === 'open'
            ? null
            : nextStatus === quote.quote_status
              ? (quote.quote_decided_at ?? new Date().toISOString())
              : new Date().toISOString(),
        // undefined is dropped by supabase-js: only a supplied date moves.
        valid_until: nextValidUntil,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('quote_status', quote.quote_status)
      .neq('status', 'cancelled')
      .select('id, invoice_number, document_type, status, quote_status, quote_decided_at, valid_until')
      .maybeSingle()

    if (updateError) {
      // trg_invoices_quote_decision_guard: a conversion landed between the
      // read above and this write, so the decision is locked in accepted.
      if (updateError.message?.includes('INVOICE_QUOTE_ALREADY_INVOICED')) {
        return errorResponseFromCode('INVOICE_QUOTE_ALREADY_INVOICED', log, { requestId })
      }
      log.error('quote status update failed', updateError, { quoteId: id })
      return errorResponse(updateError, log, { requestId })
    }
    if (!updated) {
      return errorResponseFromCode('INVOICE_QUOTE_CHANGED_CONCURRENTLY', log, { requestId })
    }

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
