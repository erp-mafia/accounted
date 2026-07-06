/**
 * /api/v1/companies/{companyId}/webhooks/{id}/rotate-secret: POST :rotate-secret verb.
 *
 * Generates a fresh HMAC signing secret for the webhook and returns it
 * EXACTLY ONCE in the response. The old secret is invalidated immediately:
 * there is no grace period. Callers must coordinate the rotation:
 *
 *   1. Stage the new secret on the receiver (separate config slot,
 *      do NOT activate yet).
 *   2. POST /rotate-secret.
 *   3. Activate the new secret on the receiver.
 *   4. POST /webhooks/{id}/test to verify the receiver accepts the new
 *      signature.
 *
 * Steps 2-3 are the window where in-flight deliveries from the dispatcher
 * may carry the new signature; receivers must accept both for at most a
 * few seconds. If your operational tolerance for that window is zero,
 * disable the webhook before rotation (`PATCH active=false`) and re-enable
 * after step 3.
 *
 * A "previous_secret" column with TTL-based grace period (Stripe-style)
 * is the natural follow-up. v1 ships instant rotation as the simplest
 * shape that closes the "secret leaked, need to rotate now" use case.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { generateWebhookSecret } from '@/lib/webhooks/signing'

const RotateSecretResponse = z.object({
  id: z.string().uuid(),
  secret: z.string(),
  rotated_at: z.string(),
})

registerEndpoint({
  operation: 'webhooks.rotate_secret',
  method: 'POST',
  path: '/api/v1/companies/:companyId/webhooks/:id/rotate-secret',
  summary: 'Rotate the HMAC signing secret on a webhook.',
  description:
    'Generates a fresh HMAC signing secret for the webhook and returns it EXACTLY ONCE. The previous secret is invalidated immediately. There is no grace period: coordinate the rotation on the receiver side BEFORE calling this endpoint, or temporarily disable the webhook (PATCH active=false) to pause delivery while you swap secrets.',
  useWhen:
    'After a suspected secret leak, on a routine rotation cadence (Stripe pattern: every 90 days for compliance-grade integrations), or when changing the receiver implementation and you want to invalidate the old secret deliberately.',
  doNotUseFor:
    'Routine integration setup: the secret returned at create time is the canonical one. Recovering a lost secret (rotation does not recover the prior value; it issues a fresh one).',
  pitfalls: [
    'The secret is returned exactly once. If you lose this response, the recovery path is to rotate again.',
    'In-flight deliveries between the rotation and the receiver-side update may fail signature verification on the new secret. Pause the webhook (PATCH active=false) first if your tolerance for that window is zero.',
  ],
  example: {
    response: {
      data: {
        id: 'a8f1…',
        secret: 'whsec_…',
        rotated_at: '2026-05-15T12:00:00Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'webhooks:manage',
  risk: 'medium',
  idempotent: false,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(RotateSecretResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'webhooks.rotate_secret',
  async (_request, ctx, params) => {
    const { id } = await params.params

    const newSecret = `whsec_${generateWebhookSecret()}`
    const rotatedAt = new Date().toISOString()

    // Single atomic UPDATE … RETURNING name. The preflight existence-check
    // SELECT is unnecessary because PostgREST's .select(...).maybeSingle()
    // on the UPDATE returns null when no row matched: which is the same
    // signal (existence) the SELECT gave us, but in one round trip and
    // without the TOCTOU window a separate SELECT introduces.
    //
    // RETURNING `name` so the audit_log description carries a human
    // identifier without a second read.
    const { data: updatedRow, error: updateErr } = await ctx.supabase
      .from('webhooks')
      .update({ secret: newSecret })
      .eq('company_id', ctx.companyId!)
      .eq('id', id)
      .select('id, name')
      .maybeSingle()

    if (updateErr) return v1ErrorResponse(updateErr, ctx.log, { requestId: ctx.requestId })
    if (!updatedRow) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    const w = updatedRow as { id: string; name: string }

    // Audit log entry: V16 security event. Records the rotation with
    // actor attribution but NEVER the secret value itself (signing
    // material must not land in the audit trail). new_state carries the
    // event metadata; the secret is omitted by design. CC7.2: surface
    // a structured warning when the audit write fails so SIEM can alert.
    const { error: auditErr } = await ctx.supabase.from('audit_log').insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      action: 'SECURITY_EVENT',
      table_name: 'webhooks',
      record_id: id,
      actor_id: ctx.apiKeyId ?? null,
      description: `Webhook secret rotated: "${w.name}"`,
      new_state: { event: 'secret_rotated', rotated_at: rotatedAt },
    })
    if (auditErr) {
      ctx.log.warn('audit_log insert failed for webhook rotate-secret', {
        webhookId: id,
        code: auditErr.code,
      })
    }

    // Cache-Control: no-store prevents any intermediary (CDN, proxy,
    // load-balancer access log, API gateway, browser cache) from
    // persisting the response body. The HMAC secret is sensitive
    // credential material returned exactly once: landing it in an
    // intermediary log store with a different retention policy than
    // intended would defeat the rotation's purpose (Art.25 / CC6.1).
    return ok(
      { id, secret: newSecret, rotated_at: rotatedAt },
      {
        requestId: ctx.requestId,
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, private',
          Pragma: 'no-cache',
        },
      },
    )
  },
  { requireIdempotencyKey: true },
)
