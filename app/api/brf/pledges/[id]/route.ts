import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ReleaseBrfPledgeSchema } from '@/lib/api/schemas'
import { releasePledge } from '@/lib/brf/apartment-register'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'

/** PATCH /api/brf/pledges/[id]: release (avföra) a pantsättning by date. */
export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'brf.pledge_release',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, ReleaseBrfPledgeSchema, {
      log,
      operation: 'brf.pledge_release',
    })
    if (!validation.success) return validation.response
    try {
      await requireBrfForm(supabase, companyId)
      const data = await releasePledge(supabase, companyId, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return brfRegisterErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
