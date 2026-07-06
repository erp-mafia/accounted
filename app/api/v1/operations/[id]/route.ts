/**
 * GET /api/v1/operations/{id}
 *
 * Polling endpoint for async operations. Returns the current snapshot of
 * the operation row including status, progress (if the work is in-flight),
 * result (on success), and error (on failure).
 *
 * The operation_id is global (cross-company in the URL) but every read is
 * scoped to the caller's company in `getOperation()`: so two companies'
 * UUIDs can never collide into the wrong tenant. The wrapper has already
 * validated company membership.
 *
 * Webhook alternative (Phase 6): subscribe to `operation.completed` instead
 * of polling.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { getOperation } from '@/lib/api/v1/operations'

const OperationStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled'])

const OperationDetail = z.object({
  operation_id: z.string().uuid(),
  type: z.string(),
  status: OperationStatus,
  progress: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().nullable(),
  error: z
    .object({ code: z.string().optional(), message: z.string().optional(), details: z.unknown().optional() })
    .nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  poll_url: z.string(),
  webhook_event: z.literal('operation.completed'),
})

registerEndpoint({
  operation: 'operations.get',
  method: 'GET',
  path: '/api/v1/operations/:id',
  summary: 'Poll a long-running operation by id.',
  description:
    'Returns the current snapshot of a v1 async operation: status (queued / running / succeeded / failed / cancelled), progress (jsonb, free-form), result (on success), and error (on failure). The operation_id is returned by the POST endpoints that initiate async work (period close, year-end, currency revaluation, SIE import).',
  useWhen:
    'You started an async operation and need to know whether it has finished. Poll every 5-30 seconds; switch to the `operation.completed` webhook for production integrations.',
  doNotUseFor:
    'Fetching the resource the operation produced: once status=succeeded, read the result field or call the resource-specific GET endpoint. Cancelling a running operation (no cancel endpoint exists in v1).',
  pitfalls: [
    'Terminal statuses (`succeeded`, `failed`, `cancelled`) are final; the row never transitions out of them.',
    'progress is free-form jsonb; agents should treat it as opaque except for the documented fields `phase` (string), `current` / `total` (numbers for percent calculation).',
    'started_at is null while status=queued (the work has not begun yet); completed_at is null until a terminal status is reached.',
  ],
  example: {
    response: {
      data: {
        operation_id: '0e9c-…',
        type: 'fiscal_periods.year_end',
        status: 'succeeded',
        progress: { phase: 'committed', current: 142, total: 142 },
        result: { journal_entries_created: 4, opening_balances_set: 138 },
        error: null,
        started_at: '2026-05-12T10:01:23Z',
        completed_at: '2026-05-12T10:01:48Z',
        poll_url: '/api/v1/operations/0e9c-…',
        webhook_event: 'operation.completed',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'operations:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(OperationDetail) },
})

export const GET = withApiV1<{ params: Promise<{ id: string }> }>(
  'operations.get',
  async (_request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Operation id must be a UUID.' },
      })
    }
    const operationId = idParse.data

    // The operations URL has no /companies/:companyId prefix, so the wrapper
    // can't resolve ctx.companyId from a path segment. We fetch by id alone
    // (service-role bypasses RLS), then verify the operation's company is one
    // this caller belongs to. Two-step lookup keeps the resource id global
    // while still hard-scoping reads to the caller's tenancies.
    const { data: opRow, error: opErr } = await ctx.supabase
      .from('operations')
      .select('company_id')
      .eq('id', operationId)
      .maybeSingle()

    if (opErr) {
      ctx.log.error('operations.get fetch failed', opErr as Error, { operationId })
      return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, { requestId: ctx.requestId })
    }
    if (!opRow) {
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'operation' },
      })
    }

    const opCompanyId = (opRow as { company_id: string }).company_id
    const { data: membership } = await ctx.supabase
      .from('company_members')
      .select('company_id')
      .eq('user_id', ctx.userId)
      .eq('company_id', opCompanyId)
      .maybeSingle()

    if (!membership) {
      // Enumeration hardening: wrong id and cross-tenant id are
      // indistinguishable from outside.
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'operation' },
      })
    }

    const row = await getOperation(ctx.supabase, {
      id: operationId,
      companyId: opCompanyId,
    })

    if (!row) {
      // Race between the membership read and the operation read, extremely
      // unlikely but defended.
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'operation' },
      })
    }

    return ok(
      {
        operation_id: row.id,
        type: row.operation_type,
        status: row.status,
        progress: row.progress,
        result: row.result,
        error: row.error,
        started_at: row.started_at,
        completed_at: row.completed_at,
        poll_url: `/api/v1/operations/${row.id}`,
        webhook_event: 'operation.completed',
      },
      { requestId: ctx.requestId },
    )
  },
)
