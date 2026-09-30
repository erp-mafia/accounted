/**
 * POST /api/v1/companies/{companyId}/dimensions/{id}/values
 *
 * Create a dimension value (SIE #OBJEKT). Idempotent (mandatory
 * Idempotency-Key), dry-runnable. Codes follow the strict Fortnox format
 * (^[A-Za-z0-9ÅÄÖåäö_+\-]{1,20}$) for user-created values; the DB CHECK is
 * looser by design so legacy free-text codes survive imports. `code` is
 * immutable after creation.
 *
 * The rules (dimension in the company, dates only on an accumulating
 * dimension, is_active honoured, duplicate code = 409) live in
 * createDimensionValue (lib/dimensions/registry-service.ts), shared with the
 * dashboard route and the gnubok_create_dimension_value commit.
 */
import { z } from 'zod'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateDimensionValueSchema } from '@/lib/api/schemas'
import { createDimensionValue } from '@/lib/dimensions/registry-service'
import { v1OutcomeResponse } from '@/lib/operations/v1'

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
    'Registers a new value (SIE #OBJEKT) under a dimension: e.g. a new project code under dimension 6. Requires Idempotency-Key (UUID). Supports ?dry_run=true to validate the code format without committing. The `:id` path segment is the dimension row id (from GET …/dimensions), not the sie_dim_no. Send is_active=false to create the value archived. start_date/end_date are only allowed on accumulating dimensions (resets_annually=false, e.g. dim 6 Projekt). Duplicate codes within the dimension return 409 DIMENSION_VALUE_DUPLICATE_CODE.',
  useWhen:
    'A voucher or invoice references a cost centre / project code that does not exist yet and the user has confirmed it should be created.',
  doNotUseFor:
    'Renaming or archiving an existing value (PATCH …/dimensions/{id}/values/{valueId}). Tagging lines: pass the dimensions map on the journal-entry line instead.',
  pitfalls: [
    'Idempotency-Key is mandatory: calls without it return 400 VALIDATION_ERROR.',
    'The :id segment is the dimension UUID, not the SIE dimension number.',
    'Codes are limited to the strict Fortnox charset (A-Ö, digits, _, +, -; max 20 chars) even though historical imported codes may be looser.',
    'code is immutable after creation: there is no rename in v1; create the correct code and archive the wrong one.',
    'start_date/end_date return 400 DIMENSION_VALUE_DATES_NOT_ALLOWED on resets_annually dimensions (dim 1 Kostnadsställe).',
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
  response: {
    success: dataEnvelope(DimensionValueCreated),
    errorCodes: ['DIMENSION_NOT_FOUND', 'DIMENSION_VALUE_DATES_NOT_ALLOWED', 'DIMENSION_VALUE_DUPLICATE_CODE'],
  },
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

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response

    const parsed = CreateDimensionValueSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    const outcome = await createDimensionValue(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
      id,
      parsed.data,
      { dryRun: ctx.dryRun },
    )
    return v1OutcomeResponse(outcome, ctx)
  },
  { requireIdempotencyKey: true },
)
