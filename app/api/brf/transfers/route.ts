import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RecordBrfTransferSchema } from '@/lib/api/schemas'
import { listTransfers, recordTransfer } from '@/lib/brf/apartment-register'
import { brfRegisterErrorResponse } from '@/lib/brf/route-helpers'
import { requireBrfForm } from '@/lib/company/brf-tax-profile'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

/**
 * GET  /api/brf/transfers[?apartment_id=..][&income_year=YYYY]
 * POST /api/brf/transfers?apartment_id=..: record an överlåtelse (BRL 6 kap.)
 *      through record_brf_transfer(); the row is append-only and carries the
 *      KU55 data (SFL 22 kap.).
 */
const UUID = /^[0-9a-f-]{36}$/i

export const GET = withRouteContext('brf.transfers_list', async (request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  const params = new URL(request.url).searchParams
  const apartmentId = params.get('apartment_id') ?? undefined
  const yearRaw = params.get('income_year')
  if (apartmentId && !UUID.test(apartmentId)) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, reason: 'apartment_id must be a uuid' })
  }
  const incomeYear = yearRaw === null ? undefined : Number(yearRaw)
  if (incomeYear !== undefined && (!Number.isInteger(incomeYear) || incomeYear < 1990 || incomeYear > 2200)) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, reason: 'income_year must be a year' })
  }
  try {
    await requireBrfForm(supabase, companyId)
    const data = await listTransfers(supabase, companyId, { apartmentId, incomeYear })
    return NextResponse.json({ data })
  } catch (err) {
    return brfRegisterErrorResponse(err, log, requestId)
  }
})

export const POST = withRouteContext(
  'brf.transfer_record',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    const apartmentId = new URL(request.url).searchParams.get('apartment_id')
    if (!apartmentId || !UUID.test(apartmentId)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, reason: 'apartment_id is required' })
    }
    const validation = await validateBody(request, RecordBrfTransferSchema, {
      log,
      operation: 'brf.transfer_record',
    })
    if (!validation.success) return validation.response
    try {
      await requireBrfForm(supabase, companyId)
      const data = await recordTransfer(supabase, companyId, apartmentId, validation.data)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return brfRegisterErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
