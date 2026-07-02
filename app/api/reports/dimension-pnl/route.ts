import { NextResponse } from 'next/server'
import { generateDimensionPnl } from '@/lib/reports/dimension-pnl'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { parseReportDateRange } from '@/lib/reports/date-range'

// Resultat per projekt/kostnadsställe — value-as-column P&L matrix over one
// SIE dimension. ?dim_no picks the dimension (default 6, projekt).
export const GET = withRouteContext(
  'report.dimension_pnl',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const { searchParams } = new URL(request.url)
    const periodId = searchParams.get('period_id')
    const dimNo = searchParams.get('dim_no') ?? '6'

    if (!periodId) {
      return errorResponseFromCode('REPORT_PERIOD_REQUIRED', log, { requestId })
    }
    if (!/^[1-9]\d{0,3}$/.test(dimNo)) {
      return NextResponse.json({ error: 'dim_no must be an SIE dimension number' }, { status: 400 })
    }

    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single()

    if (!period) {
      return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 })
    }

    const parsed = parseReportDateRange(searchParams, period)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    try {
      // Only toDate — the matrix is cumulative from period_start by design
      // (closing-balance semantics; see lib/reports/dimension-pnl.ts).
      const data = await generateDimensionPnl(supabase, companyId!, periodId, dimNo, {
        toDate: parsed.range.toDate,
      })
      return NextResponse.json({ data })
    } catch (err) {
      log.error('dimension pnl generation failed', err as Error, { periodId, dimNo })
      return errorResponseFromCode('REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)
