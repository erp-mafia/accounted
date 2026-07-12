/**
 * POST /api/dimensions/[id]/values: create a dimension value (SIE #OBJEKT).
 *
 * Codes are validated against the strict Fortnox format
 * (^[A-Za-z0-9ÅÄÖåäö_+\-]{1,20}$) for user-created values: the DB CHECK is
 * looser by design so legacy free-text codes survive the backfill/SIE import,
 * but new registry codes minted here stay portable. Duplicate codes within the
 * dimension return 409 DIMENSION_VALUE_DUPLICATE_CODE with a Swedish message.
 * `code` is immutable after creation (v1: no rename, retag instead).
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { validateBody } from '@/lib/api/validate'
import { CreateDimensionValueSchema } from '@/lib/api/schemas'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

export const POST = withRouteContext(
  'dimension.value.create',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    const opLog = log.child({ dimensionId: id })

    const result = await validateBody(request, CreateDimensionValueSchema, {
      log: opLog,
      operation: 'dimension.value.create',
    })
    if (!result.success) return result.response
    const body = result.data

    // The dimension must exist and belong to the active company (defense in
    // depth alongside the composite FK: a foreign dimension id 404s here).
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

    // Value dates only make sense on accumulating dimensions (projekt-style
    // ranges). A resets-annually dimension (e.g. kostnadsställe) rejects any
    // request carrying an actual date (explicit null is a harmless no-op).
    if (dimension.resets_annually && (body.start_date != null || body.end_date != null)) {
      return errorResponseFromCode('DIMENSION_VALUE_DATES_NOT_ALLOWED', opLog, { requestId })
    }

    const { data, error } = await supabase
      .from('dimension_values')
      .insert({
        company_id: companyId,
        dimension_id: id,
        code: body.code,
        name: body.name,
        // Default true; is_active=false makes "create as archived" atomic
        // (no follow-up PATCH from the register UI).
        is_active: body.is_active ?? true,
        start_date: body.start_date ?? null,
        end_date: body.end_date ?? null,
      })
      .select('id, dimension_id, code, name, is_active, start_date, end_date')
      .single()

    if (error) {
      if (error.code === '23505') {
        return errorResponseFromCode('DIMENSION_VALUE_DUPLICATE_CODE', opLog, {
          requestId,
          details: { code: body.code },
        })
      }
      opLog.error('dimension value insert failed', error)
      return errorResponseFromCode('DIMENSION_VALUE_CREATE_FAILED', opLog, {
        requestId,
        details: { reason: error.message },
      })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
