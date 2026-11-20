/**
 * POST /api/v1/companies/{companyId}/suppliers/bulk-create
 *
 * Bulk-create up to 50 suppliers in one call. Each item is validated and
 * inserted independently: per-item failures don't roll back successes.
 * Mirrors the shape of /customers/bulk-create exactly so agents only need
 * to learn one bulk pattern.
 *
 * Response: `{ results: [{ ok, request_index, data?, error? }], summary }`.
 * Idempotent over the whole batch. Dry-runnable.
 *
 * Unlike customers, suppliers do not run VIES validation on create: the
 * vat_number is stored as supplied without an external check.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateSupplierSchema } from '@/lib/api/schemas'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { OperationContext } from '@/lib/operations/types'
import { createSupplier } from '@/lib/suppliers/create-supplier'

const BulkCreateRequest = z.object({
  suppliers: z.array(CreateSupplierSchema).min(1).max(50),
  all_or_nothing: z.boolean().optional().default(false),
})

const BulkResultItem = z.object({
  ok: z.boolean(),
  request_index: z.number().int().nonnegative(),
  data: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .optional(),
})

const BulkCreateResponse = z.object({
  results: z.array(BulkResultItem),
  summary: z.object({
    total: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
  }),
})

registerEndpoint({
  operation: 'suppliers.bulk-create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/suppliers/bulk-create',
  summary: 'Create up to 50 suppliers in one call (partial-success).',
  description:
    'Bulk-create endpoint mirroring /customers/bulk-create. Each supplier is validated and inserted independently: per-item failures do not roll back items that succeeded. Returns a results array plus a summary. Idempotent over the whole batch. Dry-runnable.',
  useWhen:
    'You\'re importing a roster of suppliers from another AP system, or seeding a fresh company with its existing vendor list. Use dry-run first to validate the batch.',
  doNotUseFor:
    'Updating existing suppliers: PATCH /suppliers/{id} once per supplier. Bulk uploads of > 50 suppliers: split into pages of 50. Transactional all-or-nothing imports: passing all_or_nothing: true returns 501 NOT_IMPLEMENTED.',
  pitfalls: [
    'Idempotency-Key is mandatory and covers the WHOLE batch. A retried bulk-create returns the cached full response: it does not retry only the failed items.',
    'Passing all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist; omit the flag or pass false.',
    'org_number uniqueness is enforced at the DB level: items with duplicates fail individually with SUPPLIER_DUPLICATE_ORG_NUMBER.',
    'No VIES validation runs per item; vat_number is stored as supplied. Validate externally if your workflow requires it.',
  ],
  example: {
    request: {
      suppliers: [
        { name: 'Office Depot AB', supplier_type: 'swedish_business', org_number: '556677-8899' },
        { name: 'Cloud Hosting GmbH', supplier_type: 'eu_business', vat_number: 'DE123456789' },
      ],
    },
    response: {
      data: {
        results: [
          { ok: true, request_index: 0, data: { id: '0e9c…', name: 'Office Depot AB' } },
          { ok: true, request_index: 1, data: { id: '4d2a…', name: 'Cloud Hosting GmbH' } },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: BulkCreateRequest },
  response: { success: dataEnvelope(BulkCreateResponse) },
})

interface ResultItem {
  ok: boolean
  request_index: number
  data?: unknown
  error?: { code: string; message: string; details?: unknown }
}

/**
 * One item through the register's one create path (createSupplier,
 * lib/suppliers/create-supplier.ts), the same insert as POST /suppliers, the
 * dashboard and the agent approval. This loop used to insert its own copy,
 * which dropped clearing_number and account_number and stored '' for an
 * empty field.
 */
async function createOneSupplier(
  ctx: OperationContext,
  index: number,
  input: z.infer<typeof CreateSupplierSchema>,
  dryRun: boolean,
): Promise<ResultItem> {
  const outcome = await createSupplier(ctx, input, { dryRun })
  if (!outcome.ok) {
    return {
      ok: false,
      request_index: index,
      error: {
        code: outcome.code,
        message: getErrorEntry(outcome.code)?.message_en ?? outcome.code,
        details:
          outcome.code === 'SUPPLIER_CREATE_FAILED'
            ? { pg_code: (outcome.error as { code?: string } | undefined)?.code ?? null }
            : outcome.details,
      },
    }
  }
  if (outcome.dryRun) {
    return {
      ok: true,
      request_index: index,
      data: { preview: { id: null, ...outcome.preview, archived_at: null, created_at: null, updated_at: null } },
    }
  }
  return { ok: true, request_index: index, data: outcome.data }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'suppliers.bulk-create',
  async (request, ctx) => {
    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    const parsed = BulkCreateRequest.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    if (body.all_or_nothing) {
      return v1ErrorResponseFromCode('NOT_IMPLEMENTED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'all_or_nothing',
          message:
            'all_or_nothing: true is not yet implemented. Omit the flag (or pass false) to use partial-success semantics.',
        },
      })
    }

    // Sequential processing matches /customers/bulk-create and /invoices/bulk-create.
    // The 50-item cap bounds worst-case latency.
    const results: ResultItem[] = []
    for (let i = 0; i < body.suppliers.length; i++) {
      const item = await createOneSupplier(
        { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
        i,
        body.suppliers[i],
        ctx.dryRun,
      )
      results.push(item)
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    }

    ctx.log.info('suppliers.bulk-create completed', {
      companyId: ctx.companyId,
      userId: ctx.userId,
      ...summary,
      dryRun: ctx.dryRun,
    })

    if (ctx.dryRun) {
      return dryRunPreview({ results, summary }, { requestId: ctx.requestId, log: ctx.log })
    }
    return ok({ results, summary }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
