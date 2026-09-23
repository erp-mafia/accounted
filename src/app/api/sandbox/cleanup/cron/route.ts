import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET /api/sandbox/cleanup/cron: daily 04:00 UTC.
 * Removes expired sandbox users (>24h old).
 *
 * Every PostgREST statement runs under authenticator's statement_timeout of
 * 8s, and a function-level SET statement_timeout does NOT lift it (the timer
 * arms when the top-level statement starts; verified empirically on prod
 * 2026-08-07, same finding as the SIE import RPCs). One teardown costs
 * ~220ms with the account_id index, so the run loops SMALL batches: each
 * rpc() call is its own statement with its own 8s window, and the loop
 * stops when a batch makes no progress (nothing left, or only failing
 * users remain) or the route's time budget nears. Capacity per night is
 * MAX_BATCHES * BATCH_LIMIT users; the nightly intake is a small fraction
 * of that.
 */
export const maxDuration = 300

const BATCH_LIMIT = 10
const MAX_BATCHES = 25
const TIME_BUDGET_MS = 240_000

export const GET = withCronContext('cron.sandbox_cleanup', async (_request, ctx) => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      details: { reason: 'Missing Supabase configuration' },
    })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  const started = Date.now()
  const totals = { cleaned: 0, failed: 0, orphans_removed: 0, batches: 0 }

  for (let i = 0; i < MAX_BATCHES; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) break

    const { data, error } = await supabase.rpc('cleanup_expired_sandbox_users', {
      p_max_age_hours: 24,
      p_limit: BATCH_LIMIT,
    })

    if (error) {
      ctx.log.error('sandbox cleanup rpc failed', { error, ...totals })
      return errorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    // Migration 20260807130000 changed the RPC's return from a bare integer
    // to a {cleaned, failed, orphans_removed} summary; accept both shapes so
    // deploy/migration ordering cannot break the cron.
    const batch =
      typeof data === 'number'
        ? { cleaned: data, failed: 0, orphans_removed: 0 }
        : {
            cleaned: Number(data?.cleaned ?? 0),
            failed: Number(data?.failed ?? 0),
            orphans_removed: Number(data?.orphans_removed ?? 0),
          }

    totals.cleaned += batch.cleaned
    totals.failed += batch.failed
    totals.orphans_removed += batch.orphans_removed
    totals.batches += 1

    // No progress means only permanently-failing users (retried nightly and
    // reported below) or an empty backlog: looping further would spin on the
    // same rows.
    if (batch.cleaned + batch.orphans_removed === 0) break
  }

  // Per-user failures used to be swallowed as Postgres WARNINGs, which is how
  // the cleanup sat broken for months; surface them at error level instead.
  if (totals.failed > 0) {
    ctx.log.error('sandbox cleanup completed with failures', totals)
  } else {
    ctx.log.info('sandbox cleanup summary', totals)
  }

  return NextResponse.json({ success: true, ...totals })
})
