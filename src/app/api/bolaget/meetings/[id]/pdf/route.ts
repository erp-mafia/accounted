import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { minutesFilename } from '@/lib/bolaget/meetings/minutes-pdf-data'
import { renderMeetingPdf } from '@/lib/bolaget/meetings/signing'
import { getMeetingView } from '@/lib/bolaget/meetings/view'
import { bolagetGateResponse, callerIsCompanyAdmin, operationContext } from '@/lib/bolaget/session'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/bolaget/meetings/{id}/pdf: the minutes as a PDF, with the
 * röstlängd and, for a stämma, the aktiebok as of the meeting day (ABL 7:28,
 * 7:48). An owner or admin gets the aktiebok with full personnummer, as the
 * aktiebok printout; everyone else masked.
 */
export const GET = withRouteContext<Params>('bolaget.meeting_pdf', async (_request, ctx, { params }) => {
  const { id } = await params
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const op = operationContext(ctx)
  const [view, isAdmin] = await Promise.all([getMeetingView(op, id), callerIsCompanyAdmin(ctx.supabase, ctx.user.id, ctx.companyId)])
  if (!view) return errorResponseFromCode('CORPORATE_MEETING_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
  const pdf = await renderMeetingPdf(op, view, { fullPersonnummer: isAdmin })
  return fileResponse(new Uint8Array(pdf), { filename: minutesFilename(view), contentType: 'application/pdf', cacheControl: 'private, no-store' })
})
