/**
 * /api/v1/companies/{companyId}/webhooks/{id}/deliveries — list deliveries.
 *
 * Returns the most recent deliveries for the webhook, newest first.
 * Cursor pagination on (created_at DESC, id DESC). Single-delivery lookup
 * via ?delivery_id=<uuid>.
 *
 * Response carries `status`, `attempts`, `next_attempt_at`, the captured
 * `response_status` / `response_body` / `error` so a caller (or the dashboard
 * webhook detail panel) can debug a flaky receiver.
 */

import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import { registerEndpoint, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { decodeDefaultCursor, encodeDefaultCursor, parsePaginationParams } from '@/lib/api/v1/pagination'

const DELIVERY_COLUMNS =
  'id, webhook_id, event_type, status, attempts, next_attempt_at, response_status, response_body, error, request_id, created_at, delivered_at'

const DeliverySummary = z.object({
  id: z.string().uuid(),
  webhook_id: z.string().uuid(),
  event_type: z.string(),
  status: z.enum(['pending', 'in_flight', 'delivered', 'failed', 'dead']),
  attempts: z.number().int(),
  next_attempt_at: z.string(),
  response_status: z.number().int().nullable(),
  response_body: z.string().nullable(),
  error: z.string().nullable(),
  request_id: z.string().nullable(),
  created_at: z.string(),
  delivered_at: z.string().nullable(),
})

registerEndpoint({
  operation: 'webhooks.deliveries.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/webhooks/:id/deliveries',
  summary: 'List deliveries for a webhook subscription.',
  description:
    'Returns deliveries for the webhook in newest-first order. Each row carries the current status (pending / in_flight / delivered / failed / dead), the attempt count, the next scheduled retry time, and the captured response details from the last attempt.',
  useWhen:
    'You are debugging a flaky receiver, or building a delivery-history UI for a settings page.',
  doNotUseFor:
    'Listing deliveries across multiple webhooks (this endpoint is single-webhook scoped).',
  pitfalls: [
    'response_body is truncated to 4 KB — receivers returning long error pages have their response truncated.',
    'A delivery in `failed` status is non-terminal — the dispatcher will retry it at next_attempt_at. `dead` is terminal.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'wh_dlv_…',
          webhook_id: 'a8f1…',
          event_type: 'invoice.paid',
          status: 'delivered',
          attempts: 1,
          next_attempt_at: '2026-05-15T12:00:00Z',
          response_status: 200,
          response_body: 'ok',
          error: null,
          request_id: 'whdel_…',
          created_at: '2026-05-15T12:00:00Z',
          delivered_at: '2026-05-15T12:00:01Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'webhooks:manage',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: listEnvelope(DeliverySummary) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'webhooks.deliveries.list',
  async (request, ctx, params) => {
    const { id: webhookId } = await params.params
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    // Defensive early return — the wrapper guarantees companyId for
    // routes inside /companies/{companyId}/, but a missing value here
    // would silently produce `WHERE company_id = NULL` (always-empty)
    // rather than a hard auth failure. Surface the misconfiguration.
    if (!ctx.companyId) {
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, { requestId: ctx.requestId })
    }

    // Verify the webhook itself belongs to ctx.companyId before listing
    // its deliveries. The deliveries query already filters by
    // (company_id, webhook_id) so a cross-tenant id wouldn't return
    // anything — but emitting an explicit ownership check first surfaces
    // a clean 404 (rather than a confusing empty list) and matches the
    // pattern used for :retry and :test. Defense in depth alongside RLS.
    const { data: webhookOwnership, error: ownershipErr } = await ctx.supabase
      .from('webhooks')
      .select('id')
      .eq('id', webhookId)
      .eq('company_id', ctx.companyId)
      .maybeSingle()

    if (ownershipErr) return v1ErrorResponse(ownershipErr, ctx.log, { requestId: ctx.requestId })
    if (!webhookOwnership) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    let query = ctx.supabase
      .from('webhook_deliveries')
      .select(DELIVERY_COLUMNS)
      .eq('company_id', ctx.companyId)
      .eq('webhook_id', webhookId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    const deliveryId = url.searchParams.get('delivery_id')
    if (deliveryId) {
      query = query.eq('id', deliveryId)
    }

    if (decoded) {
      query = query.or(
        `created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`,
      )
    }

    const { data, error } = await query
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })

    type Row = { id: string; created_at: string }
    const rows = (data ?? []) as unknown as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.created_at })
      : null

    return paginated(trimmed, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)
