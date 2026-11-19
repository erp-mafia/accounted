/**
 * POST /api/v1/companies/{companyId}/customers/bulk-create
 *
 * Bulk-create up to 50 customers in one call. Each item is validated and
 * inserted independently: per-item failures don't roll back successes.
 * Mirrors the shape of /invoices/bulk-create exactly so agents only need
 * to learn one bulk pattern.
 *
 * Response: `{ results: [{ ok, request_index, data?, error? }], summary }`.
 * Idempotent over the whole batch. Dry-runnable.
 *
 * VIES validation for eu_business customers is best-effort PER ITEM. A VIES
 * timeout does NOT fail the item: it just leaves vat_number_validated=false.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateCustomerSchema } from '@/lib/api/schemas'
import { createCustomer } from '@/lib/customers/customer-commands'
import { customerRecordOutcome } from '@/lib/customers/customer-record'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import type { OperationContext } from '@/lib/operations/types'

const BulkCreateRequest = z.object({
  customers: z.array(CreateCustomerSchema).min(1).max(50),
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
  operation: 'customers.bulk-create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/customers/bulk-create',
  summary: 'Create up to 50 customers in one call (partial-success).',
  description:
    'Bulk-create endpoint mirroring /invoices/bulk-create. Each customer is validated and inserted independently: per-item failures do not roll back items that succeeded. Returns a results array plus a summary. Idempotent over the whole batch. Dry-runnable.',
  useWhen:
    'You\'re importing a roster of customers from another CRM, or seeding a fresh company with its existing client list. Use dry-run first to validate the batch.',
  doNotUseFor:
    'Updating existing customers: PATCH /customers/{id} once per customer. Bulk uploads of > 50 customers: split into pages of 50. Transactional all-or-nothing imports: passing all_or_nothing: true returns 501 NOT_IMPLEMENTED.',
  pitfalls: [
    'Idempotency-Key is mandatory and covers the WHOLE batch. A retried bulk-create returns the cached full response: it does not retry only the failed items.',
    'Passing all_or_nothing: true returns 501 NOT_IMPLEMENTED. Today only partial-success batches exist; omit the flag or pass false.',
    'org_number uniqueness is enforced at the DB level: items with duplicates fail individually with CUSTOMER_DUPLICATE_ORG_NUMBER.',
    'VIES validation for eu_business customers is best-effort per item; a VIES timeout leaves vat_number_validated=false but does NOT fail the item.',
  ],
  example: {
    request: {
      customers: [
        { name: 'Acme AB', customer_type: 'swedish_business', org_number: '556677-8899' },
        { name: 'Foo OY', customer_type: 'eu_business', vat_number: 'FI12345678' },
      ],
    },
    response: {
      data: {
        results: [
          { ok: true, request_index: 0, data: { id: '0e9c…', name: 'Acme AB' } },
          { ok: true, request_index: 1, data: { id: '4d2a…', name: 'Foo OY' } },
        ],
        summary: { total: 2, succeeded: 2, failed: 0 },
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'customers:write',
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
 * One item through the single create (lib/customers/customer-commands.ts), the
 * insert and rule set every customer door shares, answered as a result item.
 */
async function createOneCustomer(
  ctx: OperationContext,
  index: number,
  input: z.infer<typeof CreateCustomerSchema>,
  dryRun: boolean,
): Promise<ResultItem> {
  const outcome = customerRecordOutcome(await createCustomer(ctx, input, { dryRun }))
  if (outcome.ok) {
    return outcome.dryRun
      ? { ok: true, request_index: index, data: { preview: outcome.preview } }
      : { ok: true, request_index: index, data: outcome.data }
  }
  if (outcome.code === 'CUSTOMER_CREATE_FAILED') {
    return {
      ok: false,
      request_index: index,
      error: {
        code: outcome.code,
        message: 'Customer insert failed.',
        details: { pg_code: (outcome.error as { code?: string } | undefined)?.code },
      },
    }
  }
  // Refusals carry the field, never the value: for a sole trader the org
  // number is the personnummer (GDPR art. 5.1 c).
  return {
    ok: false,
    request_index: index,
    error: {
      code: outcome.code,
      message: getErrorEntry(outcome.code)?.message_en ?? outcome.code,
      details: outcome.details,
    },
  }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'customers.bulk-create',
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

    // Reject all_or_nothing: true loudly. Same contract as invoices/bulk-create.
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

    // Sequential processing: matches /invoices/bulk-create. VIES has its own
    // upstream throughput limits; running a batch of 50 in parallel can trip
    // them. The 50-item cap keeps the worst-case latency bounded.
    const commandCtx = { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log }
    const results: ResultItem[] = []
    for (let i = 0; i < body.customers.length; i++) {
      results.push(await createOneCustomer(commandCtx, i, body.customers[i], ctx.dryRun))
    }

    const summary = {
      total: results.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    }

    ctx.log.info('customers.bulk-create completed', {
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
