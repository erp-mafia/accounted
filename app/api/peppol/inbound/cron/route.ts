import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { ensureInitialized } from '@/lib/init'
import {
  reprocessInboundPeppolDocuments,
  syncInboundPeppolDocuments,
} from '@/lib/invoices/peppol-inbound'
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
 * After the listing, a bounded reprocessing pass revisits what the archive
 * still holds pending (missing XML, unrouted, failed) regardless of whether
 * the provider still lists it. Retryable problems in that pass page once per
 * run; terminal ones are recorded on the row and never retried.
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
  const deliver = (delivery: Parameters<typeof deliverPeppolDocumentToInbox>[1]) =>
    deliverPeppolDocumentToInbox(service, delivery)
  const summary = await syncInboundPeppolDocuments({ service, transport, deliver, log: ctx.log })
  ctx.log.info('peppol inbound sync complete', { ...summary, errors: summary.errors.length })

  const reprocess = await reprocessInboundPeppolDocuments({ service, transport, deliver, log: ctx.log })
  ctx.log.info('peppol inbound reprocess complete', { ...reprocess, errors: reprocess.errors.length })
  if (reprocess.errors.length > 0) {
    ctx.log.warn('peppol inbound reprocess left retryable errors', {
      ids: reprocess.errors.map((e) => e.id),
      errors: reprocess.errors,
    })
    ctx.log.error('peppol inbound reprocess had errors', {
      alert: true,
      errorCount: reprocess.errors.length,
      ids: reprocess.errors.map((e) => e.id),
    })
  }
  return NextResponse.json({ data: { ...summary, reprocess } })
})

export const POST = GET
