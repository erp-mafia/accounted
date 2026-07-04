import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import {
  createSignatureRequest,
  listSignatureRequests,
} from '@/lib/bokslut/arsredovisning/signature-service'

// Roles are constrained to the underskrifter set ÅRL allows: keeps the API
// from accepting arbitrary "Administrator" / "CEO" strings that the UI
// dropdown doesn't expose. Name capped at 200 chars per GDPR data-min
// (Art.25.2): Swedish names are well under that; bound is a defense.
const CreateSchema = z.object({
  role: z.enum(['Styrelseledamot', 'Styrelseordförande', 'VD', 'Verkställande direktör']),
  signer_name: z.string().min(1).max(200),
})

export const GET = withRouteContext(
  'period.arsredovisning_signatures_list',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const data = await listSignatureRequests(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
)

export const POST = withRouteContext(
  'period.arsredovisning_signatures_create',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, CreateSchema)
    if (!validation.success) return validation.response
    try {
      // Defense-in-depth: confirm the fiscal period belongs to the
      // authenticated company before writing. RLS would catch a cross-tenant
      // insert anyway, but rejecting at the route layer gives a cleaner
      // 404 + avoids the noisy RLS error in the structured-error envelope.
      const { data: period } = await supabase
        .from('fiscal_periods')
        .select('id')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!period) {
        return NextResponse.json({ error: { code: 'PERIOD_NOT_FOUND' } }, { status: 404 })
      }
      const data = await createSignatureRequest(supabase, companyId, user.id, id, validation.data)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
