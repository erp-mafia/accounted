import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { resolvePossibleDuplicate, SETTLEMENT_IGNORED_REASON_MAX } from '@/lib/collections/settlements'
import { loadSettlementDetail } from '@/lib/collections/settlements-view'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

const ParamsSchema = z.object({ id: z.uuid() })

const ResolveDuplicateBodySchema = z.discriminatedUnion('resolution', [
  z.object({ resolution: z.literal('not_duplicate') }),
  z.object({ resolution: z.literal('handled_elsewhere'), reason: z.string().trim().min(1).max(SETTLEMENT_IGNORED_REASON_MAX) }),
])

const REFUSALS = {
  not_found: 'COLLECTION_SETTLEMENT_NOT_FOUND',
  not_possible_duplicate: 'COLLECTION_SETTLEMENT_NOT_POSSIBLE_DUPLICATE',
  busy: 'COLLECTION_SETTLEMENT_BUSY',
  invalid_reason: 'VALIDATION_ERROR',
} as const

const BOOKING_REFUSALS = {
  not_found: 'COLLECTION_SETTLEMENT_NOT_FOUND',
  not_bookable: 'COLLECTION_SETTLEMENT_NOT_BOOKABLE',
  busy: 'COLLECTION_SETTLEMENT_BUSY',
  document_unavailable: 'COLLECTION_SETTLEMENT_DOCUMENT_PENDING',
} as const

/**
 * POST /api/collections/settlements/[id]/duplicate: a person's answer to a
 * payout held as a possible duplicate of a voucher booked by hand. Body
 * `{ resolution: 'not_duplicate' }` books the payout (and the guard does not
 * ask again); `{ resolution: 'handled_elsewhere', reason }` marks it ignored
 * with the reason, never booked. Both are written to the audit log with the
 * person. A booking that still needs a person answers 200 with outcome
 * needs_mapping. An obligation path: served whatever the start gates say.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'collections.settlements.duplicate',
  async (request, ctx, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const body = await validateBody(request, ResolveDuplicateBodySchema, { log: ctx.log, operation: 'collections.settlements.duplicate' })
    if (!body.success) return body.response

    const db = createServiceClient()
    const result = await resolvePossibleDuplicate({ db, log: ctx.log }, ctx.companyId, parsed.data.id, { userId: ctx.user.id }, body.data)
    if (!result.ok) return errorResponseFromCode(REFUSALS[result.outcome], ctx.log, { requestId: ctx.requestId })

    const settlement = await loadSettlementDetail(db, ctx.companyId, parsed.data.id)
    if (result.resolution === 'handled_elsewhere') {
      return NextResponse.json({ data: { outcome: 'ignored', settlement } })
    }
    const booking = result.booking
    if (!booking.ok && booking.outcome !== 'needs_mapping') {
      return errorResponseFromCode(BOOKING_REFUSALS[booking.outcome], ctx.log, { requestId: ctx.requestId })
    }
    return NextResponse.json({
      data: booking.ok
        ? { outcome: 'booked', journal_entry_id: booking.journalEntryId, acknowledged: booking.acknowledged, settlement }
        : { outcome: 'needs_mapping', reason: booking.reason, issues: booking.issues, settlement },
    })
  },
  { requireWrite: true },
)
