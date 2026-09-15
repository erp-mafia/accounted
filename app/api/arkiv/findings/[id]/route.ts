import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/arkiv/findings/[id]
 * A person closes a finding: `applied` after acting on it (a settings
 * mismatch is applied through PUT /api/settings first, so the deadline
 * regeneration there runs), or `dismissed` to stop seeing it. A dismissed
 * finding stays closed even when the nightly lint still sees it.
 */
const bodySchema = z.object({ resolution: z.enum(['applied', 'dismissed']) })

export const POST = withRouteContext('arkiv.finding', async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const validation = await validateBody(request, bodySchema)
  if (!validation.success) return validation.response
  const { resolution } = validation.data
  const { data, error } = await ctx.supabase
    .from('arkiv_findings')
    .update({ status: resolution === 'dismissed' ? 'dismissed' : 'resolved', resolution, resolved_at: new Date().toISOString(), resolved_by_user_id: ctx.user.id })
    .eq('id', id)
    .eq('company_id', ctx.companyId)
    .eq('status', 'open')
    .select('id')
    .maybeSingle()
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json({ data: { finding_id: id, status: resolution === 'dismissed' ? 'dismissed' : 'resolved' } })
})
