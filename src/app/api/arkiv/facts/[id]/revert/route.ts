import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { revertFact } from '@/lib/arkiv/facts/store'
import { getErrorMessage } from '@/lib/errors/get-error-message'

/**
 * POST /api/arkiv/facts/[id]/revert  { reason }
 * Rollback in one command: the fact is deprecated with the reason and the
 * fact it replaced comes back as the live value. Nothing is deleted.
 */
const bodySchema = z.object({ reason: z.string().trim().min(1).max(500) })

export const POST = withRouteContext('arkiv.fact.revert', async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
  if (!isArkivBrainEnabled(ctx.companyId)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { id } = await params
  const parsed = await validateBody(request, bodySchema)
  if (!parsed.success) return parsed.response
  const { data, error } = await ctx.supabase.from('company_facts').select('id, rank').eq('id', id).eq('company_id', ctx.companyId).maybeSingle()
  if (error) return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if ((data as { rank: string }).rank === 'deprecated') return NextResponse.json({ error: 'Faktumet är redan avfärdat.' }, { status: 409 })
  try {
    const reinstated = await revertFact(createServiceClient(), id, `${parsed.data.reason} (${ctx.user.id})`)
    ctx.log.info('fact reverted by person', { fact: id, reinstated })
    return NextResponse.json({ data: { fact_id: id, reinstated_fact_id: reinstated } })
  } catch (err) {
    ctx.log.error('fact revert failed', { fact: id, reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'Faktumet kunde inte återställas. Försök igen.' }, { status: 500 })
  }
})
