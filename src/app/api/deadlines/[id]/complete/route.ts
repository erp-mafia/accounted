import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { sessionFailureResponse } from '@/lib/operations/session'
import { setDeadlineCompletion } from '@/lib/deadlines/completion'

// Strict: `is_completed` must be a genuine boolean or absent. The hand-rolled
// parser this replaces silently degraded { is_completed: "false" } (a string)
// to a toggle: the exact hazard the explicit-state contract was built to
// remove, since a truthy-string undo could re-complete the row it meant to
// un-tick. Wrong types are a 400 now, never a guess.
const CompleteDeadlineSchema = z
  .object({
    is_completed: z.boolean().optional(),
  })
  .strict()

/**
 * POST /api/deadlines/[id]/complete
 * Set the completion status of a deadline.
 *
 * The body is optional. When it carries a boolean `is_completed` the route sets
 * exactly that state; a caller that sends no body (or `{}`) keeps the original
 * toggle behaviour. A body that IS present but malformed (wrong type, unknown
 * keys, broken JSON) is rejected with 400 instead of being reinterpreted.
 *
 * Honouring an explicit state is what makes the "Ångra" affordance an undo
 * rather than a second toggle: the click has to be idempotent, because the row
 * can already have been un-ticked in another tab or by an MCP agent between the
 * toast appearing and the click landing, and a blind toggle would then
 * re-complete a Skatteverket deadline the user was trying to put back on the
 * list. It also makes the caller's own confirmation truthful: the client picks
 * its toast from the state it asked for, so the server must not silently
 * persist the opposite. An explicit state the deadline already has writes
 * nothing, so completed_at keeps the moment it was first ticked off.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'deadline.toggle_complete',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    // Absent/empty body = toggle (the pre-explicit-state ergonomics); anything
    // else must validate. The raw text is read first because validateBody
    // treats an empty body as invalid JSON, which would 400 the plain toggle.
    const raw = (await request.text()).trim()
    let requestedState: boolean | null = null
    if (raw !== '') {
      const validation = await validateBody(
        new Request(request.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: raw,
        }),
        CompleteDeadlineSchema,
      )
      if (!validation.success) return validation.response
      requestedState = validation.data.is_completed ?? null
    }

    // The rule (which deadline, which state, what is written) is
    // lib/deadlines/completion.ts, shared with gnubok_complete_deadline.
    const outcome = await setDeadlineCompletion(
      { supabase, companyId },
      { deadlineId: id, isCompleted: requestedState ?? undefined },
      { dryRun: false },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data.deadline })
  },
  { requireWrite: true },
)
