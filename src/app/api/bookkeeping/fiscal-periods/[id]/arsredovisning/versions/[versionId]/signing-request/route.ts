import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { isUuid } from '@/lib/invariants/uuid'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { requestArsredovisningSignatures } from '@/lib/bokslut/arsredovisning/bankid-signing'

const BodySchema = z
  .object({
    signers: z
      .array(
        z
          .object({
            signature_id: z.string().uuid(),
            email: z.string().trim().email().max(254).nullish(),
            user_id: z.string().uuid().nullish(),
            // The app's dialog only: locks the slot to this person's BankID.
            personal_number: z.string().max(20).nullish(),
          })
          .strict(),
      )
      .max(20),
    message: z.string().max(1000).nullish(),
    expires_in_days: z.number().int().min(1).max(90).nullish(),
    send_email: z.boolean().optional(),
  })
  .strict()

/**
 * POST /api/bookkeeping/fiscal-periods/:id/arsredovisning/versions/:versionId/signing-request:
 * send the locked version to the board for BankID signing (the same service
 * as the v1 operation arsredovisning.request-signatures, plus the optional
 * personnummer lock only the app may set).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string; versionId: string }> }>(
  'arsredovisning.request_signatures',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id, versionId } = await params
    if (!isUuid(id) || !isUuid(versionId)) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const validation = await validateBody(request, BodySchema)
    if (!validation.success) return validation.response
    const body = validation.data
    const outcome = await requestArsredovisningSignatures(
      { supabase, companyId, userId: user.id, log },
      {
        fiscalPeriodId: id,
        versionId,
        signers: body.signers.map((s) => ({ signatureId: s.signature_id, email: s.email ?? null, userId: s.user_id ?? null, personalNumber: s.personal_number ?? null })),
        message: body.message ?? null,
        expiresInDays: body.expires_in_days ?? null,
        sendEmail: body.send_email,
        createdVia: 'app',
      },
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data }, { status: 201 })
  },
  { requireWrite: true },
)
