import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { listLossCarryforwards, saveLossCarryforward } from '@/lib/bokslut/loss-carryforward/register'
import { SaveLossCarryforwardSchema } from '@/lib/bokslut/loss-carryforward/schemas'

/**
 * GET /api/bookkeeping/tax-loss-carryforwards: the underskottsregister (IL 40
 * kap.), every fiscal year oldest first, each checked against the year
 * before it. Behind BOLAGET_COMPANY_IDS, for companies that file INK2.
 */
export const GET = withRouteContext('bookkeeping.tax-loss-carryforwards.list', async (_request, ctx) => {
  const outcome = await listLossCarryforwards(ctx)
  if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})

/**
 * POST /api/bookkeeping/tax-loss-carryforwards: save one fiscal year (insert
 * or replace by fiscal_period_id), its spärrar and carried-forward deficit
 * computed. ?dry_run=true answers what would be stored and writes nothing.
 */
export const POST = withRouteContext(
  'bookkeeping.tax-loss-carryforwards.save',
  async (request, ctx) => {
    const body = await validateBody(request, SaveLossCarryforwardSchema, {
      log: ctx.log,
      operation: 'bookkeeping.tax-loss-carryforwards.save',
    })
    if (!body.success) return body.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await saveLossCarryforward(
      { supabase: ctx.supabase, companyId: ctx.companyId, userId: ctx.user.id, log: ctx.log },
      body.data,
      { dryRun },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: outcome.created ? 201 : 200 })
  },
  { requireWrite: true },
)
