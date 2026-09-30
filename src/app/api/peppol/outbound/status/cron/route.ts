import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { ensureInitialized } from '@/lib/init'
import { pollOpenPeppolDeliveries } from '@/lib/invoices/peppol-delivery-sync'
import { runPeppolHealthCheck, type PeppolHealthSummary } from '@/lib/invoices/peppol-health'
import {
  getPeppolTransport,
  getPeppolTransportAvailability,
} from '@/lib/invoices/peppol-transport'

ensureInitialized()

export const maxDuration = 300

/**
 * GET /api/peppol/outbound/status/cron: four times an hour.
 *
 * Asks the Access Point about every open outbound delivery and records what
 * it says through the same append-only lifecycle a webhook uses. Needed
 * because Qvalia's webhooks are not available on its production host yet, and
 * kept afterwards as the safety net for a missed webhook.
 *
 * Then the Peppol health check (lib/invoices/peppol-health.ts) mails the
 * sender of a failed invoice and the team about new failed, stuck and
 * unrouted documents. It runs after the poll so a failure the poll just
 * recorded is reported in the same run, and in its own try/catch: a broken
 * alert must never fail the poll.
 */
export const GET = withCronContext('cron.peppol_outbound_status', async (_request, ctx) => {
  const availability = getPeppolTransportAvailability()
  const transport = availability.available ? getPeppolTransport(availability.provider) : null
  if (!transport) {
    return NextResponse.json({ data: { skipped: true, reason: availability.available ? 'provider_adapter_unavailable' : availability.reason } })
  }
  if (!transport.pollDeliveryStatus) {
    return NextResponse.json({ data: { skipped: true, reason: 'polling_unsupported' } })
  }

  const service = createServiceClientNoCookies()
  const summary = await pollOpenPeppolDeliveries({
    service,
    transport,
    log: ctx.log,
  })

  let health: PeppolHealthSummary | { failed: true }
  try {
    health = await runPeppolHealthCheck(service, { log: ctx.log })
  } catch (err) {
    ctx.log.error('peppol health check failed', err as Error, { alert: true })
    health = { failed: true }
  }

  ctx.log.info('peppol outbound status poll complete', { ...summary, errors: summary.errors.length, health })
  return NextResponse.json({ data: { ...summary, health } })
})

export const POST = GET
