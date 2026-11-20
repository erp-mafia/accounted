import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { requestMeetingSignatures } from '@/lib/bolaget/meetings/signing'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { sessionFailureResponse } from '@/lib/operations/session'

type Params = { params: Promise<{ id: string }> }

/**
 * POST /api/bolaget/meetings/{id}/bankid: send the minutes for BankID
 * signing where signing is open for the company (SIGNING_ENABLED and the
 * plan). The PDF is archived; the signers get a link by mail, or the answer
 * carries the link of a signer without an address. The minutes are frozen
 * while the request runs and signed when it completes.
 */
export const POST = withRouteContext<Params>(
  'bolaget.meeting_bankid',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const outcome = await requestMeetingSignatures(operationContext(ctx), id)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
