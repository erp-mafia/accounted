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

export const GET = withCronContext('cron.webhook_dispatch', async (_request, ctx) => {
  const supabase = createServiceClientNoCookies()
  const summary = await dispatchDueDeliveries({ supabase })

  ctx.log.info('webhook dispatch cycle complete', {
    picked: summary.picked,
    delivered: summary.delivered,
    failed: summary.failed,
    dead: summary.dead,
  })

  return NextResponse.json({ data: summary })
})
