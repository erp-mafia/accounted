import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { InboxItemBookingPlanQuerySchema } from '@/lib/api/schemas'
import { readInkorgBookingPlan } from '@/lib/operations/inkorg-book'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * GET /api/inkorg/items/:id/booking-plan
 *
 * What the Inkorg's one click books for an inbox item waiting for its first
 * decision (lib/operations/inkorg-one-click.ts): the form (one verifikat
 * against the bank row, register, or register and settle), the date, the
 * lines, the VAT and the supplier, or what to ask instead (ask: category,
 * seller_country or editor). "Så bokförs den" shows its lines, and the
 * page's primary answer sends its preview_token back to
 * POST /api/inkorg/items/:id/book.
 *
 * Query: purchase_category and seller_country, what the person answered on
 * the page; never stored. Read only. 404 for an item that is not the
 * company's, 409 for one already booked or registered.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'inkorg.booking_plan',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = validateQuery(request, InboxItemBookingPlanQuerySchema, { log, operation: 'inkorg.booking_plan' })
    if (!validation.success) return validation.response

    const outcome = await readInkorgBookingPlan({ supabase, companyId, userId: user.id, log }, id, validation.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
)
