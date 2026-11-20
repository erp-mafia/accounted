import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { Ink3InputsBodySchema } from '@/lib/reports/ink3/inputs'
import { getInk3UnderlagInputs, putInk3UnderlagInputs } from '@/lib/reports/ink3/inputs-service'

const QuerySchema = z.object({ period_id: z.string().uuid() })

/**
 * GET /api/reports/ink3/inputs?period_id=…
 *
 * What the company has entered for the räkenskapsår's INK3 underlag: the
 * allmännyttig statement, the per-account treatment and the ruta overrides.
 */
export const GET = withRouteContext('report.ink3.inputs.get', async (request, { supabase, companyId, user, log, requestId }) => {
  const query = validateQuery(request, QuerySchema)
  if (!query.success) return query.response
  const outcome = await getInk3UnderlagInputs(
    { supabase, companyId: companyId!, userId: user.id, log },
    query.data.period_id,
  )
  if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
  if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
  return NextResponse.json({ data: outcome.data })
})

/**
 * PUT /api/reports/ink3/inputs?period_id=…
 *
 * Replaces the räkenskapsår's inputs. Body: { allmannyttig, account_treatments,
 * field_overrides }. Dashboard-only in this step: v1 and MCP read the
 * underlag (session-route-parity: gap).
 */
export const PUT = withRouteContext(
  'report.ink3.inputs.put',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const query = validateQuery(request, QuerySchema)
    if (!query.success) return query.response
    const body = await validateBody(request, Ink3InputsBodySchema)
    if (!body.success) return body.response
    const outcome = await putInk3UnderlagInputs(
      { supabase, companyId: companyId!, userId: user.id, log },
      query.data.period_id,
      body.data,
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
