import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { BokslutChecklistError, buildBokslutChecklist, setChecklistItem } from '@/lib/bokslut/checklist'

/**
 * GET   /api/bookkeeping/fiscal-periods/{id}/bokslut-checklist
 * PATCH /api/bookkeeping/fiscal-periods/{id}/bokslut-checklist
 *
 * The bokslut checklist for one räkenskapsår: the catalogue merged with the
 * live auto states and the stored rows. PATCH ticks one item
 * ({ item_key, state, note? }) as the acting user and returns the refreshed
 * checklist. Catalogue and policy in lib/bokslut/checklist.ts.
 */
export const GET = withRouteContext(
  'period.bokslut_checklist',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const checklist = await buildBokslutChecklist(supabase, companyId, user.id, id)
    if (!checklist) return errorResponseFromCode('PERIOD_NOT_FOUND', log.child({ periodId: id }), { requestId })
    return NextResponse.json({ data: checklist })
  },
)

const PatchBodySchema = z.object({
  item_key: z.string().regex(/^[a-z0-9_]{1,64}$/),
  state: z.enum(['open', 'done', 'not_applicable']),
  note: z.string().max(2000).nullable().optional(),
})

export const PATCH = withRouteContext(
  'period.bokslut_checklist.set',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Ogiltig JSON' }, { status: 400 })
    }
    const parsed = PatchBodySchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Ogiltig body: item_key och state (open/done/not_applicable) krävs' }, { status: 400 })
    }
    // The period must be this company's before anything is written.
    const existing = await buildBokslutChecklist(supabase, companyId, user.id, id, { readiness: null })
    if (!existing) return errorResponseFromCode('PERIOD_NOT_FOUND', log.child({ periodId: id }), { requestId })
    try {
      await setChecklistItem(supabase, companyId, user.id, id, {
        item_key: parsed.data.item_key,
        state: parsed.data.state,
        note: parsed.data.note ?? null,
      })
    } catch (err) {
      if (err instanceof BokslutChecklistError) {
        return NextResponse.json({ error: getErrorMessage(err), code: err.code }, { status: 400 })
      }
      throw err
    }
    const checklist = await buildBokslutChecklist(supabase, companyId, user.id, id)
    return NextResponse.json({ data: checklist })
  },
  { requireWrite: true },
)
