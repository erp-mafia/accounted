/**
 * /api/v1/webhook-deliveries/{id}/retry: POST :retry verb.
 *
 * Re-enqueues a `dead` delivery by INSERTing a fresh row pointing at the
 * same payload, NOT by mutating the dead row in place (the immutability
 * trigger blocks that). The new row enters `pending` and the dispatcher
 * picks it up at next-minute boundary.
 *
 * Live (`pending` / `in_flight` / `failed`) deliveries cannot be retried
 * via this endpoint: the dispatcher already retries failed ones, and the
 * other states aren't terminal. Only `dead` (and `delivered`, for callers
 * that explicitly want to redeliver a message) qualify.
 *
 * The route lives outside the /companies/{companyId}/ tree because callers
 * referencing a delivery already have its id; nesting under company would
 * force the receiver-debugging UI to round-trip company resolution from
 * the delivery id. Tenancy is still enforced: the wrapper resolves the
 * delivery's company_id via the row and verifies caller membership.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { minimisePayload } from '@/lib/webhooks/handler'
import { validateWebhookUrl } from '@/lib/webhooks/url-guard'
import { hasScope } from '@/lib/auth/api-keys'

registerEndpoint({
  operation: 'webhook_deliveries.retry',
  method: 'POST',
  path: '/api/v1/webhook-deliveries/:id/retry',
  summary: 'Retry a webhook delivery.',
  description:
    'Re-enqueues a dead (or delivered) delivery as a fresh pending row. The new delivery references the same webhook + payload; the dispatcher picks it up at the next per-minute cron tick. The original row is preserved in the audit log.',
  useWhen:
    'After a receiver outage you want to replay deliveries that died, or after fixing a receiver-side bug you want to redeliver a successful one.',
  doNotUseFor:
    'Retrying live deliveries (pending / in_flight / failed): the dispatcher is already managing them.',
  pitfalls: [
    'Retrying a delivered delivery causes the receiver to see the event twice. Receivers MUST be idempotent (check the X-Gnubok-Delivery header).',
  ],
  example: {
    response: {
      data: {
        webhook_delivery_id: 'wh_dlv_NEW',
        status: 'pending',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  // Special-case scope: this endpoint lives outside the companies/ tree
  // but still belongs to the webhooks domain. Add to lib/auth/scopes.ts in
  // the same commit as the v1 wiring.
  scope: 'webhooks:manage',
  risk: 'medium',
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

export const POST = withApiV1<{ params: Promise<{ id: string }> }>(
  'webhook_deliveries.retry',
  async (_request, ctx, params) => {
    const { id } = await params.params

    // Fetch the original delivery and its company to enforce tenancy.
    const { data: original, error: lookupErr } = await ctx.supabase
      .from('webhook_deliveries')
      .select('id, webhook_id, company_id, event_type, payload, previous_attributes, api_version, status')
      .eq('id', id)
      .maybeSingle()

    if (lookupErr) return v1ErrorResponse(lookupErr, ctx.log, { requestId: ctx.requestId })
    if (!original) return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })

    type O = {
      id: string
      webhook_id: string
      company_id: string
      event_type: string
      payload: Record<string, unknown>
      previous_attributes: Record<string, unknown> | null
      api_version: string
      status: 'pending' | 'in_flight' | 'delivered' | 'failed' | 'dead'
    }
    const o = original as O

    // Tenancy check: the wrapper does not have a companyId from the URL
    // here (deliberate; see file header). Verify the caller is a member of
    // the delivery's company.
    const { data: membership, error: membershipErr } = await ctx.supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', ctx.userId)
      .eq('company_id', o.company_id)
      .maybeSingle()

    if (membershipErr) return v1ErrorResponse(membershipErr, ctx.log, { requestId: ctx.requestId })
    if (!membership) {
      // 404 (not 403) so we don't leak existence of the delivery to a
      // non-member; matches the wrapper's standard pattern.
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    if (o.status !== 'dead' && o.status !== 'delivered') {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'status',
          message: `Only dead or delivered deliveries can be retried (current: ${o.status}).`,
        },
      })
    }

    // Mirror the create-route elevated-scope gate. A key with only
    // webhooks:manage must NOT be able to re-emit a salary_run.* / agi.*
    // payload: those carry personnummer, lönesummor, skatteavdrag, and
    // the original create call required webhooks:manage AND payroll:read.
    // Retry checks the SAME pair against the CALLING key's scopes (which
    // may differ from the key that created the webhook in the first place).
    const PAYROLL_SENSITIVE = /^(salary_run\.|agi\.)/
    if (PAYROLL_SENSITIVE.test(o.event_type) && !hasScope(ctx.scopes, 'payroll:read')) {
      return v1ErrorResponseFromCode('INSUFFICIENT_SCOPE', ctx.log, {
        requestId: ctx.requestId,
        details: {
          required_scope: 'payroll:read',
          reason: `Retrying ${o.event_type} requires payroll:read in addition to webhooks:manage.`,
        },
      })
    }

    // Re-verify that the parent webhook still exists, still belongs to the
    // delivery's company, and is still active immediately before INSERT.
    // Closes the TOCTOU window between the membership check above and the
    // INSERT: without this a webhook deleted in between would have its
    // retry land in webhook_deliveries with a now-dangling webhook_id, and
    // a webhook re-registered to a different company in between would let
    // the caller redeliver an event to a webhook they never created.
    const { data: webhook, error: webhookErr } = await ctx.supabase
      .from('webhooks')
      .select('id, webhook_url, active, disabled_at')
      .eq('id', o.webhook_id)
      .eq('company_id', o.company_id)
      .maybeSingle()

    if (webhookErr) return v1ErrorResponse(webhookErr, ctx.log, { requestId: ctx.requestId })
    if (!webhook) {
      // The original webhook no longer exists or is no longer in this
      // company. There's nothing to redeliver to. 404, not VALIDATION_ERROR:
      // the resource the caller targeted is genuinely gone.
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    const w = webhook as { id: string; webhook_url: string; active: boolean; disabled_at: string | null }
    if (!w.active || w.disabled_at) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'webhook.active', message: 'Webhook is disabled: re-enable before retrying.' },
      })
    }

    // Re-run the SSRF guard against the webhook's CURRENT url. The URL
    // may have changed via PATCH between the original delivery and this
    // retry call. The dispatch-time guard would catch a malicious URL
    // eventually, but allowing the INSERT first means a poisoned row
    // sits in the queue until the next cron tick. Validating here closes
    // the window: the retry refuses up-front and the audit trail gets
    // a clean VALIDATION_ERROR rather than a deferred dispatch-time
    // 'dead' row with reason='url_unsafe'.
    const urlCheck = await validateWebhookUrl(w.webhook_url)
    if (!urlCheck.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'webhook.webhook_url', reason: urlCheck.reason, message: urlCheck.detail },
      })
    }

    // Re-run the data-minimisation projection on the original payload
    // before re-enqueueing. If the original delivery predates a
    // minimisePayload tightening (e.g. a future projection drops more
    // fields), the retry must not silently re-deliver the unminimised
    // shape. Idempotent on already-minimised payloads.
    const minimised = minimisePayload(o.payload)

    const { data: replay, error: insertErr } = await ctx.supabase
      .from('webhook_deliveries')
      .insert({
        webhook_id: o.webhook_id,
        company_id: o.company_id,
        event_type: o.event_type,
        payload: minimised,
        previous_attributes: o.previous_attributes,
        api_version: o.api_version,
        // Link the retry to the API request that triggered it. The
        // original delivery's request_id is preserved on its own audit
        // row; the retry gets a fresh correlation pointing at the
        // :retry call.
        request_id: ctx.requestId,
      })
      .select('id')
      .single()

    if (insertErr || !replay) {
      return v1ErrorResponse(insertErr ?? new Error('insert returned no row'), ctx.log, {
        requestId: ctx.requestId,
      })
    }

    return ok(
      { webhook_delivery_id: (replay as { id: string }).id, status: 'pending' as const },
      { requestId: ctx.requestId },
    )
  },
)
