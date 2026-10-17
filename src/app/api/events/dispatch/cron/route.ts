/**
 * GET /api/events/dispatch/cron: per-minute event outbox dispatcher.
 *
 * Claims due deliveries from event_deliveries and finishes them
 * (lib/events/outbox-dispatcher.ts). Step E2, shadow mode: every consumer
 * still runs inline in the request that emitted the event, so the cycle marks
 * each claimed delivery done without calling any handler. With
 * EVENT_OUTBOX_MODE off (the default) it answers at once and touches nothing.
 *
 * Authenticated via CRON_SECRET (withCronContext). Overlap with the kick an
 * emit schedules, or with a slow previous tick, is safe: claims are FOR
 * UPDATE SKIP LOCKED and a finish only lands with the claim's attempt.
 */

import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { eventOutboxMode } from '@/lib/events/consumer-index'
import { dispatchEventOutbox } from '@/lib/events/outbox-dispatcher'

/** Above the dispatcher's DISPATCH_BUDGET_MS (25 s), so its budget check is what ends a cycle. */
export const maxDuration = 60

export const GET = withCronContext('cron.event_outbox_dispatch', async (_request, ctx) => {
  const mode = eventOutboxMode()
  if (mode === 'off') {
    return NextResponse.json({ data: { mode, skipped: true } })
  }

  const summary = await dispatchEventOutbox({ supabase: createServiceClientNoCookies() })

  ctx.log.info('event outbox dispatch cycle complete', {
    mode: summary.mode,
    batches: summary.batches,
    claimed: summary.claimed,
    completed: summary.completed,
    oldestAgeMs: summary.oldestAgeMs,
    notDeployed: summary.notDeployed,
  })

  return NextResponse.json({ data: summary })
})
