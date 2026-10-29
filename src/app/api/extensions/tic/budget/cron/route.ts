import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { readTicBudgetStatus } from '@/lib/tic-budget/status'

/**
 * GET /api/extensions/tic/budget/cron: daily 06:20 UTC, and the ops read of
 * the TIC Lens budget on demand (Authorization: Bearer $CRON_SECRET).
 *
 * Costs no Lens call: TIC's free /free/health endpoint for the quota TIC
 * counts, the external_call_budget rows for the calls we counted. Answers
 * both and their difference, and logs an alert when the quota runs low or
 * TIC counts noticeably more than we spent (another client of the proxy, or
 * a path around the budget: how the September quota went unexplained).
 */

/** Alert when TIC's remaining quota falls below this share of its limit. */
const LOW_REMAINING_SHARE = 0.1
/** Alert when TIC counts this many more calls than the budget did. */
const UNATTRIBUTED_ALERT = 100

export const GET = withServiceCronContext(
  'cron.tic_budget',
  async (_request, ctx) => {
    const status = await readTicBudgetStatus(ctx.supabase)
    const upstream = status.upstream

    if (upstream?.rateLimit && upstream.rateLimitRemaining != null) {
      if (upstream.rateLimitRemaining < upstream.rateLimit * LOW_REMAINING_SHARE) {
        ctx.log.warn('tic quota low', {
          alert: true,
          remaining: upstream.rateLimitRemaining,
          limit: upstream.rateLimit,
          reset: upstream.rateLimitReset,
        })
      }
    }
    if (status.unattributed != null && status.unattributed >= UNATTRIBUTED_ALERT) {
      ctx.log.warn('tic calls not counted by the budget', {
        alert: true,
        unattributed: status.unattributed,
        localTotal: status.local?.total ?? null,
      })
    }
    if (status.configured && !upstream) {
      ctx.log.warn('tic health endpoint unreadable')
    }

    ctx.log.info('tic budget status', {
      cycleStart: status.cycleStart,
      localTotal: status.local?.total ?? null,
      remaining: upstream?.rateLimitRemaining ?? null,
      unattributed: status.unattributed,
    })
    return NextResponse.json(status)
  },
  { requireExtension: 'tic' },
)
