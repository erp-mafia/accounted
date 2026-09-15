import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SettleAssociationContributionSchema } from '@/lib/api/schemas'
import { requireMemberCapitalForm, settleContribution } from '@/lib/associations/member-register'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

/**
 * POST /api/associations/contributions/[id]/settle
 *
 * Repay (EFL 10 kap. 11 §, or 11 kap. 7 § for förlagsinsatser) or forfeit a
 * contribution. Repayment needs a recorded exit and may not exceed the paid
 * amount; the payment verifikat (Dr 2083 / Cr 2890 or 1930) is linked.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'association.contribution_settle',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, SettleAssociationContributionSchema, {
      log,
      operation: 'association.contribution_settle',
    })
    if (!validation.success) return validation.response
    try {
      await requireMemberCapitalForm(supabase, companyId)
      const data = await settleContribution(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return associationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
