import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { acknowledgeOpeningBalanceReview } from '@/lib/import/opening-balance/review'
import { sessionFailureResponse } from '@/lib/operations/session'

const ReviewSchema = z.object({ reviewToken: z.uuid(), expectedEntryId: z.uuid().nullable() }).strict()
type Params = { params: Promise<{ id: string }> }

/**
 * The review dialog's confirmation. An agent's staged proposal
 * (gnubok_acknowledge_opening_balance_review) runs the same service once a
 * person approves it.
 */
export const POST = withRouteContext<Params>('period.opening_balance.review', async (request, ctx, { params }) => {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'Ogiltigt räkenskapsår.' }, { status: 400 })
  const validation = await validateBody(request, ReviewSchema)
  if (!validation.success) return validation.response
  const outcome = await acknowledgeOpeningBalanceReview(
    { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.user.id, log: ctx.log },
    {
      fiscal_period_id: id,
      review_token: validation.data.reviewToken,
      opening_balance_entry_id: validation.data.expectedEntryId,
    },
    { dryRun: false },
  )
  if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
  return NextResponse.json({ data: { reviewed: true } })
}, { requireWrite: true })
