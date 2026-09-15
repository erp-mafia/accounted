import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateAssociationAuditorSchema } from '@/lib/api/schemas'
import { updateAuditor } from '@/lib/associations/auditors'
import { requireMemberCapitalForm } from '@/lib/associations/member-register'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

/**
 * PATCH /api/associations/auditors/[id]: end the assignment (EFL 8 kap.
 * 24-25 §§) or correct its term and references. An ended assignment is a
 * date on the row, never a delete.
 */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'association.auditor_update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, UpdateAssociationAuditorSchema, {
      log,
      operation: 'association.auditor_update',
    })
    if (!validation.success) return validation.response
    try {
      await requireMemberCapitalForm(supabase, companyId)
      const data = await updateAuditor(supabase, companyId, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return associationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
