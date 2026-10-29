import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { generateKu31File } from '@/lib/bolaget/capital/ku31'
import { isFiscalYear } from '@/lib/invariants/fiscal-year'

/**
 * GET /api/bolaget/capital/ku31/{year}/file: the KU31 XML file for
 * Skatteverket's e-service "Lämna kontrolluppgifter" (filöverföring). An
 * owner or administrator only: the file carries full personnummer, read
 * and decrypted here and nowhere else. No API key or agent door.
 */
export const GET = withRouteContext<{ params: Promise<{ year: string }> }>(
  'bolaget.ku31_file',
  async (_request, ctx, { params }) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const raw = (await params).year
    const year = isFiscalYear(raw) ? Number(raw) : NaN
    if (!(year >= 2000 && year <= 2099)) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const outcome = await generateKu31File(operationContext(ctx), year)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return errorResponseFromCode('UNKNOWN_ERROR', ctx.log, { requestId: ctx.requestId })
    return fileResponse(outcome.data.xml, {
      filename: outcome.data.filename,
      contentType: 'application/xml; charset=utf-8',
      cacheControl: 'private, no-store',
    })
  },
  { requireWrite: true },
)
