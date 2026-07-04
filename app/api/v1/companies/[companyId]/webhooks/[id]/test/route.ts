/**
 * /api/v1/companies/{companyId}/webhooks/{id}/test: POST :test verb.
 *
 * Enqueues a synthetic `webhook.test` delivery against the configured
 * receiver. The dispatcher cron picks it up at next-minute boundary
 * exactly as it would a real event. The response returns the
 * webhook_delivery_id so the caller can poll
 * GET /webhooks/{id}/deliveries?delivery_id=... to see the outcome.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'

// Scope catalogue: this verb shares webhooks:manage with the parent
// resource. Add the entry to lib/auth/scopes.ts in the same commit when
// promoting the route from skeleton to live (the catalogue currently lists
// only the four CRUD entries plus this :test verb is implied by the
// resource scope; explicit entry follows in the next commit).

registerEndpoint({
  operation: 'webhooks.test',
  method: 'POST',
  path: '/api/v1/companies/:companyId/webhooks/:id/test',
  summary: 'Send a synthetic test event to a webhook.',
  description:
    'Enqueues a webhook.test delivery against the configured receiver. The dispatcher delivers it on the next per-minute cron tick. Use the returned webhook_delivery_id to poll GET /webhooks/{id}/deliveries for the outcome.',
  useWhen:
    'After creating or modifying a webhook, before relying on it in production: to validate that the receiver is reachable and that signature verification works on the receiver side.',
  doNotUseFor:
    'Smoke-testing the dispatcher itself (use a real event). Replaying a failed delivery (use POST /webhook-deliveries/{id}/retry).',
  pitfalls: [
    'Test deliveries follow the same retry policy as real events: a 500 from your receiver will retry 7 times over ~72h. Use a 2xx ack-only handler if you want a clean signal.',
  ],
  example: {
    response: {
      data: {
        webhook_delivery_id: 'wh_dlv_…',
        status: 'pending',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'webhooks:manage',
  risk: 'low',
  idempotent: false,
  reversible: false,
  dryRunSupported: false,
  response: {
    success: dataEnvelope(z.object({
      webhook_delivery_id: z.string().uuid(),
      status: z.literal('pending'),
    })),
  },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'webhooks.test',
  async (_request, ctx, params) => {
    const { id } = await params.params

    const { data: webhook, error: lookupErr } = await ctx.supabase
      .from('webhooks')
      .select('id, api_version_pinned, active, disabled_at')
      .eq('company_id', ctx.companyId!)
      .eq('id', id)
      .maybeSingle()

    if (lookupErr) return v1ErrorResponse(lookupErr, ctx.log, { requestId: ctx.requestId })
    if (!webhook) return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })

    type W = { id: string; api_version_pinned: string; active: boolean; disabled_at: string | null }
    const w = webhook as W

    if (!w.active || w.disabled_at) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'active', message: 'Webhook is disabled: re-enable before sending a test event.' },
      })
    }

    // Data minimisation (Art.25(2)): the test payload deliberately omits
    // any internal identifier that has no value to the receiver. The
    // X-Gnubok-Delivery header on the outbound request already correlates
    // to the audit trail on the Accounted side.
    const payload = {
      hello: 'from Accounted',
      tested_at: new Date().toISOString(),
    }

    const { data: delivery, error: insertErr } = await ctx.supabase
      .from('webhook_deliveries')
      .insert({
        webhook_id: w.id,
        company_id: ctx.companyId!,
        event_type: 'webhook.test',
        payload,
        api_version: w.api_version_pinned,
        // BFNAR 2013:2 kap 8 § behandlingshistorik: link the delivery row
        // back to the originating API request for audit-trail correlation.
        request_id: ctx.requestId,
      })
      .select('id')
      .single()

    if (insertErr || !delivery) {
      return v1ErrorResponse(insertErr ?? new Error('insert returned no row'), ctx.log, {
        requestId: ctx.requestId,
      })
    }

    return ok(
      { webhook_delivery_id: (delivery as { id: string }).id, status: 'pending' as const },
      { requestId: ctx.requestId },
    )
  },
)
