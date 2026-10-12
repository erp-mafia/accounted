import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { contentDisposition } from '@/lib/api/content-disposition'
import { sessionFailureResponse } from '@/lib/operations/session'
import { getVatEskdFile } from '@/lib/reports/filing-report-service'
import type { VatPeriodType } from '@/types'

/**
 * Momsdeklaration eSKDUpload (v6.0) XML file for filing at skatteverket.se via
 * "Deklarera via fil". Unlike the PDF sibling route (a read/record copy), this
 * is a real submission artifact the user uploads, reviews, signs and sends. The
 * declaration is computed purely from the bookkeeping, so no Skatteverket
 * connection is required. See lib/reports/vat-eskd-file.ts.
 *
 * The file and its refusals (settings missing, invalid org number) come from
 * getVatEskdFile, shared with GET /api/v1/.../reports/vat-declaration/eskd.
 */
export const GET = withRouteContext(
  'reports.vat-declaration.eskd',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const { searchParams } = new URL(request.url)
    const periodType = searchParams.get('periodType') as VatPeriodType | null
    const yearStr = searchParams.get('year')
    const periodStr = searchParams.get('period')
    // Yearly = räkenskapsår (see the main vat-declaration route); ignored for
    // monthly/quarterly.
    const fiscalPeriodId = searchParams.get('fiscal_period_id') ?? undefined

    if (!periodType || !yearStr || !periodStr) {
      return NextResponse.json(
        { error: 'periodType, year, and period are required' },
        { status: 400 },
      )
    }
    if (!['monthly', 'quarterly', 'yearly'].includes(periodType)) {
      return NextResponse.json({ error: 'Invalid periodType' }, { status: 400 })
    }
    const year = parseInt(yearStr, 10)
    const period = parseInt(periodStr, 10)
    if (isNaN(year) || isNaN(period)) {
      return NextResponse.json({ error: 'Invalid year or period' }, { status: 400 })
    }

    const outcome = await getVatEskdFile(
      { supabase, companyId, userId: user.id, log },
      { period_type: periodType, year, period, fiscal_period_id: fiscalPeriodId },
    )
    // Failures now answer the structured envelope (VAT_ESKD_SETTINGS_MISSING 404,
    // VAT_ESKD_ORG_NUMBER_INVALID 400) instead of a bare { error } string.
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json({ error: 'unexpected preview' }, { status: 500 })

    const file = outcome.data
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': contentDisposition('attachment', file.filename),
      },
    })
  }, { requireCompleteLedger: true })
