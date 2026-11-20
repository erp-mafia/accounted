import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { isCompanyAdmin } from '@/lib/auth/require-write'
import {
  BookingReviewRuleInputSchema,
  createBookingReviewRule,
  listBookingReviewRules,
} from '@/lib/booking-review/rules'
import { bookingReviewRuleRefusalResponse } from '@/lib/booking-review/respond'

/**
 * GET /api/rules/blocks
 * The company's hard blocks (booking_review_rules, accounted#130): every
 * version, active and archived, newest first, and whether the caller may
 * add or archive one (owner or admin). Feeds the Spärrar section of /rules.
 */
export const GET = withRouteContext('rule.blocks.list', async (_request, { supabase, companyId }) => {
  const [data, canManage] = await Promise.all([
    listBookingReviewRules(supabase, companyId),
    isCompanyAdmin(supabase, companyId),
  ])
  return NextResponse.json({ data, can_manage: canManage })
})

/**
 * POST /api/rules/blocks
 * Add a hard block: a booking it matches is never booked with one click, in
 * bulk, by a rule for automatic booking or by an agent; a person books it
 * from its review. Owner or admin. save_booking_review_rule dates the rule
 * and logs it to audit_log for behandlingshistorik.
 * Body: { accounts?, counterparty?, amount_from_sek?, vat_treatment?, note? },
 * at least one of the first four.
 */
export const POST = withRouteContext(
  'rule.blocks.create',
  async (request, { supabase, companyId, log, requestId }) => {
    const parsed = await validateBody(request, BookingReviewRuleInputSchema)
    if (!parsed.success) return parsed.response
    try {
      const created = await createBookingReviewRule(supabase, companyId, parsed.data)
      return NextResponse.json({ data: created }, { status: 201 })
    } catch (error) {
      const refused = bookingReviewRuleRefusalResponse(error, log, requestId)
      if (refused) return refused
      throw error
    }
  },
  { requireAdmin: true },
)
