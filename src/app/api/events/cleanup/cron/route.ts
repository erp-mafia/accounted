import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

/**
 * GET /api/events/cleanup/cron: daily 02:00 UTC.
 *
 * Event data is kept. Business events in event_log (invoice.created,
 * transaction.synced, …: what GET /api/events serves) and the event outbox
 * (event_outbox, event_deliveries) are never deleted here; their rows go only
 * with their company (ON DELETE CASCADE). prune_delivery_events and
 * prune_event_outbox, which this cron called until 2026-11-23, are left in
 * the database and nothing calls them.
 *
 * What can name a person stays in an event for 30 days: as long as the
 * webhooks retry it and GET /api/events serves it in full. Then the event
 * keeps its ids, dates, amounts, statuses and codes, and loses names, e-mail
 * addresses, addresses and other text (remove_event_personal_details; the
 * database defines both the 30 days and what stays).
 *
 * Agent telemetry (mcp.*, agent.*) is the one thing deleted. The privacy
 * policy (app/(public)/privacy) promises that API and agent call metadata is
 * kept 180 days and after that only as anonymous daily counts. Retention is
 * declared in the record of processing activities (id: mcp.telemetry).
 *
 * The steps:
 * 1. Take the personal details out of events past 30 days, a batch per call,
 *    until none is left (remove_event_personal_details).
 * 2. Roll whole days of telemetry into anonymous daily counts that are kept
 *    (rollup_agent_telemetry, ropa id mcp.telemetry_rollup).
 * 3. Delete telemetry past 180 days, only when step 2 succeeded: a telemetry
 *    day is never purged before it is counted. Nothing else is deleted.
 *
 * Time: a batch of step 1 takes about a second and may run 8 s, a rollup call
 * 30 s (pre_request_statement_timeout), a delete 8 s; a night's events take a
 * few batches. No call is started after TIME_BUDGET_MS (250 s + one 30 s call
 * = 280 s, inside the route's limit of 300 s, declared by the route); what
 * was not started is named in `deferred`, logged as an error and done by the
 * next night's run, which starts from the same cutoffs.
 */
const TIME_BUDGET_MS = 250_000
const TELEMETRY_RETENTION_DAYS = 180
const ROLLUP_MAX_CALLS = 7

/** Rows of each table one call of step 1 takes: about a second of work, far inside the 8 s statement timeout. */
const PERSONAL_DETAILS_BATCH = 2000

/** Calls of step 1 per run: a night's events take a few; the cap leaves the telemetry steps their time after missed nights. */
const PERSONAL_DETAILS_MAX_CALLS = 40

/**
 * The telemetry the purge deletes: the event types the rollup counts (mcp.*
 * and agent.*), one delete per prefix. `like` is the set itself. The range
 * around it is what lets the (event_type, created_at) index serve the delete:
 * under the database's collation (en_US.UTF-8) a LIKE alone cannot use that
 * index, and the planner would read through the business events kept beside
 * the telemetry, every one of them once they are older than the cutoff.
 * Every type that matches `like` sorts inside [from, to).
 */
const TELEMETRY_PREFIXES = [
  { like: 'mcp.%', from: 'mcp', to: 'mcq' },
  { like: 'agent.%', from: 'agent', to: 'agenu' },
] as const

/** The limit these runs already had as the platform default, now declared: a scheduled route states its own (scripts/generate-crontabs.ts). */
export const maxDuration = 300

export const GET = withCronContext('cron.events_cleanup', async (_request, ctx) => {
  const supabase = createServiceClient()

  const telemetryCutoff = new Date()
  telemetryCutoff.setDate(telemetryCutoff.getDate() - TELEMETRY_RETENTION_DAYS)

  const deadline = ctx.startedAt + TIME_BUDGET_MS
  const deferred: string[] = []
  const outOfTime = (step: string): boolean => {
    if (Date.now() < deadline) return false
    if (!deferred.includes(step)) deferred.push(step)
    return true
  }

  // 1. A call does one batch of each table and returns the rows it changed;
  // 0 means none is left. A failed call ends the step: the next night starts
  // where this one stopped. Independent of the telemetry steps.
  let removedPersonalDetails = 0
  let personalDetailsError: unknown = null
  for (let call = 0; ; call++) {
    if (call === PERSONAL_DETAILS_MAX_CALLS) {
      deferred.push('personal_details')
      break
    }
    if (outOfTime('personal_details')) break
    const { data: removed, error } = await supabase.rpc('remove_event_personal_details', {
      p_limit: PERSONAL_DETAILS_BATCH,
    })
    if (error) {
      personalDetailsError = error
      ctx.log.error('removing personal details from events failed', error)
      break
    }
    const n = typeof removed === 'number' ? removed : 0
    removedPersonalDetails += n
    if (n === 0) break
  }

  // 2. One day per call keeps each call inside its 30 s budget; the loop
  // catches up after missed nights. 181 days: the 180-day cutoff plus the day
  // the last purge may have cut into, which must not be rolled from a partial
  // set of rows.
  const rollupSince = new Date()
  rollupSince.setDate(rollupSince.getDate() - TELEMETRY_RETENTION_DAYS - 1)

  let rolledUpDays = 0
  let rollupError: unknown = null
  for (let call = 0; call < ROLLUP_MAX_CALLS; call++) {
    if (outOfTime('rollup')) break
    const { data: rolled, error } = await supabase.rpc('rollup_agent_telemetry', {
      p_since: rollupSince.toISOString(),
      p_max_days: 1,
    })
    if (error) {
      rollupError = error
      ctx.log.error('agent telemetry rollup failed; telemetry purge skipped', error)
      break
    }
    const n = typeof rolled === 'number' ? rolled : 0
    rolledUpDays += n
    if (n === 0) break
  }

  // 3. Telemetry past 180 days, and nothing else. A rollup cut short by the
  // clock skips the purge like a failed one: a telemetry day is never purged
  // before it is counted. The prefixes are independent: one failing does not
  // stop the other.
  let deletedTelemetry = 0
  let telemetryError: unknown = null
  if (!rollupError && !deferred.includes('rollup')) {
    for (const prefix of TELEMETRY_PREFIXES) {
      if (outOfTime('telemetry_purge')) break
      const { error, count } = await supabase
        .from('event_log')
        .delete({ count: 'exact' })
        .gte('event_type', prefix.from)
        .lt('event_type', prefix.to)
        .like('event_type', prefix.like)
        .lt('created_at', telemetryCutoff.toISOString())
      if (error) {
        telemetryError ??= error
        ctx.log.error('event log telemetry cleanup failed', error, { prefix: prefix.like })
        continue
      }
      deletedTelemetry += count ?? 0
    }
  }

  ctx.log.info('event log cleanup summary', {
    removedPersonalDetails,
    deletedTelemetry,
    rolledUpDays,
    telemetryCutoff: telemetryCutoff.toISOString(),
  })

  if (deferred.length > 0) {
    ctx.log.error('event log cleanup ran out of time; the steps left wait for the next run', {
      deferred,
      durationMs: Date.now() - ctx.startedAt,
    })
  }

  const failure = personalDetailsError ?? rollupError ?? telemetryError
  if (failure) return errorResponse(failure, ctx.log, { requestId: ctx.requestId })

  return NextResponse.json({
    success: true,
    removedPersonalDetails,
    deletedTelemetry,
    rolledUpDays,
    ...(deferred.length > 0 ? { deferred } : {}),
  })
})
