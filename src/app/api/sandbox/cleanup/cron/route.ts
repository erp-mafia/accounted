import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

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
 * stops when a batch attempts nothing (the backlog is empty) or the route's
 * time budget nears. Capacity per night is MAX_BATCHES * BATCH_LIMIT users;
 * the nightly intake is a small fraction of that.
 *
 * A user whose teardown fails keeps its place at the head of the queue, so
 * the RPC reports next_offset and the next batch starts after the failures
 * (migration 20260927220000). Before that, ten failing users filled every
 * batch and stopped the run after its first call: from 2026-09-23 the cron
 * removed nothing while the backlog grew past a thousand.
 *
 * Each failure comes back with its reason (migration 20261109185036): the
 * SQLSTATE, the message, the table and constraint, and the error context
 * that names the guard and the teardown statement. The run logs one error
 * line per failed user, so a refusal by design (a sandbox user who also owns
 * a real company) and a teardown gap (a new RESTRICT foreign key) can be told
 * apart without the Postgres log.
 */
export const maxDuration = 300

const BATCH_LIMIT = 10
const MAX_BATCHES = 25
const TIME_BUDGET_MS = 240_000
// A run with more failures than this logs the first ones and counts the rest:
// they almost always share one reason.
const MAX_LOGGED_FAILURES = 20

const FAILURE_FIELDS = ['user_id', 'kind', 'sqlstate', 'message', 'table', 'constraint', 'context'] as const
type CleanupFailure = Partial<Record<(typeof FAILURE_FIELDS)[number], string>>

/** The `failures` the RPC reports, string fields only; absent before the migration. */
function readFailures(data: unknown): CleanupFailure[] {
  const list = typeof data === 'object' && data !== null ? (data as { failures?: unknown }).failures : undefined
  if (!Array.isArray(list)) return []
  return list.flatMap((item): CleanupFailure[] => {
    if (typeof item !== 'object' || item === null) return []
    const failure: CleanupFailure = {}
    for (const field of FAILURE_FIELDS) {
      const value = (item as Record<string, unknown>)[field]
      if (typeof value === 'string') failure[field] = value
    }
    return [failure]
  })
}

export const GET = withServiceCronContext('cron.sandbox_cleanup', async (_request, ctx) => {
  const supabase = ctx.supabase

  const started = Date.now()
  const totals = { cleaned: 0, failed: 0, orphans_removed: 0, batches: 0 }
  const failures: CleanupFailure[] = []
  // Failed users stay at the head of the queue; skip past them. Sent only
  // once the RPC has reported one, so a deploy that lands before the
  // migration keeps calling the two-argument function.
  let offset = 0

  for (let i = 0; i < MAX_BATCHES; i++) {
    if (Date.now() - started > TIME_BUDGET_MS) break

    const { data, error } = await supabase.rpc('cleanup_expired_sandbox_users', {
      p_max_age_hours: 24,
      p_limit: BATCH_LIMIT,
      ...(offset > 0 ? { p_offset: offset } : {}),
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
    failures.push(...readFailures(data))

    const nextOffset = typeof data === 'object' && data !== null ? data.next_offset : undefined
    if (typeof nextOffset === 'number') {
      // Nothing attempted and no orphan removed: the backlog is empty.
      if (Number(data.attempted ?? 0) + batch.orphans_removed === 0) break
      offset = nextOffset
    } else if (batch.cleaned + batch.orphans_removed === 0) {
      // Pre-20260927220000 function: without an offset the next call would
      // pick the same failing users again.
      break
    }
  }

  // Per-user failures used to be swallowed as Postgres WARNINGs, which is how
  // the cleanup sat broken for months; surface them at error level instead,
  // each with the reason the teardown was refused.
  if (totals.failed > 0) {
    for (const failure of failures.slice(0, MAX_LOGGED_FAILURES)) {
      ctx.log.error('sandbox teardown failed', { failure })
    }
    ctx.log.error('sandbox cleanup completed with failures', {
      ...totals,
      failures_logged: Math.min(failures.length, MAX_LOGGED_FAILURES),
      failures_omitted: Math.max(failures.length - MAX_LOGGED_FAILURES, 0),
    })
  } else {
    ctx.log.info('sandbox cleanup summary', totals)
  }

  return NextResponse.json({ success: true, ...totals })
})
