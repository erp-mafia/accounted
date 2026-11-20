import { NextResponse } from 'next/server'
import { withServiceCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { sandboxTeardownOutcome, type SandboxCleanupFailure } from '@/lib/sandbox/cleanup-failure'

/**
 * GET /api/sandbox/cleanup/cron: daily 04:00 UTC.
 * Removes expired sandbox users (>24h old).
 *
 * Every PostgREST statement runs under authenticator's statement_timeout of
 * 8s, and a function-level SET statement_timeout does NOT lift it (the timer
 * arms when the top-level statement starts; verified empirically
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
 * that names the guard and the teardown statement. The run tells the two
 * kinds apart (sandboxTeardownOutcome): a refusal by design, a sandbox user
 * who also has data in a real company, is a user the cleanup must keep; it is
 * counted as `kept` and logged at info, since it comes back every night for
 * as long as the account lives. A teardown gap (a new RESTRICT foreign key)
 * is a failure and logs one error line per user.
 */
export const maxDuration = 300

const BATCH_LIMIT = 10
const MAX_BATCHES = 25
const TIME_BUDGET_MS = 240_000
// A run with more failures than this logs the first ones and counts the rest:
// they almost always share one reason.
const MAX_LOGGED_FAILURES = 20

const FAILURE_FIELDS = ['user_id', 'kind', 'sqlstate', 'message', 'table', 'constraint', 'context'] as const
type CleanupFailure = SandboxCleanupFailure

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
  const totals = { cleaned: 0, failed: 0, kept: 0, orphans_removed: 0, batches: 0 }
  const failures: CleanupFailure[] = []
  const kept: CleanupFailure[] = []
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

    // The RPC counts a user it refused by design among its failed ones; here
    // they are the users the cleanup keeps. A function from before the
    // failure reasons reports none, and every failed user stays a failure.
    const reported = readFailures(data)
    const keptNow = reported.filter((failure) => sandboxTeardownOutcome(failure) === 'kept')
    const keptCount = Math.min(keptNow.length, batch.failed)

    totals.cleaned += batch.cleaned
    totals.failed += batch.failed - keptCount
    totals.kept += keptCount
    totals.orphans_removed += batch.orphans_removed
    totals.batches += 1
    kept.push(...keptNow)
    failures.push(...reported.filter((failure) => sandboxTeardownOutcome(failure) === 'failed'))

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

  // Users kept on purpose: one info line, so the count and who they are stay
  // findable without drowning the error log every night.
  if (totals.kept > 0) {
    ctx.log.info('sandbox users kept: they have data in a real company', {
      kept: totals.kept,
      user_ids: kept.slice(0, MAX_LOGGED_FAILURES).flatMap((failure) => (failure.user_id ? [failure.user_id] : [])),
    })
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
