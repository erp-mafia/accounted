import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { shareholderContributionsCreate } from '@/lib/operations/bolaget-capital'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { createShareholderContribution } from '@/lib/bolaget/capital/contributions'

/**
 * POST /api/bolaget/capital/contributions: register and book an
 * aktieägartillskott or the repayment of a villkorat one (?dry_run=true
 * previews). The same rules as operation shareholder-contributions.create.
 */
export const POST = withRouteContext(
  'bolaget.contribution_create',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, shareholderContributionsCreate.input)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const { party_id, holder_name, holder_kind, holder_org_number, ...rest } = validation.data
    const outcome = await createShareholderContribution(
      operationContext(ctx),
      { ...rest, holder: { party_id: party_id ?? null, name: holder_name ?? null, kind: holder_kind ?? null, org_number: holder_org_number ?? null } },
      { dryRun },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] }, { status: 201 })
  },
  { requireWrite: true },
)
