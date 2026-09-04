/**
 * PATCH /api/dimensions/[id]: update a dimension (name / is_active / sort_order).
 * DELETE /api/dimensions/[id]: remove a custom dimension nobody has booked on.
 *
 * Guard rails:
 *   - Renaming an is_system dimension (1 = Kostnadsställe, 6 = Projekt) is
 *     rejected with 400 DIMENSION_SYSTEM_RENAME ("Systemdimensioner kan inte
 *     döpas om"). Archiving (is_active=false) and reordering remain allowed.
 *   - sie_dim_no / is_system are immutable at the DB level
 *     (enforce_dimension_registry_guards) and not accepted here at all.
 *   - DELETE (issue #2219): a system dimension answers 400
 *     DIMENSION_SYSTEM_DELETE before the DB is asked. A custom dimension whose
 *     number is tagged on any posted/reversed line is refused by the same DB
 *     guard with a P0001 that names the dimension; that message rides the 409
 *     DIMENSION_REFERENCED envelope verbatim. Values cascade (ON DELETE
 *     CASCADE) and the value retention trigger fires on the cascade too, so
 *     nothing booked can ever be pulled out from under a verifikat.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { UpdateDimensionSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

export const PATCH = withRouteContext(
  'dimension.update',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ dimensionId: id })

    const result = await validateBody(request, UpdateDimensionSchema, {
      log: opLog,
      operation: 'dimension.update',
    })
    if (!result.success) return result.response
    const body = result.data

    const { data: existing, error: fetchError } = await supabase
      .from('dimensions')
      .select('id, name, is_system')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchError) {
      opLog.error('dimension fetch failed', fetchError)
      return errorResponse(fetchError, opLog, { requestId })
    }
    if (!existing) {
      return errorResponseFromCode('DIMENSION_NOT_FOUND', opLog, { requestId })
    }

    if (existing.is_system && body.name !== undefined && body.name !== existing.name) {
      return errorResponseFromCode('DIMENSION_SYSTEM_RENAME', opLog, { requestId })
    }

    // Sparse update: only the fields the caller actually sent.
    const updateData: Record<string, unknown> = {}
    for (const key of ['name', 'is_active', 'sort_order'] as const) {
      if (body[key] !== undefined) updateData[key] = body[key]
    }

    const { data, error } = await supabase
      .from('dimensions')
      .update(updateData)
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id, sie_dim_no, name, resets_annually, is_system, is_active, sort_order')
      .single()

    if (error) {
      opLog.error('dimension update failed', error)
      return errorResponseFromCode('DIMENSION_UPDATE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'dimension.delete',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ dimensionId: id })

    const { data: existing, error: fetchError } = await supabase
      .from('dimensions')
      .select('id, name, is_system')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (fetchError) {
      opLog.error('dimension fetch failed', fetchError)
      return errorResponse(fetchError, opLog, { requestId })
    }
    if (!existing) {
      return errorResponseFromCode('DIMENSION_NOT_FOUND', opLog, { requestId })
    }
    if (existing.is_system) {
      return errorResponseFromCode('DIMENSION_SYSTEM_DELETE', opLog, { requestId })
    }

    const { data, error } = await supabase
      .from('dimensions')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)
      .select('id')

    if (error) {
      // P0001 = plpgsql RAISE EXCEPTION: the registry guard (or the value
      // retention trigger on the cascade) refusing the delete. Surface its
      // Swedish message verbatim: it names the dimension / code.
      if (error.code === 'P0001') {
        return errorResponseFromCode('DIMENSION_REFERENCED', opLog, {
          requestId,
          messageSv: error.message,
        })
      }
      opLog.error('dimension delete failed', error)
      return errorResponseFromCode('DIMENSION_DELETE_FAILED', opLog, {
        requestId,
        details: { reason: getUserErrorMessage(error) },
      })
    }

    if (!data || data.length === 0) {
      return errorResponseFromCode('DIMENSION_NOT_FOUND', opLog, { requestId })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
