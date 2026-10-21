import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { BookWebshopOrderSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { bookWebshopOrder } from '@/lib/webshop-orders/book-order'

/**
 * Book one webshop order/refund row as a verifikat. The dialog sends the
 * (user-reviewed) lines built by lib/webshop-orders/booking-lines; the server
 * re-guards state and routes everything through the engine
 * (source_type 'webshop_order'). Period/company locks and balance are
 * enforced by the engine + DB triggers as usual.
 *
 * The flow itself (guards, FX retry, draft -> claim -> commit, orderunderlag
 * archiving) is bookWebshopOrder() in lib/webshop-orders/book-order.ts,
 * shared with the webshop-orders.book operation (v1 and MCP) and, step by
 * step, with the bulk endpoint (POST /api/webshop-orders/bulk-book), so the
 * paths cannot drift.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webshop_order.book',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, BookWebshopOrderSchema)
    if (!validation.success) return validation.response
    const { fiscal_period_id, entry_date, description, lines, voucher_series, notes } =
      validation.data

    const outcome = await bookWebshopOrder(
      supabase,
      companyId,
      user.id,
      id,
      { fiscal_period_id, entry_date, description, lines, voucher_series, notes },
      log,
    )

    if (!outcome.ok) {
      switch (outcome.kind) {
        case 'not_found':
          return errorResponseFromCode('WEBSHOP_ORDER_NOT_FOUND', log, { requestId })
        case 'not_bookable':
          return errorResponseFromCode(outcome.failure.code, log, {
            requestId,
            ...(outcome.failure.details ? { details: outcome.failure.details } : {}),
          })
        case 'fx_unresolved':
          return errorResponseFromCode('WEBSHOP_ORDER_FX_UNRESOLVED', log, {
            requestId,
            details: { currency: outcome.currency },
          })
        case 'claimed_elsewhere':
          return errorResponseFromCode('WEBSHOP_ORDER_ALREADY_BOOKED', log, { requestId })
        case 'claim_error':
          return NextResponse.json(
            { error: getErrorMessage(outcome.error, { context: 'transaction' }) },
            { status: 500 },
          )
        case 'engine_error': {
          const typed = bookkeepingErrorResponse(outcome.error)
          if (typed) return typed
          log.error(
            outcome.stage === 'draft'
              ? 'failed to draft journal entry for webshop order'
              : 'failed to commit journal entry for webshop order',
            outcome.error as Error,
          )
          return NextResponse.json(
            { error: getErrorMessage(outcome.error, { context: 'transaction' }) },
            { status: 400 },
          )
        }
      }
    }

    return NextResponse.json({
      data: outcome.journalEntry,
      journal_entry_id: outcome.journalEntryId,
      underlag_archived: outcome.underlagArchived,
      success: true,
    })
  },
  { requireWrite: true },
)
