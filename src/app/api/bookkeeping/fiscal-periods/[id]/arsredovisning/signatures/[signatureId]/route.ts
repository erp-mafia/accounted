import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SignatureTransitionSchema } from '@/lib/bokslut/arsredovisning/workflow-schemas'
import {
  recordArsredovisningSignature,
  removeArsredovisningSignatory,
} from '@/lib/bokslut/arsredovisning/workflow-service'
import { sessionFailureResponse } from '@/lib/operations/session'

// PATCH transitions: pending -> signed (manual entry for the paper / outside-
// BankID flow) or pending -> declined. DELETE removes an unbound pending
// slot. The rules and the scoping of every write (id, company, the path's
// period, status pending) live in workflow-service.ts, shared with the v1
// operations arsredovisning.record-signature and arsredovisning.remove-signatory.

export const PATCH = withRouteContext(
  'period.arsredovisning_signature_patch',
  async (
    request,
    ctx,
    { params }: { params: Promise<{ id: string; signatureId: string }> },
  ) => {
    const { id: fiscalPeriodId, signatureId } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, SignatureTransitionSchema)
    if (!validation.success) return validation.response
    const outcome = await recordArsredovisningSignature(
      { supabase, companyId, userId: ctx.user.id, log },
      fiscalPeriodId,
      signatureId,
      validation.data,
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'period.arsredovisning_signature_delete',
  async (
    _request,
    ctx,
    { params }: { params: Promise<{ id: string; signatureId: string }> },
  ) => {
    const { id: fiscalPeriodId, signatureId } = await params
    const { supabase, companyId, log, requestId } = ctx
    const outcome = await removeArsredovisningSignatory(
      { supabase, companyId, userId: ctx.user.id, log },
      fiscalPeriodId,
      signatureId,
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    return new NextResponse(null, { status: 204 })
  },
  { requireWrite: true },
)
