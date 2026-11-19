import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { createOwnerLoan } from '@/lib/bolaget/owner-tax/loans'
import { OwnerLoanCreateBody } from '@/lib/bolaget/owner-tax/schemas'

/**
 * POST /api/bolaget/owner-tax/loans: register a loan between the company
 * and an owner, board member, VD or related person, or security for one
 * (?dry_run=true previews). The same rules as operation owner-loans.create:
 * the låneförbud check warns, never refuses; nothing is booked.
 */
export const POST = withRouteContext(
  'bolaget.owner_loan_create',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, OwnerLoanCreateBody)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const body = validation.data
    const outcome = await createOwnerLoan(
      operationContext(ctx),
      { ...body, party: { party_id: body.party_id ?? null, name: body.party_name ?? null, kind: body.party_kind ?? null, org_number: body.party_org_number ?? null } },
      { dryRun },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] }, { status: 201 })
  },
  { requireWrite: true },
)
