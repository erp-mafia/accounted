import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { setLoanInterest } from '@/lib/bolaget/owner-tax/loans'
import { LoanInterestBody } from '@/lib/bolaget/owner-tax/schemas'
import { isUuid } from '@/lib/invariants/uuid'

/**
 * POST /api/bolaget/owner-tax/loans/{id}/interest: the interest on an owner
 * loan for an inkomstår and the tax withheld (KU20 fields 503 and 001;
 * ?dry_run=true previews). The same rules as operation owner-loans.set-interest.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bolaget.owner_loan_interest_set',
  async (request, ctx, { params }) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const { id } = await params
    if (!isUuid(id)) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const validation = await validateBody(request, LoanInterestBody)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await setLoanInterest(operationContext(ctx), { ...validation.data, owner_loan_id: id }, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] })
  },
  { requireWrite: true },
)
