import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

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

  return NextResponse.json({ success: true, deleted, deletedDelivery, deletedTelemetry })
})
