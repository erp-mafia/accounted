import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { isOutboxNotDeployed } from '@/lib/events/outbox-dispatcher'

/**
 * GET /api/events/cleanup/cron: daily 02:00 UTC.
 *
 * Differentiated retention:
 * - Delivery events (invoice.created, transaction.synced, …): 30 days. They
 *   exist for external automation polling (n8n/Make/Zapier) and go stale fast.
 * - Agent telemetry (mcp.*, agent.*): 180 days. Error-rate trends and
 *   skill-load correlation need more than one month of signal: a 30-day
 *   window made it impossible to tell whether a tool or skill change actually
 *   moved failure rates.
 *
 * Retention is declared in the record of processing activities (id: mcp.telemetry).
 *
 * The steps are independent, so one failing does not stop the others, and the
 * run answers with an error when any of them failed:
 * 1. Roll whole days of telemetry into anonymous daily counts that are kept
 *    (rollup_agent_telemetry, ropa id mcp.telemetry_rollup). First, so
 *    nothing before it can keep a day from being counted.
 * 2. Delivery events past 30 days (prune_delivery_events, which never reads
 *    the telemetry rows).
 * 3. Everything past 180 days, only when step 1 succeeded: a telemetry day is
 *    never purged before it is counted.
 * 4. The event outbox (event_outbox, event_deliveries): finished events after
 *    7 days, events with a dead delivery after 30 (prune_event_outbox, whose
 *    defaults hold that rule; the run passes only the batch size). Batches
 *    until one comes back short: one call a night deleted 10 000 events while
 *    up to 34 000 a day arrived, so the retention fell further behind every
 *    day (crm#2141).
 *
 * Time: a rollup call may run 30 s (pre_request_statement_timeout), every
 * other call 8 s, so seven slow rollups, ten slow delivery batches, the purge
 * and twenty slow outbox batches add up to far more than the route's limit
 * (300 s, declared by the route). No call is started after
 * TIME_BUDGET_MS (250 s + one 30 s call = 280 s); what was not started is
 * named in `deferred`, logged as an error and done by the next night's run,
 * which starts from the same cutoffs.
 */
const TIME_BUDGET_MS = 250_000
const DELIVERY_RETENTION_DAYS = 30
const TELEMETRY_RETENTION_DAYS = 180
const ROLLUP_MAX_CALLS = 7
const DELIVERY_BATCH = 20_000
const DELIVERY_MAX_BATCHES = 10
/** prune_event_outbox's own default: the batch one call a night has deleted inside its 8 s since the outbox shipped. */
const OUTBOX_BATCH = 10_000
/** At most 200 000 events a night, six times the busiest day so far (33 567 events on 2026-11-20). */
const OUTBOX_MAX_BATCHES = 20

/** The limit these runs already had as the platform default, now declared: a scheduled route states its own (scripts/generate-crontabs.ts). */
export const maxDuration = 300

