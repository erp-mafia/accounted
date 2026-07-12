/**
 * PATCH  /api/v1/companies/{companyId}/dimensions/{id}/values/{valueId}:
 *         update a dimension value (name / is_active / start_date / end_date;
 *         `code` is immutable). Archiving (is_active=false) and setting an
 *         end_date on a project code both go through here.
 * DELETE /api/v1/companies/{companyId}/dimensions/{id}/values/{valueId}:
 *         delete an UNREFERENCED value. Values referenced by posted/reversed
 *         journal lines are protected by the DB retention trigger
 *         (enforce_dimension_value_retention, BFL 7-year philosophy) and
 *         return 409 DIMENSION_VALUE_REFERENCED: archive instead.
 *
 * Mirrors the internal /api/dimensions/[id]/values/[valueId] semantics so
 * dashboard and API behave identically.
 */
import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { UpdateDimensionValueSchema } from '@/lib/api/schemas'

const DimensionValueShape = z.object({
  id: z.string().uuid(),
  dimension_id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  is_active: z.boolean(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
})

const VALUE_COLUMNS = 'id, dimension_id, code, name, is_active, start_date, end_date'

registerEndpoint({
  operation: 'dimensions.values.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/dimensions/:id/values/:valueId',
  summary: 'Update a dimension value (rename, archive, set start/end date).',
  description:
    'Sparse update of a dimension value (SIE #OBJEKT): name, is_active (false = archive), start_date, end_date. `code` is immutable: renaming a code would orphan every journal line tagged with it; create a new value and archive the old one instead. Dates are only allowed on accumulating dimensions (resets_annually=false, e.g. dim 6 Projekt): use end_date to close a finished project. Idempotent (mandatory Idempotency-Key) and dry-runnable.',
  useWhen:
    'You need to rename a project/cost-centre, mark a finished project with an end date, or archive (is_active=false) a value that should no longer be used on new lines.',
  doNotUseFor:
    'Changing the code (immutable: create + archive instead). Removing an unused value entirely (use DELETE). Tagging lines (pass dimensions on the journal-entry line or invoice).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'The :id segment is the dimension UUID and :valueId the value UUID (both from GET …/dimensions), not SIE numbers or codes.',
    'start_date/end_date return 400 DIMENSION_VALUE_DATES_NOT_ALLOWED on resets_annually dimensions (dim 1 Kostnadsställe).',
    'Archived values (is_active=false) still appear in GET …/dimensions and remain valid on historical lines; they are only blocked for NEW tags.',
  ],
  example: {
    request: { end_date: '2026-08-31', is_active: false },
    response: {
      data: {
        id: '0e9c…',
        dimension_id: 'a8f1…',
        code: 'P001',
        name: 'Villa Almgren tak',
        is_active: false,
        start_date: null,
        end_date: '2026-08-31',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: UpdateDimensionValueSchema },
  response: { success: dataEnvelope(DimensionValueShape) },
})

registerEndpoint({
  operation: 'dimensions.values.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/dimensions/:id/values/:valueId',
  summary: 'Delete an unreferenced dimension value.',
  description:
    'Hard-deletes a dimension value (SIE #OBJEKT) that no journal line references. Values used on posted or reversed verifikat are retained for the BFL 7-year archive and cannot be deleted: the DB trigger blocks it and this endpoint returns 409 DIMENSION_VALUE_REFERENCED. Archive those instead (PATCH is_active=false). Requires Idempotency-Key.',
  useWhen:
    'A project/cost-centre code was created by mistake (typo, duplicate) and has never been used on any booking.',
  doNotUseFor:
    'Retiring a project that has bookings: PATCH is_active=false (and optionally end_date) instead. Deleting a whole dimension (not supported).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    '409 DIMENSION_VALUE_REFERENCED means the value is used on booked verifikat: it can never be deleted, only archived.',
    'Deletion is permanent: the code can be re-created afterwards, but the old row id is gone.',
  ],
  example: {
    response: {
      data: { deleted: true, id: '0e9c…' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'medium',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(z.object({ deleted: z.literal(true), id: z.string().uuid() })) },
})

type ValueRouteParams = { params: Promise<{ companyId: string; id: string; valueId: string }> }

async function resolveIds(params: ValueRouteParams['params']) {
  const { id, valueId } = await params
  const parsed = z
    .object({ id: z.string().uuid(), valueId: z.string().uuid() })
    .safeParse({ id, valueId })
  return parsed.success ? parsed.data : null
}

export const PATCH = withApiV1<ValueRouteParams>(
  'dimensions.values.update',
  async (request, ctx, { params }) => {
    const ids = await resolveIds(params)
    if (!ids) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Dimension id and value id must be UUIDs.' },
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

    const parsed = UpdateDimensionValueSchema.safeParse(rawBody)
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

    // Value dates only make sense on accumulating dimensions (projekt-style
    // ranges). When the request carries an actual date (explicit null = clear,
    // always allowed), check the parent dimension's resets_annually flag.
    // Mirrors the internal route exactly.
    if (body.start_date != null || body.end_date != null) {
      const { data: dimension, error: dimError } = await ctx.supabase
        .from('dimensions')
        .select('id, resets_annually')
        .eq('id', ids.id)
        .eq('company_id', ctx.companyId!)
        .maybeSingle()

      if (dimError) {
        return v1ErrorResponse(dimError, ctx.log, { requestId: ctx.requestId })
      }
      if (!dimension) {
        return v1ErrorResponseFromCode('DIMENSION_NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { dimension_id: ids.id },
        })
      }
      if (dimension.resets_annually) {
        return v1ErrorResponseFromCode('DIMENSION_VALUE_DATES_NOT_ALLOWED', ctx.log, {
          requestId: ctx.requestId,
        })
      }
    }

    const updateData: Record<string, unknown> = {}
    for (const key of ['name', 'is_active', 'start_date', 'end_date'] as const) {
      if (body[key] !== undefined) updateData[key] = body[key]
    }

    // Pre-flight fetch: needed for a faithful dry-run preview and a clean 404
    // before the write.
    const { data: current, error: fetchErr } = await ctx.supabase
      .from('dimension_values')
      .select(VALUE_COLUMNS)
      .eq('id', ids.valueId)
      .eq('dimension_id', ids.id)
      .eq('company_id', ctx.companyId!)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!current) {
      return v1ErrorResponseFromCode('DIMENSION_VALUE_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview({ ...current, ...updateData }, { requestId: ctx.requestId, log: ctx.log })
    }

    const { data, error } = await ctx.supabase
      .from('dimension_values')
      .update(updateData)
      .eq('id', ids.valueId)
      .eq('dimension_id', ids.id)
      .eq('company_id', ctx.companyId!)
      .select(VALUE_COLUMNS)
      .single()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    return ok(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)

export const DELETE = withApiV1<ValueRouteParams>(
  'dimensions.values.delete',
  async (_request, ctx, { params }) => {
    const ids = await resolveIds(params)
    if (!ids) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Dimension id and value id must be UUIDs.' },
      })
    }

    const { data, error } = await ctx.supabase
      .from('dimension_values')
      .delete()
      .eq('id', ids.valueId)
      .eq('dimension_id', ids.id)
      .eq('company_id', ctx.companyId!)
      .select('id')

    if (error) {
      // P0001 = plpgsql RAISE EXCEPTION: the retention trigger refusing the
      // delete because posted/reversed lines reference the value.
      if (error.code === 'P0001') {
        return v1ErrorResponseFromCode('DIMENSION_VALUE_REFERENCED', ctx.log, {
          requestId: ctx.requestId,
          details: { value_id: ids.valueId },
          validAlternatives: {
            archive_endpoint: `/api/v1/companies/${ctx.companyId}/dimensions/${ids.id}/values/${ids.valueId}`,
            archive_body: { is_active: false },
          },
        })
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    if (!data || data.length === 0) {
      return v1ErrorResponseFromCode('DIMENSION_VALUE_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    return ok({ deleted: true, id: ids.valueId }, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
