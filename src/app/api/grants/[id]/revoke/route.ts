import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { stageGrantRevocation } from '@/lib/grants/actions'
import { createServiceClient } from '@/lib/supabase/server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * POST /api/grants/:id/revoke
 *
 * Stage revoke_grant for one of the company's rules for automatic booking
 * (lib/grants). Answers the staged operation's id; the app then approves it
 * through POST /api/pending-operations/:id/commit, the door every staged
 * operation has, where revoke_company_grant re-checks that the approver is an
 * owner or admin and answers the postings the grant let through. A member
 * who is neither leaves it in /pending for one who is.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'grant.revoke',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!UUID.test(id)) return errorResponseFromCode('GRANT_NOT_FOUND', log, { requestId })

    const outcome = await stageGrantRevocation(
      supabase,
      createServiceClient(),
      { companyId, userId: user.id, userLabel: user.email ?? null, grantId: id },
      log,
    )
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId })
    return NextResponse.json({ data: { operation_id: outcome.operationId } })
  },
  { requireWrite: true },
)
