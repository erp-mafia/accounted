import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BrfMemberPersonalNumberSchema } from '@/lib/api/schemas'
import { setMemberPersonalNumber } from '@/lib/brf/apartment-register'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'

/**
 * PUT /api/brf/members/[id]/personal-number { personal_number | null }
 *
 * The personnummer a KU55 needs for the överlåtare (fältkod 215). Encrypted
 * server-side, never read back through the register: a wrong value is
 * replaced, not displayed.
 */
export const PUT = withRouteContext<{ params: Promise<{ id: string }> }>(
  'brf.member_personal_number',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, BrfMemberPersonalNumberSchema, {
      log,
      operation: 'brf.member_personal_number',
    })
    if (!validation.success) return validation.response
    try {
      await requireBrfForm(supabase, companyId)
      await setMemberPersonalNumber(supabase, companyId, id, validation.data.personal_number)
      return NextResponse.json({ data: { member_id: id, stored: validation.data.personal_number !== null } })
    } catch (err) {
      return brfRegisterErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
