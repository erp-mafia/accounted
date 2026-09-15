import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BookAssociationDistributionSchema } from '@/lib/api/schemas'
import { requireMemberCapitalForm } from '@/lib/associations/member-register'
import { bookDistribution } from '@/lib/associations/distributions'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

ensureInitialized()

/**
 * POST /api/associations/distributions/[id]/book
 *
 * Books the decision verifikat through the bookkeeping engine (dividends
 * Dr 2091 / Cr 2898, gottgörelse Dr 8840 / Cr 2890) in the distribution's
 * fiscal period. The entry is the accounting record of the decision, so a
 * failed commit fails the request. The allocations must equal the total.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'association.distribution_book',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, BookAssociationDistributionSchema, {
      log,
      operation: 'association.distribution_book',
    })
    if (!validation.success) return validation.response
    try {
      await requireMemberCapitalForm(supabase, companyId)
      const data = await bookDistribution(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return associationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
