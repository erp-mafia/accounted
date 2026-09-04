/**
 * POST /api/v1/companies/{companyId}/invoices/{id}/quote-status
 *
 * Records the customer's decision on a quote (offert): open, accepted or
 * declined. Mirrors the dashboard route (app/api/invoices/[id]/quote-status):
 * any transition between the three decisions is allowed until the quote has
 * been converted to an invoice, after which the decision is locked.
 * "expired" is never written: it is derived from valid_until
 * (lib/invoices/quote-status) and reported as effective_quote_status.
 *
 * Accepting a quote past valid_until is permitted; a cancelled quote cannot
 * be decided. No journal entry, no number allocation, no event: a quote is
 * an offer, not a claim (it books nothing until converted).
 *
 * Idempotent (mandatory Idempotency-Key) and dry-runnable.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { SetQuoteStatusSchema } from '@/lib/api/schemas'
import { effectiveQuoteStatus } from '@/lib/invoices/quote-status'



const QuoteStatusResponse = z.object({
  id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  document_type: z.literal('quote'),
  status: z.string(),
  quote_status: z.enum(['open', 'accepted', 'declined']),
  // The reported state: the stored decision, or 'expired' for an open quote
  // whose valid_until has passed.
  effective_quote_status: z.enum(['open', 'accepted', 'declined', 'expired']),
  quote_decided_at: z.string().nullable(),
  valid_until: z.string().nullable(),
})

registerEndpoint({
  operation: 'invoices.quote-status',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices/:id/quote-status',
  summary: 'Record the customer decision on a quote (offert).',
  description:
    'Sets quote_status on a quote (document_type=quote) to open, accepted or declined. Any transition between the three is allowed until the quote has been converted to an invoice; after that the decision is locked (409 INVOICE_QUOTE_ALREADY_INVOICED). "expired" is never written: it is derived from valid_until and reported as effective_quote_status. Accepting a quote past valid_until is allowed (pass valid_until here to extend an expired quote so it reads as open again). No journal entry, number allocation or event is involved. Idempotent and dry-runnable.',
  useWhen:
    'The customer answered a quote and you want Accounted to reflect it (accepted / declined), or you want to reopen a decision that was recorded by mistake.',
  doNotUseFor:
    'Creating the invoice from an accepted quote (convert it in the dashboard; the conversion marks the quote accepted itself). Regular invoices, proformas or delivery notes: they return 400 INVOICE_NOT_A_QUOTE.',
  pitfalls: [
    'Only document_type=quote rows are decidable; anything else returns 400 INVOICE_NOT_A_QUOTE.',
    'A cancelled quote returns 400 INVOICE_QUOTE_NOT_DECIDABLE.',
    'Once an active invoice exists with converted_from_id = this quote, the decision is locked: 409 INVOICE_QUOTE_ALREADY_INVOICED. Cancelling that invoice frees the quote again.',
    'Setting status=open clears quote_decided_at; accepted/declined stamp it with the request time.',
    'Idempotency-Key is mandatory. A retried call with the same key replays the cached response.',
  ],
  example: {
    request: { status: 'accepted' },
    response: {
      data: {
        id: '0e9c…',
        invoice_number: 'OF-007',
        document_type: 'quote',
        status: 'sent',
        quote_status: 'accepted',
        effective_quote_status: 'accepted',
        quote_decided_at: '2026-09-02T09:14:33Z',
        valid_until: '2026-09-30',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: SetQuoteStatusSchema },
  response: { success: dataEnvelope(QuoteStatusResponse) },
})

type QuoteRow = {
  id: string
  invoice_number: string | null
  document_type: string
  status: string
  quote_status: string | null
  quote_decided_at: string | null
  valid_until: string | null
}

function toResponse(row: QuoteRow) {
  return {
    ...row,
    effective_quote_status: effectiveQuoteStatus(row) ?? row.quote_status,
  }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'invoices.quote-status',
  async (request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }
    const quoteId = idParse.data

    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    const raw = await readV1JsonBody(request, ctx)
    if (!raw.ok) return raw.response
    const parsed = SetQuoteStatusSchema.safeParse(raw.body)
    if (!parsed.success) {
      return v1ValidationError(ctx, parsed.error)
    }
    const nextStatus = parsed.data.status

    const { data: quote, error: fetchError } = await ctx.supabase
      .from('invoices')
      .select('id, invoice_number, document_type, status, quote_status, quote_decided_at, valid_until')
      .eq('company_id', ctx.companyId!)
      .eq('id', quoteId)
      .maybeSingle()

    if (fetchError) {
      return v1ErrorResponse(fetchError, ctx.log, { requestId: ctx.requestId })
    }
    if (!quote) {
      ctx.log.warn('invoices.quote-status: not found', { quoteId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'invoice' },
      })
    }

    const typed = quote as unknown as QuoteRow
    if (typed.document_type !== 'quote') {
      return v1ErrorResponseFromCode('INVOICE_NOT_A_QUOTE', ctx.log, {
        requestId: ctx.requestId,
        details: { document_type: typed.document_type },
      })
    }
    if (typed.status === 'cancelled') {
      return v1ErrorResponseFromCode('INVOICE_QUOTE_NOT_DECIDABLE', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // One active invoice per quote locks the decision; a cancelled converted
    // invoice frees the quote again (same predicate as the converter).
    const { data: converted, error: convertedError } = await ctx.supabase
      .from('invoices')
      .select('id, invoice_number')
      .eq('company_id', ctx.companyId!)
      .eq('converted_from_id', quoteId)
      .neq('status', 'cancelled')
      .limit(1)
      .maybeSingle()
    if (convertedError) {
      return v1ErrorResponse(convertedError, ctx.log, { requestId: ctx.requestId })
    }
    if (converted) {
      const conv = converted as { id: string; invoice_number: string | null }
      return v1ErrorResponseFromCode('INVOICE_QUOTE_ALREADY_INVOICED', ctx.log, {
        requestId: ctx.requestId,
        details: { invoice_id: conv.id, invoice_number: conv.invoice_number },
      })
    }

    // Re-sending the same decision keeps its original timestamp (idempotent).
    const decidedAt =
      nextStatus === 'open'
        ? null
        : nextStatus === typed.quote_status
          ? (typed.quote_decided_at ?? new Date().toISOString())
          : new Date().toISOString()

    if (ctx.dryRun) {
      return dryRunPreview(
        toResponse({
          ...typed,
          quote_status: nextStatus,
          quote_decided_at: decidedAt,
          valid_until: parsed.data.valid_until ?? typed.valid_until,
        }),
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data: updated, error: updateError } = await ctx.supabase
      .from('invoices')
      .update({
        quote_status: nextStatus,
        quote_decided_at: decidedAt,
        // undefined is dropped by supabase-js: only a supplied date moves.
        valid_until: parsed.data.valid_until,
        updated_at: new Date().toISOString(),
      })
      .eq('company_id', ctx.companyId!)
      .eq('id', quoteId)
      // Compare-and-set: a conversion or cancel that lands after the checks
      // above makes this a 0-row update instead of overwriting newer state.
      .eq('quote_status', typed.quote_status)
      .neq('status', 'cancelled')
      .select('id, invoice_number, document_type, status, quote_status, quote_decided_at, valid_until')
      .maybeSingle()

    if (updateError) {
      // trg_invoices_quote_decision_guard: a conversion landed between the
      // read above and this write, so the decision is locked in accepted.
      if ((updateError as { message?: string }).message?.includes('INVOICE_QUOTE_ALREADY_INVOICED')) {
        return v1ErrorResponseFromCode('INVOICE_QUOTE_ALREADY_INVOICED', ctx.log, {
          requestId: ctx.requestId,
        })
      }
      ctx.log.error('invoices.quote-status: update failed', updateError as Error, {
        quoteId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponse(updateError, ctx.log, { requestId: ctx.requestId })
    }
    if (!updated) {
      ctx.log.warn('invoices.quote-status: quote changed between read and update', {
        quoteId,
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('INVOICE_QUOTE_CHANGED_CONCURRENTLY', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    ctx.log.info('invoices.quote-status success', {
      quoteId,
      companyId: ctx.companyId,
      userId: ctx.userId,
      quoteStatus: nextStatus,
    })

    return ok(toResponse(updated as unknown as QuoteRow), { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
