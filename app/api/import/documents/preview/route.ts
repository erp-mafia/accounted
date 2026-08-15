import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UnderlagImportPreviewSchema } from '@/lib/api/schemas'
import { buildUnderlagPlan } from '@/lib/documents/underlag-import'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'

ensureInitialized()

/**
 * POST /api/import/documents/preview: plan which verifikat each underlag file
 * belongs to, from the voucher reference in its filename.
 *
 * Read-only by construction. Only the NAMES are sent, so a user can review the
 * whole plan (including the misses) before a single byte is uploaded, and
 * before a single irreversible link is written.
 *
 * Scoped to the fiscal year the caller declares: `A31` identifies a verifikat
 * only inside a year, because source systems restart numbering annually.
 */
export const POST = withRouteContext('import.documents.preview', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  const validation = await validateBody(request, UnderlagImportPreviewSchema)
  if (!validation.success) return validation.response
  const { file_names: fileNames, fiscal_period_id: fiscalPeriodId } = validation.data

  // The period must belong to this company: buildUnderlagPlan filters entries
  // by it, and an unowned id would silently produce an all-misses plan rather
  // than an honest error.
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId!)
    .maybeSingle()

  if (periodError) {
    log.error('underlag import preview period lookup failed', periodError)
    return errorResponse(periodError, log, { requestId })
  }
  if (!period) {
    return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
  }

  try {
    const plan = await buildUnderlagPlan(supabase, companyId!, fileNames, fiscalPeriodId)
    return NextResponse.json({ data: plan })
  } catch (err) {
    log.error('underlag import preview failed', err as Error, { fileCount: fileNames.length })
    return errorResponse(err, log, { requestId })
  }
})
