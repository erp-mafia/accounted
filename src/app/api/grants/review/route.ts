import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { markGrantPostingsReviewed } from '@/lib/grants/actions'

const ReviewBodySchema = z.object({
  use_ids: z.array(z.string().uuid()).min(1).max(500),
})

/**
 * POST /api/grants/review
 *
 * Mark postings a rule for automatic booking let through as reviewed: they
 * leave Att göra's "Bokfört enligt regel" and the agent briefing's list.
 * mark_company_grant_uses_reviewed checks that the caller writes in the
 * company.
 */
export const POST = withRouteContext(
  'grant.review',
  async (request, { supabase, companyId, log, requestId }) => {
    const validation = await validateBody(request, ReviewBodySchema)
    if (!validation.success) return validation.response

    const outcome = await markGrantPostingsReviewed(supabase, companyId, validation.data.use_ids)
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId })
    return NextResponse.json({ data: { reviewed: outcome.reviewed } })
  },
  { requireWrite: true },
)
