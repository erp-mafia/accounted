import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PayAssociationDistributionSchema } from '@/lib/api/schemas'
import { requireMemberCapitalForm } from '@/lib/associations/member-register'
import { payDistribution } from '@/lib/associations/distributions'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

ensureInitialized()

/**
 * POST /api/associations/distributions/[id]/pay
 *
 * Books the payment (Dr 2898 or 2890 / Cr bank) in the open period covering
 * the payment date and marks the distribution paid. Requires a booked
 * decision; the payment may fall in a later fiscal year.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'association.distribution_pay',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, PayAssociationDistributionSchema, {
      log,
      operation: 'association.distribution_pay',
    })
    if (!validation.success) return validation.response
    try {
      await requireMemberCapitalForm(supabase, companyId)
      const data = await payDistribution(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return associationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
