import { NextResponse } from 'next/server'
import { generateGeneralLedger } from '@/lib/reports/general-ledger'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { parseDimensionFilterParams } from '@/lib/reports/dimension-filter'

export const GET = withRouteContext(
  'report.general_ledger',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')
    const accountFrom = searchParams.get('account_from') || undefined
    const accountTo = searchParams.get('account_to') || undefined

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }

    const dimFilter = parseDimensionFilterParams(searchParams)
    if (!dimFilter.ok) {
      return NextResponse.json({ error: dimFilter.error }, { status: 400 })
    }

    try {
      const data = await generateGeneralLedger(supabase, companyId!, periodId, accountFrom, accountTo, {
        dimensions: dimFilter.dimensions,
      })
      return NextResponse.json({ data })
    } catch (err) {
      // The raw error message is logged server-side only: it can carry
      // internal details (SQL, table names) that must not reach the client.
      log.error('general ledger generation failed', err as Error, { periodId })
      return errorResponseFromCode('REPORT_GENERATION_FAILED', log, { requestId })
    }
  },
)
