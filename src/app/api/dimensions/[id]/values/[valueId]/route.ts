/**
 * PATCH  /api/dimensions/[id]/values/[valueId]: update a dimension value
 *         (name / is_active / start_date / end_date; `code` is immutable in v1).
 *         Rules and events: updateDimensionValue (lib/dimensions/registry-service.ts).
 * DELETE /api/dimensions/[id]/values/[valueId]: delete an UNREFERENCED value.
 *
 * Deleting a value referenced by posted/reversed lines is blocked by the DB
 * retention trigger (enforce_dimension_value_retention, BFL 7-year
 * philosophy). Its Swedish message ("Värdet "X" används på bokförda verifikat
 * och kan inte tas bort: arkivera det istället.") is surfaced verbatim as a
 * 409 DIMENSION_VALUE_REFERENCED so the register UI can toast it and offer
 * archive instead.
 */
import { NextResponse } from 'next/server'
import { validateBody } from '@/lib/api/validate'
import { UpdateDimensionValueSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { updateDimensionValue } from '@/lib/dimensions/registry-service'
import { sessionFailureResponse } from '@/lib/operations/session'

type ValueParams = { params: Promise<{ id: string; valueId: string }> }

export const PATCH = withRouteContext(
  'dimension.value.update',
  async (request, ctx, { params }: ValueParams) => {
    const { id, valueId } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const opLog = log.child({ dimensionId: id, valueId })

    const result = await validateBody(request, UpdateDimensionValueSchema, {
      log: opLog,
      operation: 'dimension.value.update',
    })
    if (!result.success) return result.response

    // The rules and the events live in updateDimensionValue, shared with v1.
    const outcome = await updateDimensionValue({ supabase, companyId, userId: user.id, log: opLog }, id, valueId, result.data)
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) return NextResponse.json({ data: outcome.preview })
    return NextResponse.json({ data: outcome.data })
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
      // P0001 = plpgsql RAISE EXCEPTION: the retention trigger refusing the
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
        details: { reason: getUserErrorMessage(error) },
      })
    }

    if (!data || data.length === 0) {
      return errorResponseFromCode('DIMENSION_VALUE_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
