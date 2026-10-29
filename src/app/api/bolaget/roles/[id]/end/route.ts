import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CompanyRoleEndIn } from '@/lib/operations/bolaget'
import { sessionFailureResponse } from '@/lib/operations/session'
import { endCompanyRole } from '@/lib/bolaget/roles'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'

const EndSchema = CompanyRoleEndIn.omit({ company_role_id: true })

/** POST /api/bolaget/roles/{id}/end: end a role on its last day (operation company-roles.end). */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bolaget.role_end',
  async (request, ctx, { params }) => {
    const { id } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, EndSchema)
    if (!validation.success) return validation.response
    const { end_reason, ...end } = validation.data
    const outcome = await endCompanyRole(operationContext(ctx), { company_role_id: id, ...end, reason: end_reason }, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
