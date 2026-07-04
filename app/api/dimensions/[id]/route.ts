/**
 * PATCH /api/dimensions/[id]: update a dimension (name / is_active / sort_order).
 *
 * Guard rails:
 *   - Renaming an is_system dimension (1 = Kostnadsställe, 6 = Projekt) is
 *     rejected with 400 DIMENSION_SYSTEM_RENAME ("Systemdimensioner kan inte
 *     döpas om"). Archiving (is_active=false) and reordering remain allowed.
 *   - sie_dim_no / is_system are immutable at the DB level
 *     (enforce_dimension_registry_guards) and not accepted here at all.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { UpdateDimensionSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

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
        details: { reason: error.message },
      })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
