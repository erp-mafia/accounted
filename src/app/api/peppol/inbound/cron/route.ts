import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import type { Logger } from '@/lib/logger'
import {
  reprocessInboundPeppolDocuments,
  syncInboundPeppolDocuments,
} from '@/lib/invoices/peppol-inbound'
import { deliverPeppolDocumentToInbox } from '@/lib/invoices/peppol-inbox-delivery'
import {
  registerGrantedPeppolReceivers,
  withdrawRevokedPeppolRegistrations,
} from '@/lib/invoices/peppol-registration'
import { proposeBankMatchForInboxItem } from '@/lib/operations/inbox-bank-match'
import {
  getPeppolTransport,
  getPeppolTransportAvailability,
} from '@/lib/invoices/peppol-transport'

export const maxDuration = 300

/**
 * The cron cannot receive in this environment. Whether that loses anything
 * depends on the companies that have receiving switched on (the rows
 * registerGrantedPeppolReceivers publishes): count them, and report an error
 * when there are any (accounted#115).
 */
async function reportSkipped(log: Logger, reason: string): Promise<void> {
  try {
    const { count, error } = await createServiceClientNoCookies()
      .from('peppol_access')
      .select('company_id', { count: 'exact', head: true })
      .eq('status', 'enabled')
      .eq('receive_enabled', true)
    if (error) throw new Error(error.message)
    if (count) {
      log.error('peppol inbound skipped while companies have receiving on; their e-invoices are not fetched', {
        alert: true,
        reason,
        receivers: count,
      })
    } else {
      log.info('peppol inbound skipped; no company has receiving on', { reason })
    }
  } catch (err) {
    log.error('peppol inbound skipped, and the companies with receiving on could not be counted', err as Error, {
      alert: true,
      reason,
    })
  }
}

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
 * the provider still lists it. One page per run, and only for what needs a
 * person: documents that became terminal in this run (never retried again,
 * and a received e-invoice under seven-year retention) and real processing
 * failures. Transport hiccups, XML misses under budget and held documents
 * are logged at warn and retried after the backoff.
 *
 * First, the identifier of every company whose access no longer allows
 * receiving is withdrawn from the SMP (revoking access only changes our row),
 * and the identifier of every company newly allowed to receive is published,
 * a few per run (granting access only changes our row too). Each in its own
 * try/catch: neither may ever stop the inbound sync.
 *
 * Truthful no-op when no access point is switched on in this environment,
 * and it says so: an error when companies have receiving switched on (their
 * e-invoices are not being fetched), an info line when none has.
 */
export const GET = withCronContext('cron.peppol_inbound', async (_request, ctx) => {
  const availability = await getPeppolTransportAvailability()
  const transport = availability.available ? await getPeppolTransport(availability.provider) : null
  if (!transport) {
    const reason = availability.available ? 'provider_adapter_unavailable' : availability.reason
    await reportSkipped(ctx.log, reason)
    return NextResponse.json({ data: { skipped: true, reason } })
  }
  if (!transport.listInboundDocuments) {
    await reportSkipped(ctx.log, 'receiving_unsupported')
    return NextResponse.json({ data: { skipped: true, reason: 'receiving_unsupported' } })
  }

  const service = createServiceClientNoCookies()
  let withdrawal: Awaited<ReturnType<typeof withdrawRevokedPeppolRegistrations>> | { failed: true }
  try {
    withdrawal = await withdrawRevokedPeppolRegistrations({ service, transport })
    if (withdrawal.withdrawn.length > 0) {
      ctx.log.info('peppol receiving withdrawn for revoked access', { companyIds: withdrawal.withdrawn })
    }
    if (withdrawal.failed.length > 0) {
      ctx.log.error('peppol receiving withdrawal failed, the identifiers stay published', {
        alert: true,
        failed: withdrawal.failed,
      })
    }
  } catch (err) {
    ctx.log.error('peppol receiving withdrawal failed', err as Error, { alert: true })
    withdrawal = { failed: true }
  }

  let registration: Awaited<ReturnType<typeof registerGrantedPeppolReceivers>> | { failed: true }
  try {
    registration = await registerGrantedPeppolReceivers({ service, transport })
    if (registration.registered.length > 0) {
      ctx.log.info('peppol receiving registered for granted access', { companyIds: registration.registered })
    }
    if (registration.failed.length > 0) {
      ctx.log.error('peppol receiving registration failed for granted access', {
        alert: true,
        failed: registration.failed,
      })
    }
  } catch (err) {
    ctx.log.error('peppol receiving registration failed', err as Error, { alert: true })
    registration = { failed: true }
  }

  // Each delivered e-invoice is checked against the bank at once (match on
  // arrival): a payment already in the bank becomes a proposal on the item.
  const deliver = async (delivery: Parameters<typeof deliverPeppolDocumentToInbox>[1]) => {
    const delivered = await deliverPeppolDocumentToInbox(service, delivery)
    if (delivered.inboxItemId) await proposeBankMatchForInboxItem(service, delivery.companyId, delivered.inboxItemId, ctx.log)
    return delivered
  }
  const summary = await syncInboundPeppolDocuments({ service, transport, deliver, log: ctx.log })
  ctx.log.info('peppol inbound sync complete', { ...summary, errors: summary.errors.length })

  const reprocess = await reprocessInboundPeppolDocuments({ service, transport, deliver, log: ctx.log })
  ctx.log.info('peppol inbound reprocess complete', {
    ...reprocess,
    terminalDocuments: reprocess.terminalDocuments.length,
    errors: reprocess.errors.length,
  })
  if (reprocess.errors.length > 0) {
    ctx.log.warn('peppol inbound reprocess left failures to retry', {
      ids: reprocess.errors.map((e) => e.id),
      errors: reprocess.errors,
    })
  }
  // One page per run for everything that needs a person, from both passes:
  // listing-sync failures (a listing that failed, a document that stopped
  // the type), reprocess failures, and documents that became terminal.
  const terminalDocuments = [...summary.terminalDocuments, ...reprocess.terminalDocuments]
  const failures = [
    ...summary.errors.map((e) => `sync ${e.providerDocumentId}: ${e.reason}`),
    ...reprocess.errors.map((e) => `reprocess ${e.id} (${e.providerDocumentId}): ${e.reason}`),
  ]
  if (failures.length > 0 || terminalDocuments.length > 0) {
    ctx.log.error('peppol inbound needs an operator', {
      alert: true,
      errorCount: failures.length,
      syncErrorProviderDocumentIds: summary.errors.map((e) => e.providerDocumentId),
      reprocessErrorIds: reprocess.errors.map((e) => e.id),
      errorReasons: failures,
      terminalCount: terminalDocuments.length,
      terminalProviderDocumentIds: terminalDocuments.map((d) => d.providerDocumentId),
      terminalReasons: terminalDocuments.map((d) => `${d.providerDocumentId}: ${d.reason}`),
    })
  }
  return NextResponse.json({ data: { ...summary, reprocess, withdrawal, registration } })
})

export const POST = GET
