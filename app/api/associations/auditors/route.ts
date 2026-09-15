import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AppointAssociationAuditorSchema } from '@/lib/api/schemas'
import { appointAuditor, listAuditors } from '@/lib/associations/auditors'
import { requireMemberCapitalForm } from '@/lib/associations/member-register'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

/**
 * GET  /api/associations/auditors?include_ended=true
 * POST /api/associations/auditors
 *
 * Revisor roster of an ekonomisk förening (EFL 8 kap.). Only a company whose
 * form supports member capital has one; every other form gets 409.
 */
export const GET = withRouteContext('association.auditors_list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    await requireMemberCapitalForm(supabase, companyId)
    const includeEnded = new URL(request.url).searchParams.get('include_ended') === 'true'
    const data = await listAuditors(supabase, companyId, { includeEnded })
    return NextResponse.json({ data })
  } catch (err) {
    return associationErrorResponse(err, log, requestId)
  }
})

export const POST = withRouteContext(
  'association.auditor_appoint',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, AppointAssociationAuditorSchema, {
      log,
      operation: 'association.auditor_appoint',
    })
    if (!validation.success) return validation.response
    try {
      await requireMemberCapitalForm(supabase, companyId)
      const data = await appointAuditor(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return associationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
