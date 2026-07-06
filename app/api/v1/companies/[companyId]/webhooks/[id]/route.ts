/**
 * /api/v1/companies/{companyId}/webhooks/{id}: get / update / delete.
 *
 * GET   : return the full webhook row (no secret).
 * PATCH : update name, description, webhook_url, active. Cannot change
 *          event_type (immutable: would require re-pinning api_version).
 *          Cannot rotate the secret here (separate flow, deferred to
 *          Phase 6 follow-up).
 * DELETE: hard delete the webhook. The webhook_deliveries.webhook_id FK
 *          is ON DELETE SET NULL (declared in migration 20260515170000),
 *          so the delivery audit trail SURVIVES webhook deletion
 *          (BFNAR 2013:2 kap 8 § behandlingshistorik: accounting-event
 *          deliveries must be retained for 7 years). Pending/failed
 *          deliveries become dormant (the dispatcher skips
 *          webhook_id IS NULL rows); terminal rows stay queryable via
 *          the (future) per-company audit-trail surface.
 */

import { z } from 'zod'
import { ok, noContent } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { validateWebhookUrl } from '@/lib/webhooks/url-guard'

const WEBHOOK_DETAIL_COLUMNS =
  'id, name, description, event_type, webhook_url, active, api_version_pinned, disabled_at, disabled_reason, created_at, updated_at'

const WebhookDetail = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  event_type: z.string(),
  webhook_url: z.string(),
  active: z.boolean(),
  api_version_pinned: z.string(),
  disabled_at: z.string().nullable(),
  disabled_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const PatchWebhookSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    webhook_url: z
      .string()
      .url()
      .max(2048)
      .refine((u) => u.startsWith('https://'), { message: 'webhook_url must use https://' })
      .optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required.' })

