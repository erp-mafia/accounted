import { withRouteContext } from '@/lib/api/with-route-context'
import { dimensionCrossMeasureNote, generateDimensionCross } from '@/lib/reports/dimension-cross'
import { dimensionCrossFailure, readDimensionCrossRequest } from '@/lib/reports/dimension-cross-request'
import { reportToWorkbook, textColumn, currencyColumn, xlsxFilename } from '@/lib/reports/xlsx-export'
import { fileResponse } from '@/lib/api/file-response'

// Dimension A down, B across, as the page shows it, with Totalt last. The
// window and the accounts ride as the first rows (reportToWorkbook has no
// preamble). Labels stay Swedish (report surface); null cells are blank.
type FlatRow = { label: string; values: Array<number | null>; total: number | null }

const UNTAGGED = '(Utan dimension)'

export const GET = withRouteContext(
  'report.dimension_cross_xlsx',
  async (request, ctx) => {
    const req = await readDimensionCrossRequest(request, ctx)
    if (!req.ok) return req.response
    try {
      const [report, { data: companyRow }] = await Promise.all([
        generateDimensionCross(ctx.supabase, ctx.companyId!, req.periodId, {
          ...req.axes,
          fromDate: req.range.fromDate,
          toDate: req.range.toDate,
        }),
        ctx.supabase.from('company_settings').select('company_name').eq('company_id', ctx.companyId!).single(),
      ])
      const label = (v: { code: string | null; name: string | null }) =>
        v.code === null ? UNTAGGED : v.name ? `${v.code} ${v.name}` : v.code
      const note = (text: string): FlatRow => ({ label: text, values: report.columns.map(() => null), total: null })
      const rows: FlatRow[] = [
        note(`Period: ${report.period.start} till ${report.period.end}`),
        note(dimensionCrossMeasureNote(report)),
        ...report.rows.map((row, i) => ({ label: label(row), values: report.cells[i], total: report.row_totals[i] })),
        { label: 'Totalt', values: report.column_totals, total: report.total },
      ]
      const workbook = await reportToWorkbook<FlatRow>([
        {
          name: `${report.dim_a.name} x ${report.dim_b.name}`.slice(0, 31),
          columns: [
            textColumn(`${report.dim_a.name} / ${report.dim_b.name}`),
            ...report.columns.map((c) => currencyColumn(label(c))),
            currencyColumn('Totalt'),
          ],
          rows,
          mapRow: (r: FlatRow) => [r.label, ...r.values, r.total],
        },
      ])
      const filename = xlsxFilename('resultat-per-tva-dimensioner', companyRow?.company_name ?? '', report.period.end)
      return fileResponse(new Uint8Array(workbook), {
        filename,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
    } catch (err) {
      return dimensionCrossFailure(err, ctx, 'dimension cross xlsx')
    }
  },
  { requireCompleteLedger: true },
)
