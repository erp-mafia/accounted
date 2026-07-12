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
import type { SupabaseClient } from '@supabase/supabase-js'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { CreateCustomerSchema } from '@/lib/api/schemas'
import { validateVatNumber } from '@/lib/vat/vies-client'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'
import type { Customer } from '@/types'

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

// Same projection as the single-create endpoint: keeps response shapes
// identical so callers can union the two surfaces transparently.
const CUSTOMER_RESPONSE_COLUMNS =
  'id, name, customer_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, vat_number_validated, default_payment_terms, notes, archived_at, created_at, updated_at'

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

async function createOneCustomer(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  index: number,
  input: z.infer<typeof CreateCustomerSchema>,
  dryRun: boolean,
  log: Logger,
): Promise<ResultItem> {
  if (dryRun) {
    return {
      ok: true,
      request_index: index,
      data: {
        preview: {
          id: null,
          name: input.name,
          customer_type: input.customer_type,
          email: input.email ?? null,
          phone: input.phone ?? null,
          address_line1: input.address_line1 ?? null,
          address_line2: input.address_line2 ?? null,
          postal_code: input.postal_code ?? null,
          city: input.city ?? null,
          country: input.country ?? 'Sweden',
          org_number: input.org_number ?? null,
          vat_number: input.vat_number ?? null,
          vat_number_validated: false,
          default_payment_terms: input.default_payment_terms ?? 30,
          notes: input.notes ?? null,
          archived_at: null,
          created_at: null,
          updated_at: null,
        },
      },
    }
  }

  // Best-effort VIES validation. Resolve BEFORE the insert so the row
  // reflects validation state atomically.
  let vatValidated = false
  let vatValidatedAt: string | null = null
  if (input.customer_type === 'eu_business' && input.vat_number) {
    try {
      const vatResult = await validateVatNumber(input.vat_number)
      if (vatResult.valid) {
        vatValidated = true
        vatValidatedAt = new Date().toISOString()
      }
    } catch (err) {
      log.warn('bulk-create: VIES validation failed for item', err as Error, {
        request_index: index,
      })
    }
  }

  const { data, error } = await supabase
    .from('customers')
    .insert({
      user_id: userId,
      company_id: companyId,
      name: input.name,
      customer_type: input.customer_type,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address_line1: input.address_line1 ?? null,
      address_line2: input.address_line2 ?? null,
      postal_code: input.postal_code ?? null,
      city: input.city ?? null,
      country: input.country ?? 'Sweden',
      org_number: input.org_number ?? null,
      vat_number: input.vat_number ?? null,
      vat_number_validated: vatValidated,
      vat_number_validated_at: vatValidatedAt,
      default_payment_terms: input.default_payment_terms ?? 30,
      notes: input.notes ?? null,
    })
    .select(CUSTOMER_RESPONSE_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      // GDPR Art.5(1)(c): do NOT echo input.org_number; for sole traders
      // it IS the personnummer. The error code + field is enough: the
      // caller knows the value they submitted.
      return {
        ok: false,
        request_index: index,
        error: {
          code: 'CUSTOMER_DUPLICATE_ORG_NUMBER',
          message: 'A customer with this org_number already exists in this company.',
          details: { field: 'org_number' },
        },
      }
    }
    log.error('bulk-create: customer insert failed', error, {
      request_index: index,
      companyId,
      pgCode: error.code,
    })
    return {
      ok: false,
      request_index: index,
      error: {
        code: 'CUSTOMER_CREATE_FAILED',
        message: 'Customer insert failed.',
        details: { pg_code: error.code },
      },
    }
  }

  // Emit customer.created per success. Same cast pattern as the single
  // POST: projection omits internal scoping fields we re-inject here.
  try {
    await eventBus.emit({
      type: 'customer.created',
      payload: {
        customer: {
          ...(data as Record<string, unknown>),
          user_id: userId,
          company_id: companyId,
        } as unknown as Customer,
        companyId,
        userId,
      },
    })
  } catch (err) {
    log.warn('bulk-create: customer.created emit failed', err as Error, {
      request_index: index,
    })
  }

  return { ok: true, request_index: index, data }
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

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = BulkCreateRequest.safeParse(rawBody)
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
    const results: ResultItem[] = []
    for (let i = 0; i < body.customers.length; i++) {
      const item = await createOneCustomer(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        i,
        body.customers[i],
        ctx.dryRun,
        ctx.log,
      )
      results.push(item)
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
