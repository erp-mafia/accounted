import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { generateKu20File } from '@/lib/bolaget/owner-tax/ku20'
import { parseIncomeYear } from '../../../year'

/**
 * GET /api/bolaget/owner-tax/ku20/{year}/file: the KU20 XML file for
 * Skatteverket's e-service "Lämna kontrolluppgifter" (filöverföring). An
 * owner or administrator only: the file carries full personnummer, read
 * and decrypted here and nowhere else. No API key or agent door.
 */
export const GET = withRouteContext<{ params: Promise<{ year: string }> }>(
  'bolaget.ku20_file',
  async (_request, ctx, { params }) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const year = parseIncomeYear((await params).year)
    if (year === null) return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
    const outcome = await generateKu20File(operationContext(ctx), year)
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
