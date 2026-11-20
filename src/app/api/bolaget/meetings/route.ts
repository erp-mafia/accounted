import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createMeeting } from '@/lib/bolaget/meetings/store'
import { MEETING_KINDS, type MeetingKind } from '@/lib/bolaget/meetings/types'
import { listMeetingsView } from '@/lib/bolaget/meetings/view'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { CreateMeetingIn } from '@/lib/operations/corporate-meetings'
import { sessionFailureResponse } from '@/lib/operations/session'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** GET /api/bolaget/meetings?kind=&fiscal_period_id=: the company's meetings (operation corporate-meetings.list). */
export const GET = withRouteContext('bolaget.meetings', async (request, ctx) => {
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const url = new URL(request.url)
  const kind = url.searchParams.get('kind')
  const fiscalPeriodId = url.searchParams.get('fiscal_period_id')
  if ((kind && !(MEETING_KINDS as readonly string[]).includes(kind)) || (fiscalPeriodId && !UUID.test(fiscalPeriodId))) {
    return errorResponseFromCode('VALIDATION_ERROR', ctx.log, { requestId: ctx.requestId })
  }
  const meetings = await listMeetingsView(operationContext(ctx), { kind: (kind as MeetingKind | null) ?? null, fiscal_period_id: fiscalPeriodId })
  return NextResponse.json({ data: { meetings } })
})

/** POST /api/bolaget/meetings: plan a meeting, an årsstämma prefilled (operation corporate-meetings.create). */
export const POST = withRouteContext(
  'bolaget.meeting_create',
  async (request, ctx) => {
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, CreateMeetingIn)
    if (!validation.success) return validation.response
    const dryRun = new URL(request.url).searchParams.get('dry_run') === 'true'
    const outcome = await createMeeting(operationContext(ctx), validation.data, { dryRun })
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] }, { status: 201 })
  },
  { requireWrite: true },
)
