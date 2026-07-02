/**
 * POST /api/v1/companies/{companyId}/dimensions/{id}/values
 *
 * Create a dimension value (SIE #OBJEKT). Idempotent (mandatory
 * Idempotency-Key), dry-runnable. Codes follow the strict Fortnox format
 * (^[A-Za-z0-9ÅÄÖåäö_+\-]{1,20}$) for user-created values; the DB CHECK is
 * looser by design so legacy free-text codes survive imports. `code` is
 * immutable after creation.
 */
import { z } from 'zod'
import { created } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { CreateDimensionValueSchema } from '@/lib/api/schemas'

const DimensionValueCreated = z.object({
  id: z.string().uuid().nullable(),
  dimension_id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  is_active: z.boolean(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  created_at: z.string().nullable(),
})

registerEndpoint({
  operation: 'dimensions.values.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/dimensions/:id/values',
  summary: 'Create a dimension value (kostnadsställe/projekt code).',
  description:
    'Registers a new value (SIE #OBJEKT) under a dimension — e.g. a new project code under dimension 6. Requires Idempotency-Key (UUID). Supports ?dry_run=true to validate the code format without committing. The `:id` path segment is the dimension row id (from GET …/dimensions), not the sie_dim_no. Duplicate codes within the dimension return 409 DIMENSION_VALUE_DUPLICATE_CODE.',
  useWhen:
    'A voucher or invoice references a cost centre / project code that does not exist yet and the user has confirmed it should be created.',
  doNotUseFor:
    'Renaming or archiving an existing value (dashboard register in v1). Tagging lines — pass the dimensions map on the journal-entry line instead.',
  pitfalls: [
    'Idempotency-Key is mandatory — calls without it return 400 VALIDATION_ERROR.',
    'The :id segment is the dimension UUID, not the SIE dimension number.',
    'Codes are limited to the strict Fortnox charset (A–Ö, digits, _, +, -; max 20 chars) even though historical imported codes may be looser.',
    'code is immutable after creation — there is no rename in v1; create the correct code and archive the wrong one.',
  ],
  example: {
    request: { code: 'P001', name: 'Villa Almgren tak' },
    response: {
      data: {
        id: '0e9c…',
        dimension_id: 'a8f1…',
        code: 'P001',
        name: 'Villa Almgren tak',
        is_active: true,
        start_date: null,
        end_date: null,
        created_at: '2026-07-02T12:00:00Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateDimensionValueSchema },
  response: { success: dataEnvelope(DimensionValueCreated) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'dimensions.values.create',
  async (request, ctx, { params }) => {
    const { id } = await params

    if (!z.string().uuid().safeParse(id).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Dimension id must be a UUID.' },
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

    const parsed = CreateDimensionValueSchema.safeParse(rawBody)
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

    // The dimension must exist and belong to the company in the URL.
    const { data: dimension, error: dimError } = await ctx.supabase
      .from('dimensions')
      .select('id')
      .eq('id', id)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (dimError) {
      return v1ErrorResponse(dimError, ctx.log, { requestId: ctx.requestId })
    }
    if (!dimension) {
      return v1ErrorResponseFromCode('DIMENSION_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { dimension_id: id },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: null,
          dimension_id: id,
          code: body.code,
          name: body.name,
          is_active: true,
          start_date: body.start_date ?? null,
          end_date: body.end_date ?? null,
          created_at: null,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase
      .from('dimension_values')
      .insert({
        company_id: ctx.companyId!,
        dimension_id: id,
        code: body.code,
        name: body.name,
        start_date: body.start_date ?? null,
        end_date: body.end_date ?? null,
      })
      .select('id, dimension_id, code, name, is_active, start_date, end_date, created_at')
      .single()

    if (error) {
      if (error.code === '23505') {
        return v1ErrorResponseFromCode('DIMENSION_VALUE_DUPLICATE_CODE', ctx.log, {
          requestId: ctx.requestId,
          details: { code: body.code },
        })
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    return created(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
