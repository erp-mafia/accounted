import { NextResponse } from 'next/server'
import { generateDimensionPnl } from '@/lib/reports/dimension-pnl'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { parseReportDateRange } from '@/lib/reports/date-range'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import type { DimensionPnlReport } from '@/types'

// One row per account; the dimension values are dynamic columns, exactly as
// the on-screen matrix renders. Column labels stay Swedish (report surface).
type FlatRow = {
  group: string
  account_number: string
  account_name: string
  values: number[]
  total: number
}

export const GET = withRouteContext(
  'report.dimension_pnl_xlsx',
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

    const [{ data: companyRow }, { data: period }] = await Promise.all([
      supabase
        .from('company_settings')
        .select('company_name')
        .eq('company_id', companyId)
        .single(),
      supabase
        .from('fiscal_periods')
        .select('period_start, period_end')
        .eq('id', periodId)
        .eq('company_id', companyId)
        .single(),
    ])

    if (!period) {
      return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 })
    }

    const parsed = parseReportDateRange(searchParams, period)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    try {
      // Only toDate — the matrix is cumulative from period_start by design.
      const report: DimensionPnlReport = await generateDimensionPnl(
        supabase,
        companyId!,
        periodId,
        dimNo,
        { toDate: parsed.range.toDate },
      )

      const valueHeaders = report.columns.map((c) =>
        c.code === null ? '(Utan dimension)' : c.name ? `${c.code} ${c.name}` : c.code,
      )

      const rows: FlatRow[] = []
      for (const g of report.groups) {
        for (const r of g.rows) {
          rows.push({
            group: g.class_label,
            account_number: r.account_number,
            account_name: r.account_name,
            values: r.values,
            total: r.total,
          })
        }
      }
      rows.push({
        group: 'Resultat',
        account_number: '',
        account_name: 'Beräknat resultat',
        values: report.net_per_column,
        total: report.net_total,
      })

      const workbook = reportToWorkbook<FlatRow>([
        {
          name: `Resultat per ${report.dimension.name}`.slice(0, 31),
          columns: [
            textColumn('Grupp'),
            textColumn('Konto'),
            textColumn('Benämning'),
            ...valueHeaders.map((h) => currencyColumn(h)),
            currencyColumn('Totalt'),
          ],
          rows,
          mapRow: (r) => [r.group, r.account_number, r.account_name, ...r.values, r.total],
        },
      ])

      const filename = xlsxFilename(
        'resultat-per-dimension',
        companyRow?.company_name ?? '',
        report.period.end,
      )

      return new NextResponse(new Uint8Array(workbook), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
      })
    } catch (err) {
      log.error('dimension pnl xlsx failed', err as Error, { periodId, dimNo })
      return errorResponseFromCode('REPORT_GENERATION_FAILED', log, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
)
