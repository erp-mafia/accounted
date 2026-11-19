import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { isUuid } from '@/lib/invariants/uuid'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { cancelSigningRequest } from '@/lib/signing/requests'

/**
 * POST /api/signing-requests/:id/cancel: stop an open request. Its links stop
 * working; signatures already made stay. The sender, an owner or an admin.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'signing_requests.cancel',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!isUuid(id)) return errorResponseFromCode('SIGNING_REQUEST_NOT_FOUND', log, { requestId })
    const outcome = await cancelSigningRequest({ supabase, companyId, userId: user.id, log }, { signingRequestId: id })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
