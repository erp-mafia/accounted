import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createGroupLink } from '@/lib/commitments/group-links'
import { CreateGroupLinkSchema } from '@/lib/commitments/schemas'

/** POST /api/commitments/group-links: register a parent, subsidiary or associate. */
export const POST = withRouteContext(
  'commitments.group-links.create',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, CreateGroupLinkSchema)
    if (!validation.success) return validation.response
    const outcome = await createGroupLink({ supabase, companyId, userId: user.id }, validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
