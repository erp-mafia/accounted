import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { proposeLossCarryforward } from '@/lib/bokslut/loss-carryforward/proposal'

const Query = z.object({ fiscal_period_id: z.string().uuid() })

/**
 * GET /api/bookkeeping/tax-loss-carryforwards/proposal?fiscal_period_id=:
 * what the app already knows about the year's deficit (the previous year in
 * the register, its INK2 underskott, its slutskattebesked) and the year's
 * result before the deduction. Nothing is written: the user confirms a
 * figure and saves it.
 */
export const GET = withRouteContext('bookkeeping.tax-loss-carryforwards.proposal', async (request, ctx) => {
  const query = validateQuery(request, Query, { log: ctx.log, operation: 'bookkeeping.tax-loss-carryforwards.proposal' })
  if (!query.success) return query.response
  const outcome = await proposeLossCarryforward(ctx, query.data.fiscal_period_id)
  if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})
