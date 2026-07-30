/**
 * GET /api/webhooks/dispatch/cron: per-minute webhook delivery dispatcher.
 *
 * Picks up due deliveries (pending or retry-due failed) and POSTs them to
 * their configured receivers. Each cycle handles up to 50 deliveries; with
 * the per-minute cadence this gives 3000/h headroom before deliveries start
 * to backlog. Bumps to a higher batch size or moves to a queue worker
 * (Vercel Queues, on the post-Phase-6 roadmap) are the migration path.
 *
 * Authenticated via CRON_SECRET (Authorization: Bearer ...). The route
 * returns the dispatch summary in the response body so an operator can grep
 * Vercel logs to see how many succeeded / failed / went dead per tick.
 */

import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { dispatchDueDeliveries } from '@/lib/webhooks/dispatcher'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'

/**
 * Vercel function budget. Must stay comfortably above the dispatcher's own
 * CYCLE_BUDGET_MS (120 s, lib/webhooks/dispatcher.ts): the in-code budget is
 * what hands unattempted claims back before the loop ends, and it can only do
 * that if the platform has not already killed the invocation. Without this
 * export the route would run on the platform default, the budget check at
 * 110 s could never fire, and the 160 s stuck-recovery window would be derived
 * from a bound nothing enforces (#1257).
 *
 * Overlap with the per-minute schedule is expected and safe: claims are
 * FOR UPDATE SKIP LOCKED and every attempt re-checks ownership before POSTing.
 */
export const maxDuration = 300

export const GET = withCronContext('cron.webhook_dispatch', async (_request, ctx) => {
  const supabase = createServiceClientNoCookies()
  const summary = await dispatchDueDeliveries({ supabase })

  ctx.log.info('webhook dispatch cycle complete', {
    picked: summary.picked,
    delivered: summary.delivered,
    failed: summary.failed,
    dead: summary.dead,
    skipped: summary.skipped,
    released: summary.released,
    // The sweep's own outcome. recoveredDead > 0 means this tick took
    // deliveries to the terminal, immutable 'dead' state: alertable.
    recovered: summary.recovered,
    recoveredDead: summary.recoveredDead,
  })

  return NextResponse.json({ data: summary })
})
