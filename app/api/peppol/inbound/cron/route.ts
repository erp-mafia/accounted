import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { ensureInitialized } from '@/lib/init'
import { syncInboundPeppolDocuments } from '@/lib/invoices/peppol-inbound'
import { deliverPeppolDocumentToInbox } from '@/lib/invoices/peppol-inbox-delivery'
import {
  getPeppolTransport,
  getPeppolTransportAvailability,
} from '@/lib/invoices/peppol-transport'

ensureInitialized()

export const maxDuration = 300

/**
 * GET /api/peppol/inbound/cron: every 10 minutes.
 *
 * Pulls the documents the Access Point received for our registered
 * participants, archives the exact XML, routes each to its company and hands
 * it to the supplier-invoice inbox. One provider account carries every
 * company's identifier, so this is one poll for all of them; a document
 * nobody is registered for is kept as `unrouted`, never dropped.
 *
 * Truthful no-op when no access point is switched on in this environment.
 */
export const GET = withCronContext('cron.peppol_inbound', async (_request, ctx) => {
  const availability = getPeppolTransportAvailability()
  const transport = availability.available ? getPeppolTransport(availability.provider) : null
  if (!transport) {
    return NextResponse.json({ data: { skipped: true, reason: availability.available ? 'provider_adapter_unavailable' : availability.reason } })
  }
  if (!transport.listInboundDocuments) {
    return NextResponse.json({ data: { skipped: true, reason: 'receiving_unsupported' } })
  }

  const service = createServiceClientNoCookies()
  const summary = await syncInboundPeppolDocuments({
    service,
    transport,
    deliver: (delivery) => deliverPeppolDocumentToInbox(service, delivery),
    log: ctx.log,
  })
  ctx.log.info('peppol inbound sync complete', { ...summary, errors: summary.errors.length })
  return NextResponse.json({ data: summary })
})

export const POST = GET
