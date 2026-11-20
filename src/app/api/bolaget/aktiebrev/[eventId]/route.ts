import { withRouteContext } from '@/lib/api/with-route-context'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { loadFullIdentity } from '@/lib/bolaget/people'
import { buildAktiebrevData } from '@/lib/bolaget/pdf-data'
import { renderAktiebrevPdf } from '@/lib/bolaget/pdf'
import { replayShareRegister } from '@/lib/bolaget/register-state'
import { loadRoles } from '@/lib/bolaget/roles'
import { bolagetGateResponse, callerIsCompanyAdmin, companyForPdf, operationContext } from '@/lib/bolaget/session'
import { loadShareRegisterData } from '@/lib/bolaget/share-register'

/**
 * GET /api/bolaget/aktiebrev/{eventId}: the printable aktiebrev (ABL 6:2)
 * of an 'aktiebrev issued' entry: the holder on the issue date, the share
 * numbers, the class and its förbehåll, with the board's printed names
 * (6:3). 404 for any other entry.
 */
export const GET = withRouteContext<{ params: Promise<{ eventId: string }> }>('bolaget.aktiebrev_pdf', async (_request, ctx, { params }) => {
  const { eventId } = await params
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const op = operationContext(ctx)
  const [data, roles, company, isAdmin] = await Promise.all([
    loadShareRegisterData(op, null),
    loadRoles(op, null),
    companyForPdf(ctx.supabase, ctx.companyId),
    callerIsCompanyAdmin(ctx.supabase, ctx.user.id, ctx.companyId),
  ])
  const event = data.events.find((e) => e.id === eventId)
  if (!event) return errorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
  // The register as it stood when the aktiebrev was entered: later entries of the same day do not count; corrections always do.
  const onIssue = replayShareRegister(
    data.events.filter((e) => e.kind === 'rattelse' || e.event_date < event.event_date || e.event_number <= event.event_number),
    event.event_date,
  )
  const fullPersonnummer = isAdmin ? await loadFullIdentity(ctx.companyId, [...data.parties.keys()]) : undefined
  const brev = buildAktiebrevData(event, data, onIssue, roles, company, fullPersonnummer)
  if (!brev) return errorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
  const pdf = await renderAktiebrevPdf(brev)
  return fileResponse(new Uint8Array(pdf), { filename: `Aktiebrev_${brev.number}.pdf`, contentType: 'application/pdf', cacheControl: 'private, no-store' })
})
