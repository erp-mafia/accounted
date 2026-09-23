import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'

const ReviewSchema = z.object({ reviewToken: z.uuid(), expectedEntryId: z.uuid().nullable() }).strict()
type Params = { params: Promise<{ id: string }> }

export const POST = withRouteContext<Params>('period.opening_balance.review', async (request, ctx, { params }) => {
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return NextResponse.json({ error: 'Ogiltigt räkenskapsår.' }, { status: 400 })
  const validation = await validateBody(request, ReviewSchema)
  if (!validation.success) return validation.response
  const { error } = await ctx.supabase.rpc('acknowledge_sie_opening_balance_review', {
    p_company_id: ctx.companyId, p_period_id: id, p_actor: ctx.user.id,
    p_review_token: validation.data.reviewToken, p_expected_entry_id: validation.data.expectedEntryId,
  })
  if (error) {
    const status = error.code === '42501' ? 403 : error.code === 'P0002' ? 404 :
      ['40001', '55000', '55P03'].includes(error.code) ? 409 : 500
    if (status === 500) ctx.log.error('Opening balance review failed', error)
    const message = status === 403 ? 'Endast ägare och administratörer kan bekräfta granskningen.' :
      status === 404 ? 'Räkenskapsåret hittades inte.' : status === 409 ?
        'Underlaget har ändrats eller en import pågår. Ladda om och granska igen.' : 'Granskningen kunde inte sparas. Försök igen.'
    return NextResponse.json({ error: message }, { status })
  }
  return NextResponse.json({ data: { reviewed: true } })
}, { requireWrite: true })
