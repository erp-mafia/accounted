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
 * Retention is declared in .compliance/ropa.yaml (id: mcp.telemetry).
 *
 * Then the event outbox (event_outbox, event_deliveries): finished events
 * after 7 days, events with a dead delivery after 30 (prune_event_outbox).
 */
const DELIVERY_RETENTION_DAYS = 30
const TELEMETRY_RETENTION_DAYS = 180

export const GET = withCronContext('cron.events_cleanup', async (_request, ctx) => {
  const supabase = createServiceClient()

  const deliveryCutoff = new Date()
  deliveryCutoff.setDate(deliveryCutoff.getDate() - DELIVERY_RETENTION_DAYS)
  const telemetryCutoff = new Date()
  telemetryCutoff.setDate(telemetryCutoff.getDate() - TELEMETRY_RETENTION_DAYS)

  // Pass 1: delivery events past 30 days. Telemetry (mcp.*, agent.*) is
  // excluded here and swept by the 180-day pass below.
  const { error: deliveryError, count: deliveryCount } = await supabase
    .from('event_log')
    .delete({ count: 'exact' })
    .lt('created_at', deliveryCutoff.toISOString())
    .not('event_type', 'like', 'mcp.%')
    .not('event_type', 'like', 'agent.%')

  if (deliveryError) {
    ctx.log.error('event log delivery cleanup failed', deliveryError)
    return errorResponse(deliveryError, ctx.log, { requestId: ctx.requestId })
  }

  // Pass 2: everything past 180 days, catches the telemetry rows pass 1 skipped.
  const { error: telemetryError, count: telemetryCount } = await supabase
    .from('event_log')
    .delete({ count: 'exact' })
    .lt('created_at', telemetryCutoff.toISOString())

  if (telemetryError) {
    ctx.log.error('event log telemetry cleanup failed', telemetryError)
    return errorResponse(telemetryError, ctx.log, { requestId: ctx.requestId })
  }

  const deletedDelivery = deliveryCount ?? 0
  const deletedTelemetry = telemetryCount ?? 0
  const deleted = deletedDelivery + deletedTelemetry
  ctx.log.info('event log cleanup summary', {
    deleted,
    deletedDelivery,
    deletedTelemetry,
    deliveryCutoff: deliveryCutoff.toISOString(),
    telemetryCutoff: telemetryCutoff.toISOString(),
  })

  // Pass 3: the event outbox, whatever EVENT_OUTBOX_MODE is: rows written
  // while shadow mode was on must still age out after it is switched off
  // (raw payloads). With the mode never on it deletes nothing. Best effort:
  // it never fails the event_log cleanup above, and a database the outbox
  // migration has not reached yet answers PGRST202, which is a skip.
  let prunedOutbox = 0
  const { data: pruned, error: pruneError } = await supabase.rpc('prune_event_outbox')
  if (pruneError) {
    if (isOutboxNotDeployed(pruneError)) ctx.log.info('event outbox not deployed; prune skipped')
    else ctx.log.error('event outbox prune failed', pruneError)
  } else {
    prunedOutbox = typeof pruned === 'number' ? pruned : 0
    ctx.log.info('event outbox prune summary', { prunedOutbox })
  }

  return NextResponse.json({ success: true, deleted, deletedDelivery, deletedTelemetry, prunedOutbox })
})
