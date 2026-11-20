import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { loadAutomaticReminderState, setAutomaticReminders } from '@/lib/reminders/automatic'
import { createServiceClient } from '@/lib/supabase/server'

const BodySchema = z.object({ enabled: z.boolean() })

/**
 * GET /api/reminders/automatic: whether the active company's reminders send
 * themselves, and whether it may be offered (three clean batches in a row).
 */
export const GET = withRouteContext('reminders.automatic_state', async (_request, { companyId }) => {
  return NextResponse.json({ data: await loadAutomaticReminderState(createServiceClient(), companyId) })
})

/**
 * POST /api/reminders/automatic: let each day's reminders go out without
 * approval when their bank check passed, or go back to approving every
 * batch. Turning it on needs reminders on and the last three batches
 * approved without changes (lib/reminders/automatic.ts); turning it off
 * always works. Owner or administrator only, like approving a batch: the
 * column is written with the service role (migration 20261027120300 keeps
 * members' own writes off it).
 */
export const POST = withRouteContext(
  'reminders.automatic',
  async (request, { companyId, user, log, requestId }) => {
    const body = await validateBody(request, BodySchema, { log, operation: 'reminders.automatic' })
    if (!body.success) return body.response
    const outcome = await setAutomaticReminders(createServiceClient(), {
      companyId,
      enabled: body.data.enabled,
      userId: user.id,
      now: new Date(),
    })
    if (!outcome.ok) return errorResponseFromCode(outcome.code, log, { requestId })
    log.info('automatic reminders changed', { enabled: body.data.enabled })
    return NextResponse.json({ data: outcome.state })
  },
  { requireAdmin: true },
)
