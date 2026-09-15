import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateAssociationContributionSchema } from '@/lib/api/schemas'
import {
  listContributions,
  recordContribution,
  requireMemberCapitalForm,
} from '@/lib/associations/member-register'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

/**
 * GET  /api/associations/contributions?member_id=...
 * POST /api/associations/contributions
 *
 * Insatser per member (EFL 10-11 kap.). The row records who paid what; the
 * verifikat that booked it (Dr 1930 / Cr 2083, 2087 or 2084) is linked, not
 * created here: journal writes stay in the bookkeeping engine.
 */
export const GET = withRouteContext('association.contributions_list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    await requireMemberCapitalForm(supabase, companyId)
    const memberId = new URL(request.url).searchParams.get('member_id') ?? undefined
    const data = await listContributions(supabase, companyId, memberId)
    return NextResponse.json({ data })
  } catch (err) {
    return associationErrorResponse(err, log, requestId)
  }
})

export const POST = withRouteContext(
  'association.contribution_create',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, CreateAssociationContributionSchema, {
      log,
      operation: 'association.contribution_create',
    })
    if (!validation.success) return validation.response
    try {
      await requireMemberCapitalForm(supabase, companyId)
      const data = await recordContribution(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return associationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