export const GET = withCronContext('cron.events_cleanup', async (_request, ctx) => {
  const supabase = createServiceClient()

  const deliveryCutoff = new Date()
  deliveryCutoff.setDate(deliveryCutoff.getDate() - DELIVERY_RETENTION_DAYS)
  const telemetryCutoff = new Date()
  telemetryCutoff.setDate(telemetryCutoff.getDate() - TELEMETRY_RETENTION_DAYS)

  // 1. One day per call keeps each call inside its 30 s budget; the loop
  // catches up after missed nights. 181 days: the 180-day cutoff plus the day
  // the last purge may have cut into, which must not be rolled from a partial
  // set of rows.
  const rollupSince = new Date()
  rollupSince.setDate(rollupSince.getDate() - TELEMETRY_RETENTION_DAYS - 1)
  const deadline = ctx.startedAt + TIME_BUDGET_MS
  const deferred: string[] = []
  const outOfTime = (step: string): boolean => {
    if (Date.now() < deadline) return false
    if (!deferred.includes(step)) deferred.push(step)
    return true
  }

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

  // 2. Batches until one comes back short.
  let deletedDelivery = 0
  let deliveryError: unknown = null
  for (let batch = 0; batch < DELIVERY_MAX_BATCHES; batch++) {
    if (outOfTime('delivery_prune')) break
    const { data: pruned, error } = await supabase.rpc('prune_delivery_events', {
      p_before: deliveryCutoff.toISOString(),
      p_limit: DELIVERY_BATCH,
    })
    if (error) {
      deliveryError = error
      ctx.log.error('event log delivery cleanup failed', error)
      break
    }
    const n = typeof pruned === 'number' ? pruned : 0
    deletedDelivery += n
    if (n < DELIVERY_BATCH) break
  }

  // 3. Everything past 180 days, catches the telemetry rows step 2 skipped.
  let deletedTelemetry = 0
  let telemetryError: unknown = null
  // A rollup cut short by the clock skips the purge like a failed one: a
  // telemetry day is never purged before it is counted.
  if (!rollupError && !deferred.includes('rollup') && !outOfTime('telemetry_purge')) {
    const { error, count } = await supabase
      .from('event_log')
      .delete({ count: 'exact' })
      .lt('created_at', telemetryCutoff.toISOString())
    if (error) {
      telemetryError = error
      ctx.log.error('event log telemetry cleanup failed', error)
    } else {
      deletedTelemetry = count ?? 0
    }
  }

  const deleted = deletedDelivery + deletedTelemetry
  ctx.log.info('event log cleanup summary', {
    deleted,
    deletedDelivery,
    deletedTelemetry,
    rolledUpDays,
    deliveryCutoff: deliveryCutoff.toISOString(),
    telemetryCutoff: telemetryCutoff.toISOString(),
  })

  // 4. The event outbox, whatever EVENT_OUTBOX_MODE is: rows written while
  // shadow mode was on must still age out after it is switched off (raw
  // payloads). With the mode never on it deletes nothing. Best effort: it
  // never fails the run, and a database the outbox migration has not reached
  // yet answers PGRST202, which is a skip. Batches until one comes back
  // short; a run that stops on a full batch leaves events past the retention
  // and says so.
  let prunedOutbox = 0
  let outboxBatches = 0
  let outboxLastFull = false
  for (let batch = 0; batch < OUTBOX_MAX_BATCHES; batch++) {
    if (outOfTime('outbox_prune')) break
    const { data: pruned, error: pruneError } = await supabase.rpc('prune_event_outbox', { p_limit: OUTBOX_BATCH })
    if (pruneError) {
      if (isOutboxNotDeployed(pruneError)) ctx.log.info('event outbox not deployed; prune skipped')
      else ctx.log.error('event outbox prune failed', pruneError)
      break
    }
    const n = typeof pruned === 'number' ? pruned : 0
    prunedOutbox += n
    outboxBatches++
    outboxLastFull = n >= OUTBOX_BATCH
    if (!outboxLastFull) break
  }
  ctx.log.info('event outbox prune summary', { prunedOutbox, batches: outboxBatches })
  // Every batch of the night came back full: there may be more past the
  // retention than one night deletes. A run cut short by the clock is named
  // in `deferred` instead.
  if (outboxBatches === OUTBOX_MAX_BATCHES && outboxLastFull) {
    ctx.log.error('event outbox prune stopped at its batch cap; events past the retention may wait for the next run', {
      prunedOutbox,
      batches: outboxBatches,
    })
  }

  if (deferred.length > 0) {
    ctx.log.error('event log cleanup ran out of time; the steps left wait for the next run', {
      deferred,
      durationMs: Date.now() - ctx.startedAt,
    })
  }

  const failure = rollupError ?? deliveryError ?? telemetryError
  if (failure) return errorResponse(failure, ctx.log, { requestId: ctx.requestId })

  return NextResponse.json({
    success: true,
    deleted,
    deletedDelivery,
    deletedTelemetry,
    rolledUpDays,
    prunedOutbox,
    ...(deferred.length > 0 ? { deferred } : {}),
  })
})
