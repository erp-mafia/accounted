import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import { isUuid } from '@/lib/invariants/uuid'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getSigningRequest } from '@/lib/signing/requests'
import { ensureSealed } from '@/lib/signing/seal'

/**
 * GET /api/signing-requests/:id: one request with every signer's status, and
 * once completed the signed PDF and the evidence package. A completed
 * request whose seal never landed is sealed again here.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'signing_requests.get',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!isUuid(id)) return errorResponseFromCode('SIGNING_REQUEST_NOT_FOUND', log, { requestId })
    const outcome = await getSigningRequest({ supabase, companyId }, id)
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    const view = outcome.data
    if (view.state === 'completed' && (!view.signed_document_id || !view.evidence_document_id)) {
      await ensureSealed(
        createServiceClient(),
        { id: view.signing_request_id, status: 'completed', completed_at: view.completed_at, signed_document_id: view.signed_document_id, evidence_document_id: view.evidence_document_id },
        log,
      )
      const reread = await getSigningRequest({ supabase, companyId }, id)
      if (reread.ok && !reread.dryRun) return NextResponse.json({ data: reread.data })
    }
    return NextResponse.json({ data: view })
  },
)
