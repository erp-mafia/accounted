import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { OpeningBalanceSplitApplySchema, OpeningBalanceSplitQuerySchema } from '@/lib/api/schemas'
import {
  previewOpeningBalanceSplit,
  splitOpeningBalancesPerProject,
} from '@/lib/import/opening-balance/split-per-project'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * "Dela upp IB per projekt" (#3313) on the dashboard.
 *
 * GET  ?fiscal_period_id=: the preview (current vs proposed lines per
 *      account, and what blocks the apply). Writes nothing.
 * POST { fiscal_period_id, expected_fingerprint }: apply it as an inline
 *      rättelse of the year's IB verifikat. The fingerprint pins the split
 *      the user reviewed.
 *
 * The rules live in lib/import/opening-balance/split-per-project.ts, shared
 * with the v1 operations and the staged MCP tool
 * (opening-balances.split-per-project). Nothing here emits events: the
 * rättelse is the RPC's journal_entry_rattelse_log row.
 */
export const GET = withRouteContext('opening_balance.split_preview', async (request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  const query = validateQuery(request, OpeningBalanceSplitQuerySchema, { log, operation: 'opening_balance.split_preview' })
  if (!query.success) return query.response

  const outcome = await previewOpeningBalanceSplit(
    { supabase, companyId: companyId!, userId: user.id, log: log.child({ fiscalPeriodId: query.data.fiscal_period_id }) },
    { fiscal_period_id: query.data.fiscal_period_id },
  )
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) throw new Error('unreachable: the preview is a read')
  return NextResponse.json({ data: outcome.data })
})

export const POST = withRouteContext(
  'opening_balance.split_per_project',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const body = await validateBody(request, OpeningBalanceSplitApplySchema, {
      log,
      operation: 'opening_balance.split_per_project',
    })
    if (!body.success) return body.response

    const opLog = log.child({ fiscalPeriodId: body.data.fiscal_period_id })
    const outcome = await splitOpeningBalancesPerProject(
      { supabase, companyId: companyId!, userId: user.id, log: opLog },
      { fiscal_period_id: body.data.fiscal_period_id, expected_fingerprint: body.data.expected_fingerprint },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
