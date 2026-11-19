import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isUuid } from '@/lib/invariants/uuid'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { remindSigner } from '@/lib/signing/requests'

/**
 * POST /api/signing-requests/:id/signers/:signerId/remind: mail a pending
 * signer again (once a day at most). The reminder carries a new link and the
 * old one stops working; the answer carries the new link only when no mail
 * went out.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string; signerId: string }> }>(
  'signing_requests.remind',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id, signerId } = await params
    if (!isUuid(id) || !isUuid(signerId)) return errorResponseFromCode('SIGNING_SIGNER_NOT_FOUND', log, { requestId })
    const outcome = await remindSigner({ supabase, companyId, userId: user.id, log }, { signingRequestId: id, signerId })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
