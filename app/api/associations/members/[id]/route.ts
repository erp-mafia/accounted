import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ExitAssociationMemberSchema } from '@/lib/api/schemas'
import { exitMember, requireMemberCapitalForm } from '@/lib/associations/member-register'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

/**
 * PATCH /api/associations/members/[id]: record the member's exit (EFL 4 kap.).
 * An exit is a date on the row, never a delete: the register is kept for
 * seven years after the member has left (EFL 5 kap. 6 §).
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'association.member_exit',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, ExitAssociationMemberSchema, {
      log,
      operation: 'association.member_exit',
    })
    if (!validation.success) return validation.response
    try {
      await requireMemberCapitalForm(supabase, companyId)
      const data = await exitMember(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return associationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
