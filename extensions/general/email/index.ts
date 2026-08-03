import { NextResponse } from 'next/server'
import type { Extension } from '@/lib/extensions/types'
import { registerEmailService } from '@/lib/email/service'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { ResendEmailService } from './lib/resend-service'
import {
  ResendDeliverySignatureError,
  isDeliveryWebhookConfigured,
  toDeliveryReport,
  verifyDeliveryWebhook,
} from './lib/delivery-webhook'

// Register the Resend implementation immediately when this extension is loaded
registerEmailService(new ResendEmailService())

const log = createLogger('email-delivery-webhook')

export const emailExtension: Extension = {
  id: 'email',
  name: 'E-post (Resend)',
  version: '1.0.0',

  apiRoutes: [
    // ── Resend delivery webhook (Svix-signed, no user auth) ──
    // Reports whether a sent invoice email actually arrived. Resend pushes
    // every event for the account to this endpoint, including mail that is not
    // a tracked invoice delivery: unmatched reports are acknowledged and
    // dropped so they are not retried forever.
    {
      method: 'POST',
      path: '/delivery-status',
      skipAuth: true,
      handler: async (request: Request) => {
        if (!isDeliveryWebhookConfigured()) {
          log.error('RESEND_DELIVERY_WEBHOOK_SECRET is not configured', undefined)
          return NextResponse.json({ error: 'Delivery webhook not configured' }, { status: 503 })
        }

        const rawBody = await request.text()

        let event
        try {
          event = verifyDeliveryWebhook(rawBody, request.headers)
        } catch (err) {
          if (err instanceof ResendDeliverySignatureError) {
            return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
          }
          log.error('delivery webhook verification failed', err)
          return NextResponse.json({ error: 'Verification failed' }, { status: 500 })
        }

        const report = toDeliveryReport(event)
        if (!report) {
          return NextResponse.json({ data: { applied: false, reason: 'ignored_event' } })
        }

        const { data, error } = await createServiceClientNoCookies().rpc(
          'apply_invoice_delivery_provider_event',
          {
            p_provider: 'resend',
            p_provider_message_id: report.providerMessageId,
            p_status: report.status,
            p_occurred_at: report.occurredAt,
            p_detail: report.detail,
            p_recipient_addresses: report.recipients,
          },
        )

        // A failed apply must not be acknowledged: Svix retries non-2xx with
        // backoff, which is exactly the recovery wanted for a transient
        // database error.
        if (error) {
          log.error('failed to apply delivery status', error, { status: report.status })
          return NextResponse.json({ error: 'Failed to record delivery status' }, { status: 500 })
        }

        if (!data) {
          return NextResponse.json({ data: { applied: false, reason: 'no_matching_delivery' } })
        }

        log.info('delivery status applied', { deliveryId: data, status: report.status })
        return NextResponse.json({ data: { applied: true } })
      },
    },
  ],
}