// ──────────────────────────────────────────────────────────────────
// GET: detail
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'webhooks.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/webhooks/:id',
  summary: 'Get a webhook subscription by id.',
  description: 'Returns the webhook configuration. The HMAC signing secret is never exposed.',
  useWhen: 'You need the current state of a single webhook (e.g. to render a settings page).',
  doNotUseFor: 'Reading the secret (returned only once on creation).',
  pitfalls: [],
  example: {
    response: {
      data: {
        id: 'a8f1…',
        name: 'CRM sync',
        description: null,
        event_type: 'invoice.paid',
        webhook_url: 'https://example.com/hooks/gnubok',
        active: true,
        api_version_pinned: '2026-05-12',
        disabled_at: null,
        disabled_reason: null,
        created_at: '2026-05-15T12:00:00Z',
        updated_at: '2026-05-15T12:00:00Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'webhooks:manage',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(WebhookDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'webhooks.get',
  async (_request, ctx, params) => {
    const { id } = await params.params
    const { data, error } = await ctx.supabase
      .from('webhooks')
      .select(WEBHOOK_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', id)
      .maybeSingle()

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!data) return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })

    return ok(data, { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// PATCH: update
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'webhooks.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/webhooks/:id',
  summary: 'Update a webhook subscription.',
  description:
    'Update the URL, name, description, or active flag. event_type is immutable: delete and recreate to change it. Setting active=false manually pauses delivery without deleting; setting active=true clears any disabled_at/disabled_reason set by the auto-disable on HTTP 410.',
  useWhen: 'You need to point an existing webhook at a new URL or temporarily pause delivery.',
  doNotUseFor: 'Rotating the signing secret (delete and recreate). Changing event_type.',
  pitfalls: [
    'Re-enabling a webhook (active: true) does NOT replay deliveries that went to dead status while it was disabled: those need POST /webhook-deliveries/{id}/retry.',
  ],
  example: {
    request: { active: true },
    response: {
      data: {
        id: 'a8f1…',
        name: 'CRM sync',
        description: null,
        event_type: 'invoice.paid',
        webhook_url: 'https://example.com/hooks/gnubok',
        active: true,
        api_version_pinned: '2026-05-12',
        disabled_at: null,
        disabled_reason: null,
        created_at: '2026-05-15T12:00:00Z',
        updated_at: '2026-05-15T12:05:00Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'webhooks:manage',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: PatchWebhookSchema },
  response: { success: dataEnvelope(WebhookDetail) },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'webhooks.update',
  async (request, ctx, params) => {
    const { id } = await params.params

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }
    const parsed = PatchWebhookSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const body = parsed.data

    // SSRF guard on webhook_url change: same DNS/IP-class validation as
    // POST /webhooks. Skip when webhook_url isn't being changed.
    if (body.webhook_url !== undefined) {
      const urlCheck = await validateWebhookUrl(body.webhook_url)
      if (!urlCheck.ok) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'webhook_url', reason: urlCheck.reason, message: urlCheck.detail },
        })
      }
    }

    // Re-enable clears disabled_at/disabled_reason (legitimate operator
    // action after fixing the receiver). Manual disable sets them.
    const update: Record<string, unknown> = { ...body }
    if (body.active === true) {
      update.disabled_at = null
      update.disabled_reason = null
    } else if (body.active === false) {
      update.disabled_at = new Date().toISOString()
      update.disabled_reason = 'manually_disabled'
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        { id, ...update, would_persist: true },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Capture prior state for the audit_log old_state field. One extra
    // SELECT: cost is negligible for a manual webhook PATCH and the
    // before/after pair is what makes the audit row reconstructible.
    const { data: prior } = await ctx.supabase
      .from('webhooks')
      .select('name, description, webhook_url, active, disabled_at, disabled_reason')
      .eq('company_id', ctx.companyId!)
      .eq('id', id)
      .maybeSingle()

    const { data, error } = await ctx.supabase
      .from('webhooks')
      .update(update)
      .eq('company_id', ctx.companyId!)
      .eq('id', id)
      .select(WEBHOOK_DETAIL_COLUMNS)
      .maybeSingle()

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    if (!data) return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })

    // V16 audit log: webhook lifecycle event. Record the diff.
    //
    // new_state is populated from the DB-confirmed returned row (`data`)
    // through an explicit field allowlist: NOT from the spread
    // `update` object. Two reasons: (a) the post-UPDATE state is the
    // ground truth, and a future column-level CHECK/trigger that
    // rejects a field would leave the request-body-derived shape
    // misleadingly out of sync (A.8.11 / V16.1.1); (b) the allowlist
    // foreclosures any future widening of PatchWebhookSchema that
    // accidentally pulls a sensitive field into the audit trail.
    const changedFields = Object.keys(body)
    const d = data as Record<string, unknown>
    const { error: auditErr } = await ctx.supabase.from('audit_log').insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      action: 'UPDATE',
      table_name: 'webhooks',
      record_id: id,
      actor_id: ctx.apiKeyId ?? null,
      description: `Webhook updated: ${changedFields.join(', ')}`,
      old_state: prior ?? null,
      new_state: {
        name: d.name,
        description: d.description,
        webhook_url: d.webhook_url,
        active: d.active,
        disabled_at: d.disabled_at,
        disabled_reason: d.disabled_reason,
      },
    })
    if (auditErr) {
      ctx.log.warn('audit_log insert failed for webhook update', { webhookId: id, code: auditErr.code })
    }

    return ok(data, { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// DELETE
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'webhooks.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/webhooks/:id',
  summary: 'Delete a webhook subscription.',
  description:
    'Hard-deletes the webhook. The delivery audit trail SURVIVES: both terminal (delivered, dead) and non-terminal (pending, failed) delivery rows persist with webhook_id = NULL so the BFNAR 2013:2 kap 8 § behandlingshistorik (7-year retention) for accounting-event deliveries is preserved. Non-terminal rows go dormant (the dispatcher skips them).',
  useWhen: 'You no longer want this webhook to receive events.',
  doNotUseFor:
    'Temporarily pausing delivery: use PATCH with active=false instead so the configuration survives.',
  pitfalls: ['Audit history survives DELETE; only the receiver subscription is removed. To suppress future events without retaining the registration use PATCH active=false.'],
  example: {
    response: {
      data: { deleted: true },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'webhooks:manage',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: NoBodyResponse },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'webhooks.delete',
  async (_request, ctx, params) => {
    const { id } = await params.params

    // Atomic delete + returning. One round trip captures both the
    // deletion-confirmation row count and the deleted row's prior state
    // for the audit_log entry: eliminates the pre-read TOCTOU window
    // a separate SELECT introduced (V8.2.1). Idempotent DELETE: a 0-row
    // delete (already-deleted webhook) still returns 204 because the
    // resource is gone, which is the desired end state.
    const { data: deleted, error } = await ctx.supabase
      .from('webhooks')
      .delete()
      .eq('company_id', ctx.companyId!)
      .eq('id', id)
      .select('name, event_type, webhook_url, active')
      .maybeSingle()

    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })

    // V16 audit log: webhook lifecycle event. Records the deletion
    // UNCONDITIONALLY. When `deleted` is null (no row matched:
    // idempotent re-delete or cross-tenant id), the audit row still
    // captures the attempt: record_id + actor_id + action + timestamp
    // is the minimum CC6.3 attribution contract; old_state degrades
    // to null.
    const p = deleted as { name: string; event_type: string; webhook_url: string; active: boolean } | null
    const { error: auditErr } = await ctx.supabase.from('audit_log').insert({
      user_id: ctx.userId,
      company_id: ctx.companyId,
      action: 'DELETE',
      table_name: 'webhooks',
      record_id: id,
      actor_id: ctx.apiKeyId ?? null,
      description: p
        ? `Webhook deleted: "${p.name}" (${p.event_type})`
        : `Webhook delete attempted on missing id=${id} (idempotent or cross-tenant)`,
      old_state: p,
    })
    if (auditErr) {
      ctx.log.warn('audit_log insert failed for webhook delete', { webhookId: id, code: auditErr.code })
    }

    return noContent({ requestId: ctx.requestId })
  },
)
