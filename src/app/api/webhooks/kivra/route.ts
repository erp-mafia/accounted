import { after, NextResponse } from 'next/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { onKivraIntegrationCreated, onKivraIntegrationDeleted } from '@/lib/digital-mailboxes/connect'
import { findReceivingConnection } from '@/lib/digital-mailboxes/connections'
import { parseKivraWebhook, verifyKivraWebhookSignature } from '@/lib/digital-mailboxes/kivra'
import { getDigitalMailboxProviders } from '@/lib/digital-mailboxes/providers'
import { deliverMailboxDocument, resolveInboxOwner } from '@/lib/digital-mailboxes/receive'
import { createLogger } from '@/lib/logger'

const log = createLogger('digital-mailboxes.kivra.webhook')

export const maxDuration = 60

/**
 * POST /api/webhooks/kivra: Kivra Partner API events.
 *
 * No session: authenticity is the signature (X-KIVRA-TIMESTAMP and
 * X-KIVRA-SIGNATURE: v1=<hex HMAC-SHA256 of "<t>:<raw body>"> with the
 * secret Kivra shared, KIVRA_WEBHOOK_SECRET), over the raw bytes, with a
 * five-minute replay window.
 *
 *   integration.created  the company activated Accounted: bind it
 *   integration.deleted  the company switched Accounted off: stop reading
 *   content.created      a new content: file it (after the answer)
 *
 * Kivra wants a quick 200 and retries anything else for a long time, so
 * the content is fetched after the response (next/server after()); a
 * failure there is caught by the cron sweep, which files every content the
 * arrivals do not yet record. Redeliveries are harmless for the same reason.
 */
export async function POST(request: Request) {
  const kivra = getDigitalMailboxProviders().kivra
  const secret = kivra?.config.webhookSecret
  if (!kivra?.receiver || !secret) {
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 })
  }

  const payload = await request.text()
  const signatures: string[] = []
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'x-kivra-signature') signatures.push(value)
  })
  if (
    !verifyKivraWebhookSignature({
      secret,
      payload,
      timestamp: request.headers.get('x-kivra-timestamp'),
      signatures,
    })
  ) {
    log.warn('kivra webhook signature refused')
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let event
  try {
    event = parseKivraWebhook(payload)
  } catch (err) {
    log.warn('kivra webhook body refused', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  }
  if (!event) return NextResponse.json({ data: { ignored: true } })

  const service = createServiceClientNoCookies()
  if (event.type === 'integration.created') {
    const companyId = await onKivraIntegrationCreated(service, event, log)
    log.info('kivra integration created', { eventId: event.id, companyId })
    return NextResponse.json({ data: { bound: companyId !== null } })
  }
  if (event.type === 'integration.deleted') {
    const ended = await onKivraIntegrationDeleted(service, event.companyKey)
    log.info('kivra integration deleted', { eventId: event.id, ended })
    return NextResponse.json({ data: { ended } })
  }

  // content.created
  const contentKey = event.contentKey
  const connection = await findReceivingConnection(service, 'kivra', { accountRef: event.companyKey })
  if (!connection || connection.receive_state !== 'active' || !contentKey) {
    log.info('kivra content for no active connection', { eventId: event.id })
    return NextResponse.json({ data: { routed: false } })
  }
  const receiver = kivra.receiver
  after(async () => {
    try {
      const ownerId = await resolveInboxOwner(service, connection)
      if (!ownerId) return
      const outcome = await deliverMailboxDocument(service, {
        connection,
        receiver,
        ref: contentKey,
        ownerId,
        actor: { type: 'webhook', label: 'Kivra' },
        log,
      })
      log.info('kivra content filed', { eventId: event.id, companyId: connection.company_id, outcome })
    } catch (err) {
      log.warn('kivra content not filed; the sweep retries', {
        eventId: event.id,
        companyId: connection.company_id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  })
  return NextResponse.json({ data: { routed: true } })
}
