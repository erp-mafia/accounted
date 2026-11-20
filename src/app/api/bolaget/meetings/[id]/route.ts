import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { deleteMeeting, updateMeeting } from '@/lib/bolaget/meetings/store'
import { getMeetingView } from '@/lib/bolaget/meetings/view'
import { bolagetGateResponse, operationContext } from '@/lib/bolaget/session'
import { UpdateMeetingIn } from '@/lib/operations/corporate-meetings'
import { sessionFailureResponse } from '@/lib/operations/session'

type Params = { params: Promise<{ id: string }> }

const PatchSchema = UpdateMeetingIn.omit({ corporate_meeting_id: true })

/** GET /api/bolaget/meetings/{id}: one meeting with its minutes, in step with its signing (operation corporate-meetings.get). */
export const GET = withRouteContext<Params>('bolaget.meeting', async (_request, ctx, { params }) => {
  const { id } = await params
  const gate = await bolagetGateResponse(ctx)
  if (gate) return gate
  const view = await getMeetingView(operationContext(ctx), id)
  if (!view) return errorResponseFromCode('CORPORATE_MEETING_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
  return NextResponse.json({ data: view })
})

/** PATCH /api/bolaget/meetings/{id}: change a meeting whose minutes are unsigned (operation corporate-meetings.update). */
export const PATCH = withRouteContext<Params>(
  'bolaget.meeting_update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const validation = await validateBody(request, PatchSchema)
    if (!validation.success) return validation.response
    const { attendees, ...patch } = validation.data
    const outcome = await updateMeeting(
      operationContext(ctx),
      id,
      { ...patch, attendees: attendees === undefined ? undefined : attendees === null ? null : attendees.map((a) => ({ ...a, party_id: a.party_id ?? null })) },
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data, warnings: outcome.warnings ?? [] })
  },
  { requireWrite: true },
)

/** DELETE /api/bolaget/meetings/{id}: delete a draft meeting. Held and signed minutes are kept. */
export const DELETE = withRouteContext<Params>(
  'bolaget.meeting_delete',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const gate = await bolagetGateResponse(ctx)
    if (gate) return gate
    const outcome = await deleteMeeting(operationContext(ctx), id)
    if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
