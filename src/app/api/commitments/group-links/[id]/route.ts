import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { updateGroupLink } from '@/lib/commitments/group-links'
import { UpdateGroupLinkSchema } from '@/lib/commitments/schemas'

/** PATCH /api/commitments/group-links/:id: change a group link, or end it with valid_to. */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'commitments.group-links.update',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const validation = await validateBody(request, UpdateGroupLinkSchema)
    if (!validation.success) return validation.response
    const outcome = await updateGroupLink({ supabase, companyId, userId: user.id }, id, validation.data, { dryRun: false })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
