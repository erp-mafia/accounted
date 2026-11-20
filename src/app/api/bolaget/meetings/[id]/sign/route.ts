import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { declaredDocumentType } from '@/lib/core/documents/document-service'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { signMeetingManually } from '@/lib/bolaget/meetings/signing'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { sessionFailureResponse } from '@/lib/operations/session'

type Params = { params: Promise<{ id: string }> }

const SignSchema = z.object({
  signed_on: saneIsoDateSchema,
  signature_names: z.string().trim().min(1).max(1000),
})

/**
 * POST /api/bolaget/meetings/{id}/sign: the minutes signed on paper.
 * multipart/form-data: signed_on (YYYY-MM-DD), signature_names (who signed)
 * and, optionally, file: the signed minutes scanned, archived as the signed
 * copy. The elections take effect in the roles and the minutes are frozen.
 */
export const POST = withRouteContext<Params>(
  'bolaget.meeting_sign',
  async (request, ctx, { params }) => {
    const { id } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      // Not a multipart body: the caller's mistake, answered as such.
      return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId, details: { reason: 'multipart form expected' } })
    }
    const parsed = SignSchema.safeParse({ signed_on: form.get('signed_on'), signature_names: form.get('signature_names') })
    if (!parsed.success) {
      return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { issues: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) },
      })
    }
    const upload = form.get('file')
    const file =
      upload instanceof File && upload.size > 0
        ? { name: upload.name, buffer: await upload.arrayBuffer(), type: declaredDocumentType({ name: upload.name, type: upload.type }) }
        : null
    const outcome = await signMeetingManually(operationContext(ctx), id, {
      signedOn: parsed.data.signed_on,
      signatureNames: parsed.data.signature_names,
      file,
    })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] })
  },
  { requireWrite: true },
)
