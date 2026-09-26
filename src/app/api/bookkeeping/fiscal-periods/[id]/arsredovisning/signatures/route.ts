import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { listSignatureRequests } from '@/lib/bokslut/arsredovisning/signature-service'
import { SignatoryCreateSchema } from '@/lib/bokslut/arsredovisning/workflow-schemas'
import { addArsredovisningSignatory } from '@/lib/bokslut/arsredovisning/workflow-service'
import { sessionFailureResponse } from '@/lib/operations/session'

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

/** Rules in workflow-service.ts, shared with operation arsredovisning.add-signatory. */
export const POST = withRouteContext(
  'period.arsredovisning_signatures_create',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, SignatoryCreateSchema)
    if (!validation.success) return validation.response
    const outcome = await addArsredovisningSignatory(
      { supabase, companyId, userId: user.id, log },
      id,
      validation.data,
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
