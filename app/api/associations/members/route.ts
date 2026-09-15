import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { CreateAssociationMemberSchema } from '@/lib/api/schemas'
import { createMember, listMembers, requireMemberCapitalForm } from '@/lib/associations/member-register'
import { associationErrorResponse } from '@/lib/associations/route-helpers'

/**
 * GET  /api/associations/members?include_exited=true
 * POST /api/associations/members
 *
 * Medlemsförteckning of an ekonomisk förening (EFL 5 kap.). Only a company
 * whose form supports member capital has one; every other form gets 409.
 */
export const GET = withRouteContext('association.members_list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    await requireMemberCapitalForm(supabase, companyId)
    const includeExited = new URL(request.url).searchParams.get('include_exited') === 'true'
    const data = await listMembers(supabase, companyId, { includeExited })
    return NextResponse.json({ data })
  } catch (err) {
    return associationErrorResponse(err, log, requestId)
  }
})

export const POST = withRouteContext(
  'association.member_create',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, CreateAssociationMemberSchema, {
      log,
      operation: 'association.member_create',
    })
    if (!validation.success) return validation.response
    try {
      await requireMemberCapitalForm(supabase, companyId)
      const data = await createMember(supabase, companyId, user.id, validation.data)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return associationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
