/**
 * /api/v1/companies/{companyId}/webhooks/{id}/verify: POST :verify verb.
 *
 * Runs the endpoint ownership handshake (ADA CASA 7.1.2) against the
 * webhook's current URL right now and answers with the outcome. The rules
 * (disabled refusal, already-verified short circuit, cooldown, conditional
 * writes) live in lib/webhooks/verification.ts, which the dispatch cron also
 * uses for its automatic attempts; this door only maps outcomes to HTTP.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import {
  MANUAL_VERIFY_COOLDOWN_SECONDS,
  WEBHOOK_VERIFICATION_RESPONSE_FIELDS,
  verifyWebhookNow,
  withVerificationStatus,
  type ManualVerificationResult,
  type VerificationTimestamps,
} from '@/lib/webhooks/verification'

const VerifyResponse = z.object({
  id: z.string().uuid(),
  webhook_url: z.string(),
  ...WEBHOOK_VERIFICATION_RESPONSE_FIELDS,
})

registerEndpoint({
  operation: 'webhooks.verify',
  method: 'POST',
  path: '/api/v1/companies/:companyId/webhooks/:id/verify',
  summary: "Verify a webhook endpoint's ownership now.",
  description:
    'Runs the ownership handshake against the webhook URL immediately and returns the result. Accounted POSTs a signed webhook.verification event (same X-Gnubok-Signature scheme and envelope as every delivery) whose data.object.challenge is a random value; the endpoint passes by answering, within 10 seconds and without a redirect, any 2xx with the JSON body {"challenge": "<the same value>"}. A pass sets verified_at and opens the webhook to deliveries; a failure answers 422 WEBHOOK_VERIFICATION_FAILED with details.reason. A webhook that is already verified is returned as-is without contacting the URL.',
  useWhen:
    "After creating a webhook or changing its URL, once your receiver answers webhook.verification. Also to resume a webhook whose verification_status is 'paused' (a pre-verification endpoint whose grace window closed).",
  doNotUseFor:
    'Checking that normal deliveries work end to end (use POST /webhooks/{id}/test once verified). Re-verifying a verified URL: the call is a no-op until the URL changes.',
  pitfalls: [
    'The challenge is inside data.object but must come back at the top level of your response body: {"challenge": "..."}. Echoing the request body verbatim does not pass.',
    `One attempt per webhook per ${MANUAL_VERIFY_COOLDOWN_SECONDS} seconds: a faster repeat answers 429 RATE_LIMITED with Retry-After.`,
    'A disabled webhook (active=false or auto-disabled) answers 400: re-enable it with PATCH first.',
    'Reasons in details.reason / verification_last_error: http_<status>, timeout, redirect_blocked, response_not_json, response_too_large, challenge_missing, challenge_mismatch, transport_error, url_unsafe:<class>.',
  ],
  example: {
    response: {
      data: {
        id: 'a8f1…',
        webhook_url: 'https://example.com/hooks/gnubok',
        verification_status: 'verified',
        verified_at: '2026-05-15T12:01:02Z',
        verification_grace_ends_at: null,
        verification_attempts: 1,
        verification_last_attempt_at: '2026-05-15T12:01:02Z',
        verification_last_error: null,
        verification_next_attempt_at: null,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'webhooks:manage',
  risk: 'low',
  idempotent: false,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(VerifyResponse) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'webhooks.verify',
  async (_request, ctx, params) => {
    const { id } = await params.params

    let result: ManualVerificationResult
    try {
      result = await verifyWebhookNow({
        supabase: ctx.supabase,
        companyId: ctx.companyId!,
        webhookId: id,
        actor: { userId: ctx.userId, apiKeyId: ctx.apiKeyId ?? null },
      })
    } catch (err) {
      return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
    }

    switch (result.kind) {
      case 'not_found':
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
      case 'disabled':
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'active', message: 'Webhook is disabled: re-enable before verifying.' },
        })
      case 'cooldown':
        return v1ErrorResponseFromCode('RATE_LIMITED', ctx.log, {
          requestId: ctx.requestId,
          retryAfterSeconds: result.retryAfterSeconds,
          details: {
            message: `A verification attempt for this webhook started less than ${MANUAL_VERIFY_COOLDOWN_SECONDS} seconds ago.`,
            retry_after_seconds: result.retryAfterSeconds,
          },
        })
      case 'superseded':
        return v1ErrorResponseFromCode('CONFLICT', ctx.log, {
          requestId: ctx.requestId,
          details: { message: 'The webhook URL changed while it was being verified. Read the webhook and try again.' },
        })
    }

    // verified, already_verified or failed: answer with the recorded state.
    const { data, error } = await ctx.supabase
      .from('webhooks')
      .select(
        'id, webhook_url, verified_at, verification_grace_ends_at, verification_attempts, verification_last_attempt_at, verification_last_error, verification_next_attempt_at'
      )
      .eq('company_id', ctx.companyId!)
      .eq('id', id)
      .maybeSingle()
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!data) return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    const state = withVerificationStatus(data as unknown as VerificationTimestamps)

    if (result.kind === 'failed') {
      return v1ErrorResponseFromCode('WEBHOOK_VERIFICATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: result.reason, error: result.error, webhook: state },
      })
    }
    return ok(state, { requestId: ctx.requestId })
  },
)
