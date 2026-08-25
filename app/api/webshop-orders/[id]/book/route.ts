import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { validateBody } from '@/lib/api/validate'
import { BookWebshopOrderSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import {
  assertOrderBookable,
  bookOrderThroughEngine,
  resolveOrderFx,
} from '@/lib/webshop-orders/book-order'
import type { WebshopOrder } from '@/types'

ensureInitialized()

/**
 * Book one webshop order/refund row as a verifikat. The dialog sends the
 * (user-reviewed) lines built by lib/webshop-orders/booking-lines; the server
 * re-guards state and routes everything through the engine
 * (source_type 'webshop_order'). Period/company locks and balance are
 * enforced by the engine + DB triggers as usual.
 *
 * The flow itself (guards, FX retry, draft -> claim -> commit) lives in
 * lib/webshop-orders/book-order.ts, shared verbatim with the bulk endpoint
 * (POST /api/webshop-orders/bulk-book) so the two paths cannot drift.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'webshop_order.book',
  async (request, { supabase, user, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const validation = await validateBody(request, BookWebshopOrderSchema)
    if (!validation.success) return validation.response
    const { fiscal_period_id, entry_date, description, lines, voucher_series, notes } =
      validation.data

    const { data: order, error: fetchError } = await supabase
      .from('webshop_orders')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single<WebshopOrder>()

    if (fetchError || !order) {
      return errorResponseFromCode('WEBSHOP_ORDER_NOT_FOUND', log, { requestId })
    }

    const guardFailure = await assertOrderBookable(supabase, companyId, order)
    if (guardFailure) {
      return errorResponseFromCode(guardFailure.code, log, {
        requestId,
        ...(guardFailure.details ? { details: guardFailure.details } : {}),
      })
    }

    const resolvedOrder = await resolveOrderFx(supabase, companyId, order, log)
    if (!resolvedOrder) {
      return errorResponseFromCode('WEBSHOP_ORDER_FX_UNRESOLVED', log, {
        requestId,
        details: { currency: order.currency },
      })
    }

    const outcome = await bookOrderThroughEngine(
      supabase,
      companyId,
      user.id,
      id,
      { fiscal_period_id, entry_date, description, lines, voucher_series, notes },
      log,
    )

    if (!outcome.ok) {
      if (outcome.kind === 'claimed_elsewhere') {
        return errorResponseFromCode('WEBSHOP_ORDER_ALREADY_BOOKED', log, { requestId })
      }
      if (outcome.kind === 'claim_error') {
        return NextResponse.json(
          { error: getErrorMessage(outcome.error, { context: 'transaction' }) },
          { status: 500 },
        )
      }
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

    return NextResponse.json({
      data: outcome.journalEntry,
      journal_entry_id: outcome.journalEntryId,
      success: true,
    })
  },
  { requireWrite: true },
)
