import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { loadBeneficialOwnerView } from '@/lib/bolaget/beneficial-owners'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { readAsOf } from '../as-of'

/** GET /api/bolaget/beneficial-owners?as_of=: the proposal, the confirmed set and the assessments (operation beneficial-owners.get). */
export const GET = withRouteContext('bolaget.beneficial_owners', async (request, ctx) => {
  const gate = await bolagetGateResponse(ctx, 'registers')
  if (gate) return gate
  const asOf = readAsOf(request)
  if (asOf === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { field: 'as_of' } })
  const view = await loadBeneficialOwnerView(operationContext(ctx), asOf ?? null)
  return NextResponse.json({ data: view })
})
