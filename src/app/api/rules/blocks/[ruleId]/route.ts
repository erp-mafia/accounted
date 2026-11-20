import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { UUID_RE } from '@/lib/invariants/uuid'
import { archiveBookingReviewRule } from '@/lib/booking-review/rules'
import { bookingReviewRuleRefusalResponse } from '@/lib/booking-review/respond'

type Params = { params: Promise<{ ruleId: string }> }

/**
 * DELETE /api/rules/blocks/[ruleId]
 * Archive a hard block (archive_booking_review_rule): it stops matching now
 * and its dated history stays in /rules and behandlingshistorik. A rule is
 * never deleted. Owner or admin.
 */
export const DELETE = withRouteContext<Params>(
  'rule.blocks.archive',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { ruleId } = await params
    if (!UUID_RE.test(ruleId)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        messageSv: 'Ogiltigt id för spärren.',
        messageEn: 'Invalid block id.',
        details: { field: 'ruleId' },
      })
    }
    try {
      const archived = await archiveBookingReviewRule(supabase, companyId, ruleId)
      return NextResponse.json({ data: archived })
    } catch (error) {
      const refused = bookingReviewRuleRefusalResponse(error, log, requestId)
      if (refused) return refused
      throw error
    }
  },
  { requireAdmin: true },
)
