/**
 * PATCH  /api/dimensions/[id]/values/[valueId] — update a dimension value
 *         (name / is_active / start_date / end_date; `code` is immutable in v1).
 * DELETE /api/dimensions/[id]/values/[valueId] — delete an UNREFERENCED value.
 *
 * Deleting a value referenced by posted/reversed lines is blocked by the DB
 * retention trigger (enforce_dimension_value_retention, BFL 7-year
 * philosophy). Its Swedish message ("Värdet "X" används på bokförda verifikat
 * och kan inte tas bort — arkivera det istället.") is surfaced verbatim as a
 * 409 DIMENSION_VALUE_REFERENCED so the register UI can toast it and offer
 * archive instead.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { UpdateDimensionValueSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

type ValueParams = { params: Promise<{ id: string; valueId: string }> }

export const PATCH = withRouteContext(
  'dimension.value.update',
  async (request, ctx, { params }: ValueParams) => {
    const { id, valueId } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ dimensionId: id, valueId })

    const result = await validateBody(request, UpdateDimensionValueSchema, {
      log: opLog,
      operation: 'dimension.value.update',
    })
    if (!result.success) return result.response
    const body = result.data

    // Value dates only make sense on accumulating dimensions (projekt-style
    // ranges). When the request carries an actual date (explicit null = clear,
    // always allowed), check the parent dimension's resets_annually flag.
    if (body.start_date != null || body.end_date != null) {
      const { data: dimension, error: dimError } = await supabase
        .from('dimensions')
        .select('id, resets_annually')
        .eq('id', id)
        .eq('company_id', companyId)
        .maybeSingle()

      if (dimError) {
        opLog.error('dimension fetch failed', dimError)
        return errorResponse(dimError, opLog, { requestId })
      }
      if (!dimension) {
        return errorResponseFromCode('DIMENSION_NOT_FOUND', opLog, { requestId })
      }
      if (dimension.resets_annually) {
        return errorResponseFromCode('DIMENSION_VALUE_DATES_NOT_ALLOWED', opLog, { requestId })
      }
    }

    // Sparse update — only the fields the caller actually sent. `code` is
    // deliberately absent from the schema: renaming a code would silently
    // orphan every line tagged with it.
    const updateData: Record<string, unknown> = {}
    for (const key of ['name', 'is_active', 'start_date', 'end_date'] as const) {
      if (body[key] !== undefined) updateData[key] = body[key]
    }

    const { data, error } = await supabase
      .from('dimension_values')
      .update(updateData)
      .eq('id', valueId)
      .eq('dimension_id', id)
      .eq('company_id', companyId)
      .select('id, dimension_id, code, name, is_active, start_date, end_date')
      .single()

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponseFromCode('DIMENSION_VALUE_NOT_FOUND', opLog, { requestId })
      }
      opLog.error('dimension value update failed', error)
      return errorResponseFromCode('DIMENSION_VALUE_UPDATE_FAILED', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'dimension.value.delete',
  async (_request, ctx, { params }: ValueParams) => {
    const { id, valueId } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ dimensionId: id, valueId })

    const { data, error } = await supabase
      .from('dimension_values')
      .delete()
      .eq('id', valueId)
      .eq('dimension_id', id)
      .eq('company_id', companyId)
      .select('id')

    if (error) {
      // P0001 = plpgsql RAISE EXCEPTION — the retention trigger refusing the
      // delete. Surface its Swedish message verbatim (it names the code).
      if (error.code === 'P0001') {
        return errorResponseFromCode('DIMENSION_VALUE_REFERENCED', opLog, {
          requestId,
          messageSv: error.message,
        })
      }
      opLog.error('dimension value delete failed', error)
      return errorResponseFromCode('DIMENSION_VALUE_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    if (!data || data.length === 0) {
      return errorResponseFromCode('DIMENSION_VALUE_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
