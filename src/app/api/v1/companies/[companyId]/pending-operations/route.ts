/**
 * GET /api/v1/companies/{companyId}/pending-operations
 *
 * The approval queue over REST: the staged writes (pending operations) of
 * one company, newest first, with cursor pagination on (created_at DESC,
 * id DESC). The same rows the app's review list (Att göra > Agentförslag)
 * and gnubok_list_pending_operations show; each carries task_state beside
 * its status (lib/pending-operations/task-state.ts), and agent_reason, why
 * its stager proposes it.
 *
 * Defaults to status=pending like both of those doors; status=all lists
 * every status. `params` (the raw staged input) is never returned.
 */

import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import { decodeDefaultCursor, encodeDefaultCursor, parsePaginationParams, PaginationQueryShape } from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ValidationError } from '@/lib/api/v1/errors'
import {
  PENDING_OPERATION_STATUSES,
  readPendingOperationView,
  selectPendingOperationView,
  PENDING_OPERATION_VIEW_EXAMPLE,
  PendingOperationView,
  toPendingOperationView,
  type PendingOperationViewRow,
} from '@/lib/pending-operations/view'

const ListQuery = z.object({
  status: z
    .enum([...PENDING_OPERATION_STATUSES, 'all'])
    .optional()
    .describe('Default pending (the approval queue). all = every status.'),
  risk_level: z.enum(['low', 'medium', 'high']).optional(),
  operation_type: z.string().min(1).max(100).optional().describe('One operation type, e.g. create_invoice.'),
  batch_id: z.string().uuid().optional().describe('Only the operations staged together under this batch.'),
  ...PaginationQueryShape,
})

registerEndpoint({
  operation: 'pending-operations.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/pending-operations',
  summary: 'List pending operations (staged writes waiting for approval).',
  description:
    'Returns the company\'s pending operations newest first: writes staged for approval by an agent, an integration (`?stage=true` on a write) or the app, with what approving each will do (`preview`), its risk level and, once resolved, its `result`. Every row carries `status` (pending, committing, committed, rejected, failed_partial) and `task_state` in the MCP Tasks / A2A vocabulary: working (pending, committing), completed (committed), failed (the approved commit did not go through), cancelled (rejected by a person, expired or superseded). Defaults to `status=pending`, the approval queue; `status=all` lists every status. Same rows as the app\'s review list and the MCP tool gnubok_list_pending_operations.',
  useWhen:
    'You run an approval or attest flow outside Accounted and need the queue of operations waiting for a decision, or the outcome of the ones you staged.',
  doNotUseFor:
    'Supplier-invoice attest (GET /supplier-invoices and POST /supplier-invoices/{id}/approve, governed by the attest policy). Polling one operation you staged (GET /pending-operations/{id}).',
  pitfalls: [
    'Without status the list is pending only; pass status=all for history.',
    'The staged input (params) is never returned: preview is the approver\'s summary.',
    'A cursor that no longer decodes starts from the first page again: stop on a null next_cursor.',
  ],
  example: {
    response: {
      data: [PENDING_OPERATION_VIEW_EXAMPLE],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'pending_operations:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: ListQuery },
  response: { success: listEnvelope(PendingOperationView) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'pending-operations.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const filters = ListQuery.omit({ cursor: true, limit: true }).safeParse({
      status: url.searchParams.get('status') ?? undefined,
      risk_level: url.searchParams.get('risk_level') ?? undefined,
      operation_type: url.searchParams.get('operation_type') ?? undefined,
      batch_id: url.searchParams.get('batch_id') ?? undefined,
    })
    if (!filters.success) return v1ValidationError(ctx, filters.error)
    const { status = 'pending', risk_level, operation_type, batch_id } = filters.data

    const { data, error } = await readPendingOperationView((options) => {
      let query = selectPendingOperationView(ctx.supabase, options)
        .eq('company_id', ctx.companyId!)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1)
      if (status !== 'all') query = query.eq('status', status)
      if (risk_level) query = query.eq('risk_level', risk_level)
      if (operation_type) query = query.eq('operation_type', operation_type)
      if (batch_id) query = query.eq('batch_id', batch_id)
      if (decoded) {
        query = query.or(`created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`)
      }
      return query
    })
    if (error) return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })

    const rows = (data ?? []) as unknown as PendingOperationViewRow[]
    const page = rows.slice(0, limit)
    const nextCursor = rows.length > limit ? encodeDefaultCursor(page[page.length - 1]) : null

    return paginated(page.map(toPendingOperationView), {
      requestId: ctx.requestId,
      ...(nextCursor ? { nextCursor } : {}),
    })
  },
)
