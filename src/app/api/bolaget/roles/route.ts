import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { companyRolesCreate } from '@/lib/operations/bolaget'
import { sessionFailureResponse } from '@/lib/operations/session'
import { addCompanyRole, loadRoles } from '@/lib/bolaget/roles'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { rolesView } from '@/lib/bolaget/view'
import { readAsOf } from '../as-of'

/** GET /api/bolaget/roles?as_of=: roles over time and the firmateckning (operation company-roles.list). */
export const GET = withRouteContext('bolaget.roles', async (request, ctx) => {
  const gate = await bolagetGateResponse(ctx, 'registers')
  if (gate) return gate
  const asOf = readAsOf(request)
  if (asOf === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { field: 'as_of' } })
  const roles = await loadRoles(operationContext(ctx), asOf ?? null)
  return NextResponse.json({ data: rolesView(roles) })
})

/** POST /api/bolaget/roles: add a role from a date (operation company-roles.create). */
export const POST = withRouteContext(
  'bolaget.role_create',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx, 'registers')
    if (gate) return gate
    const validation = await validateBody(request, companyRolesCreate.input)
    if (!validation.success) return validation.response
    const input = validation.data
    const outcome = await addCompanyRole(
      operationContext(ctx),
      {
        party: { party_id: input.party_id ?? null, name: input.name ?? null, kind: input.kind ?? null, org_number: input.org_number ?? null },
        role: input.role as never,
        valid_from: input.valid_from,
        registered_at: input.registered_at ?? null,
        source: input.decision_id ? 'decision' : 'person',
        decision_id: input.decision_id ?? null,
      },
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireAdmin: true },
)
