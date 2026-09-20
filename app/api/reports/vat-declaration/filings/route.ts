import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { MarkVatFilingSchema, VatFilingPeriodSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  listVatFilings,
  markVatPeriodFiled,
  unmarkVatPeriodFiled,
} from '@/lib/vat/filing-record-store'

/**
 * /api/reports/vat-declaration/filings (issue #2746)
 *
 * The momsdeklaration page's record of which calendar VAT periods are filed.
 * The record is the period's completed moms deadline (lib/vat/filing-record.ts):
 * the Skatteverket kvittens cron completes it for declarations signed through
 * the connection, and POST here completes it for a declaration filed by hand
 * on skatteverket.se (the free path). The view reads the list to open the
 * next period once the last one is filed and to mark filed periods in the
 * picker.
 *
 *   GET    -> { data: VatFilingRecord[] }
 *   POST   { period_type, year, period, filed_on, reference? } -> { data: VatFilingRecord }
 *   DELETE ?period_type&year&period -> { data: { deadline_id } }
 *
 * Mirrored on the API-key surface at
 * /api/v1/companies/{companyId}/reports/vat-declaration/filings.
 */
export const GET = withRouteContext('report.vat_filings.list', async (_request, ctx) => {
  const { supabase, companyId } = ctx
  const data = await listVatFilings(supabase, companyId!)
  return NextResponse.json({ data })
})

export const POST = withRouteContext(
  'report.vat_filings.mark',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, MarkVatFilingSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const result = await markVatPeriodFiled(supabase, companyId!, {
      periodType: body.period_type,
      year: body.year,
      period: body.period,
      filedOn: body.filed_on,
      reference: body.reference,
      userId: user.id,
    })
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId })
    return NextResponse.json({
      data: result.record,
      created: result.created,
      changed: result.changed,
    })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'report.vat_filings.unmark',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx
    const validation = validateQuery(request, VatFilingPeriodSchema)
    if (!validation.success) return validation.response
    const query = validation.data

    const result = await unmarkVatPeriodFiled(supabase, companyId!, {
      periodType: query.period_type,
      year: query.year,
      period: query.period,
    })
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId })
    return NextResponse.json({ data: { deadline_id: result.deadline_id } })
  },
  { requireWrite: true },
)
