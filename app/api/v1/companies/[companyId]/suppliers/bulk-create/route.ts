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
import type { SupabaseClient } from '@supabase/supabase-js'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { CreateSupplierSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events'
import type { Logger } from '@/lib/logger'
import type { Supplier } from '@/types'

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

const SUPPLIER_RESPONSE_COLUMNS =
  'id, name, supplier_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, bankgiro, plusgiro, bank_account, iban, bic, default_expense_account, default_payment_terms, default_currency, notes, archived_at, created_at, updated_at'

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

async function createOneSupplier(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  index: number,
  input: z.infer<typeof CreateSupplierSchema>,
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
          supplier_type: input.supplier_type,
          email: input.email ?? null,
          phone: input.phone ?? null,
          address_line1: input.address_line1 ?? null,
          address_line2: input.address_line2 ?? null,
          postal_code: input.postal_code ?? null,
          city: input.city ?? null,
          country: input.country ?? 'SE',
          org_number: input.org_number ?? null,
          vat_number: input.vat_number ?? null,
          bankgiro: input.bankgiro ?? null,
          plusgiro: input.plusgiro ?? null,
          bank_account: input.bank_account ?? null,
          iban: input.iban ?? null,
          bic: input.bic ?? null,
          default_expense_account: input.default_expense_account ?? null,
          default_payment_terms: input.default_payment_terms ?? 30,
          default_currency: input.default_currency ?? 'SEK',
          notes: input.notes ?? null,
          archived_at: null,
          created_at: null,
          updated_at: null,
        },
      },
    }
  }

  const { data, error } = await supabase
    .from('suppliers')
    .insert({
      user_id: userId,
      company_id: companyId,
      name: input.name,
      supplier_type: input.supplier_type,
      email: input.email ?? null,
      phone: input.phone ?? null,
      address_line1: input.address_line1 ?? null,
      address_line2: input.address_line2 ?? null,
      postal_code: input.postal_code ?? null,
      city: input.city ?? null,
      country: input.country ?? 'SE',
      org_number: input.org_number ?? null,
      vat_number: input.vat_number ?? null,
      bankgiro: input.bankgiro ?? null,
      plusgiro: input.plusgiro ?? null,
      bank_account: input.bank_account ?? null,
      iban: input.iban ?? null,
      bic: input.bic ?? null,
      default_expense_account: input.default_expense_account ?? null,
      default_payment_terms: input.default_payment_terms ?? 30,
      default_currency: input.default_currency ?? 'SEK',
      notes: input.notes ?? null,
    })
    .select(SUPPLIER_RESPONSE_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return {
        ok: false,
        request_index: index,
        error: {
          code: 'SUPPLIER_DUPLICATE_ORG_NUMBER',
          message: 'A supplier with this org_number already exists in this company.',
          details: { field: 'org_number' },
        },
      }
    }
    log.error('bulk-create: supplier insert failed', error, {
      request_index: index,
      companyId,
      pgCode: error.code,
    })
    return {
      ok: false,
      request_index: index,
      error: {
        code: 'SUPPLIER_CREATE_FAILED',
        message: 'Supplier insert failed.',
        details: { pg_code: error.code },
      },
    }
  }

  try {
    await eventBus.emit({
      type: 'supplier.created',
      payload: {
        supplier: {
          ...(data as Record<string, unknown>),
          user_id: userId,
          company_id: companyId,
        } as unknown as Supplier,
        companyId,
        userId,
      },
    })
  } catch (err) {
    log.warn('bulk-create: supplier.created emit failed', err as Error, {
      request_index: index,
    })
  }

  return { ok: true, request_index: index, data }
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
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        i,
        body.suppliers[i],
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
