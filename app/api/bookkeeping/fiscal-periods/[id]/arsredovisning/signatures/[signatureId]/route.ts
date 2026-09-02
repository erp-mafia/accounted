import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { markSignatureSigned } from '@/lib/bokslut/arsredovisning/signature-service'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'

import { createServiceClient } from '@/lib/supabase/server'

// PATCH transitions: pending → signed (manual entry for the paper / outside-
// BankID flow) or pending → declined. Real BankID wiring lands in a future
// phase and uses the same UPDATE with the BankID callback as trigger.
//
// Hardening on every UPDATE:
//   - .eq('id', signatureId) + .eq('company_id', companyId)
//   - .eq('fiscal_period_id', id from URL): enforces the REST contract so
//     /periods/A/signatures/SIG_FROM_B can't bypass the path scope
//   - .eq('status', 'pending'): state-machine guard so a signed or declined
//     row can't be flipped back
const EvidenceReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^(archive|document|receipt):[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/)

const PatchSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('signed'),
    annual_report_version_id: z.string().uuid(),
    signing_method: z.enum(['paper_original', 'advanced_e_signature', 'bankid']),
    evidence_reference: EvidenceReferenceSchema,
    signed_at: z.string().datetime().optional(),
  }).strict(),
  z.object({ status: z.literal('declined') }).strict(),
])

function isSignatureDateAllowed(signedAt: string, finalizedAt: string): boolean {
  const signedDate = getSwedishLocalDate(new Date(signedAt))
  const finalizedDate = getSwedishLocalDate(new Date(finalizedAt))
  const today = getSwedishLocalDate()

  return signedDate >= finalizedDate && signedDate <= today
}

export const PATCH = withRouteContext(
  'period.arsredovisning_signature_patch',
  async (
    request,
    ctx,
    { params }: { params: Promise<{ id: string; signatureId: string }> },
  ) => {
    const { id: fiscalPeriodId, signatureId } = await params
    const { supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, PatchSchema)
    if (!validation.success) return validation.response

    try {
      if (validation.data.status === 'signed') {
        const { data: version, error: versionError } = await supabase
          .from('annual_report_versions')
          .select('id, status, finalized_at')
          .eq('id', validation.data.annual_report_version_id)
          .eq('company_id', companyId)
          .eq('fiscal_period_id', fiscalPeriodId)
          .eq('status', 'ready_for_signature')
          .maybeSingle()
        if (versionError) {
          throw new Error(`Failed to load annual report version: ${versionError.message}`)
        }
        if (!version?.finalized_at) {
          return errorResponseFromCode('ARSREDOVISNING_VERSION_NOT_SIGNABLE', log, {
            requestId,
          })
        }
        const { data: requestRow, error: requestError } = await supabase
          .from('arsredovisning_signature_requests')
          .select('id, annual_report_version_id, status')
          .eq('id', signatureId)
          .eq('company_id', companyId)
          .eq('fiscal_period_id', fiscalPeriodId)
          .eq('status', 'pending')
          .maybeSingle()
        if (requestError) {
          throw new Error(`Failed to load annual report signature: ${requestError.message}`)
        }
        if (
          !requestRow ||
          (requestRow.annual_report_version_id !== null &&
            requestRow.annual_report_version_id !== validation.data.annual_report_version_id)
        ) {
          return NextResponse.json(
            { error: { code: 'SIGNATURE_INVALID_TRANSITION' } },
            { status: 409 },
          )
        }
        const signedAt = validation.data.signed_at ?? new Date().toISOString()
        if (!isSignatureDateAllowed(signedAt, version.finalized_at)) {
          return errorResponseFromCode('ARSREDOVISNING_SIGNATURE_DATE_INVALID', log, {
            requestId,
          })
        }
        const data = await markSignatureSigned(createServiceClient(), companyId, signatureId, {
          fiscalPeriodId,
          annualReportVersionId: validation.data.annual_report_version_id,
          signingMethod: validation.data.signing_method,
          evidenceReference: validation.data.evidence_reference,
          evidenceRecordedBy: ctx.user.id,
          signedAt,
        })
        return NextResponse.json({ data })
      }

      const { data, error } = await createServiceClient()
        .from('arsredovisning_signature_requests')
        .update({ status: 'declined' as const })
        .eq('id', signatureId)
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'pending')
        .select('*')
        .maybeSingle()

      if (error) {
        throw new Error(`Failed to update signature: ${error.message}`)
      }
      if (!data) {
        // No row matched: either it doesn't exist, belongs to another
        // company / period, or is already signed/declined. Return 409 so
        // the client knows the transition is invalid rather than "missing".
        return NextResponse.json(
          { error: { code: 'SIGNATURE_INVALID_TRANSITION' } },
          { status: 409 },
        )
      }
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
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
    try {
      const { data, error } = await supabase
        .from('arsredovisning_signature_requests')
        .delete()
        .eq('id', signatureId)
        .eq('company_id', companyId)
        .eq('fiscal_period_id', fiscalPeriodId)
        .eq('status', 'pending')
        .is('annual_report_version_id', null)
        .select('id')
        .maybeSingle()
      if (error) throw new Error(`Failed to remove annual report signer: ${error.message}`)
      if (!data) {
        return NextResponse.json(
          { error: { code: 'ARSREDOVISNING_SIGNER_ROSTER_LOCKED' } },
          { status: 409 },
        )
      }
      return new NextResponse(null, { status: 204 })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
