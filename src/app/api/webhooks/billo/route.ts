import { after, NextResponse } from 'next/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { parseBilloWebhook } from '@/lib/digital-mailboxes/billo'
import { findReceivingConnection } from '@/lib/digital-mailboxes/connections'
import { getDigitalMailboxProviders } from '@/lib/digital-mailboxes/providers'
import { deliverMailboxDocument, resolveInboxOwner } from '@/lib/digital-mailboxes/receive'
import { verifyStandardWebhookSignature } from '@/lib/email/standard-webhook'
import { createLogger } from '@/lib/logger'

const log = createLogger('digital-mailboxes.billo.webhook')

export const maxDuration = 60

/**
 * POST /api/webhooks/billo: Billo Mailbox API callbacks.
 *
 * No session: authenticity is the Standard Webhooks signature (webhook-id,
 * webhook-timestamp, webhook-signature) with the secret our webhook was
 * registered with (BILLO_WEBHOOK_SECRET), over the raw body.
 *
 * Only PartnerDocumentReceived is acted on: the document is filed after the
 * response (Billo retries five times over six hours, so the answer stays
 * quick). The older snake_case body names the document but not its
 * enrolment, so it is left to the cron sweep, as is any failure here; the
 * arrival keeps a document from being filed twice.
 */
export async function POST(request: Request) {
  const billo = getDigitalMailboxProviders().billo
  const secret = billo?.config.webhookSecret
  if (!billo?.receiver || !secret) {
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 })
  }

  const payload = await request.text()
  const verified = verifyStandardWebhookSignature({
    secret,
    payload,
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
  })
  if (!verified) {
    log.warn('billo webhook signature refused')
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let event
  try {
    event = parseBilloWebhook(request.headers.get('x-billo-event-type'), payload)
  } catch (err) {
    log.warn('billo webhook body refused', { reason: err instanceof Error ? err.message : String(err) })
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 })
  }
  if (event.eventType !== 'PartnerDocumentReceived' || !event.documentId) {
    return NextResponse.json({ data: { ignored: true } })
  }
  if (!event.enrollmentId) {
    log.info('billo document event without its enrolment; the sweep files it')
    return NextResponse.json({ data: { routed: false } })
  }

  const service = createServiceClientNoCookies()
  const connection = await findReceivingConnection(service, 'billo', { mailboxRef: event.enrollmentId })
  if (!connection || connection.receive_state !== 'active') {
    log.info('billo document for no active connection')
    return NextResponse.json({ data: { routed: false } })
  }
  const receiver = billo.receiver
  const documentId = event.documentId
  after(async () => {
    try {
      const ownerId = await resolveInboxOwner(service, connection)
      if (!ownerId) return
      const outcome = await deliverMailboxDocument(service, {
        connection,
        receiver,
        ref: documentId,
        ownerId,
        actor: { type: 'webhook', label: 'Billo' },
        log,
      })
      log.info('billo document filed', { companyId: connection.company_id, outcome })
    } catch (err) {
      log.warn('billo document not filed; the sweep retries', {
        companyId: connection.company_id,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  })
  return NextResponse.json({ data: { routed: true } })
}
