import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import { generateResultatrapport } from '@/lib/reports/resultatrapport'
import { parseReportDateRange } from '@/lib/reports/date-range'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  percentColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import { formatLatestVouchers, LATEST_VOUCHERS_LABEL } from '@/lib/reports/latest-vouchers-format'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { fileResponse } from '@/lib/api/file-response'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { budgetDisclosure, parseBudgetParam, ReportBudgetError } from '@/lib/budgets/report-budget'
import type { BudgetComparison, ResultatrapportRow, ResultatrapportSubgroup } from '@/types'

interface FlatRow {
  group: string
  account_number: string
  account_name: string
  current_period: number
  prior_period: number
  budget?: BudgetComparison
}

/** A preamble row: text in the first column, every figure empty. */
function noteRow(text: string): FlatRow {
  return {
    group: text,
    account_number: '',
    account_name: '',
    current_period: null as unknown as number,
    prior_period: null as unknown as number,
  }
}

export const GET = withRouteContext('report.resultatrapport.xlsx', async (request, { supabase, companyId, log, requestId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }
  const budgetParam = parseBudgetParam(searchParams)
  if (!budgetParam.ok) {
    return NextResponse.json({ error: budgetParam.error }, { status: 400 })
  }

  const [{ data: companyRow }, { data: period, error: periodError }] = await Promise.all([
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
      .maybeSingle(),
  ])

  if (periodError) throw periodError
  // A period_id that is not the active company's (a page still holding the
  // previous company's year right after a company switch) is a stale request,
  // not a failure: say so, and generate nothing from another company's period.
  if (!period) {
    return errorResponseFromCode('PERIOD_NOT_FOUND', log.child({ periodId }), { requestId })
  }

  const parsed = parseReportDateRange(searchParams, period)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  try {
    const report = await generateResultatrapport(supabase, companyId, periodId, {
      ...parsed.range,
      dimensions: dimFilter.dimensions,
      budgetId: budgetParam.budgetId,
    })
    const withBudget = report.budget?.applied === true

    const rows: FlatRow[] = []
    const pushRows = (group: string, accounts: ResultatrapportRow[], sum: FlatRow) => {
      for (const r of accounts) {
        rows.push({
          group,
          account_number: r.account_number,
          account_name: r.account_name,
          current_period: r.current_period,
          prior_period: r.prior_period,
          budget: r.budget,
        })
      }
      rows.push(sum)
    }
    const pushSubgroup = (sub: ResultatrapportSubgroup) =>
      pushRows(sub.label, sub.rows, {
        group: sub.label,
        account_number: '',
        account_name: sub.total_label,
        current_period: sub.subtotal_current,
        prior_period: sub.subtotal_prior,
        budget: sub.subtotal_budget,
      })
    for (const g of report.groups) {
      if (g.subgroups) {
        // Class 8 in the resultaträkning's blocks: Resultat efter finansiella
        // poster after the blocks above that line.
        g.subgroups.filter((sub) => sub.above_result_after_financial).forEach(pushSubgroup)
        if (report.result_after_financial) {
          rows.push({
            group: 'Resultat',
            account_number: '',
            account_name: report.result_after_financial.label,
            current_period: report.result_after_financial.current,
            prior_period: report.result_after_financial.prior,
            budget: report.result_after_financial.budget,
          })
        }
        g.subgroups.filter((sub) => !sub.above_result_after_financial).forEach(pushSubgroup)
        continue
      }
      pushRows(g.class_label, g.rows, {
        group: g.class_label,
        account_number: '',
        account_name: `Summa ${g.class_label}`,
        current_period: g.subtotal_current,
        prior_period: g.subtotal_prior,
        budget: g.subtotal_budget,
      })
    }
    rows.push({
      group: 'Resultat',
      account_number: '',
      account_name: 'Beräknat resultat',
      current_period: report.net_result_current,
      prior_period: report.net_result_prior,
      budget: report.net_result_budget,
    })

    // Which budget the Budget columns read, or why there are none.
    const budgetNote = budgetDisclosure(report.budget)
    if (budgetNote) rows.unshift(noteRow(budgetNote))

    // Reconciliation aid (#1267). reportToWorkbook has no preamble concept, so
    // this rides as a first body row, the same way the disclosure below does.
    // Unshifted first so the disclosure, when present, still ends up on top.
    const vouchersLabel = formatLatestVouchers(report.latest_vouchers)
    if (vouchersLabel) {
      rows.unshift(noteRow(`${LATEST_VOUCHERS_LABEL}: ${vouchersLabel}`))
    }

    // Partial-view disclosure survives the file boundary: a filtered export
    // must never be mistakable for the authoritative report (BFNAR 2013:2).
    const disclosure = dimensionFilterDisclosure(dimFilter.dimensions)
    if (disclosure) {
      rows.unshift(noteRow(disclosure))
    }

    const buffer = await reportToWorkbook<FlatRow>([
      {
        name: 'Resultatrapport',
        columns: [
          textColumn('Grupp'),
          textColumn('Konto'),
          textColumn('Kontonamn'),
          currencyColumn('Aktuell period'),
          ...(withBudget
            ? [currencyColumn('Budget'), currencyColumn('Avvikelse'), percentColumn('Avvikelse %')]
            : []),
          currencyColumn('Föregående period'),
        ],
        rows,
        mapRow: (r) => [
          r.group,
          r.account_number,
          r.account_name,
          r.current_period,
          ...(withBudget
            ? [
                r.budget?.budget ?? null,
                r.budget?.deviation ?? null,
                // The column's format is a fraction (0.00%); the report answers percent.
                r.budget?.deviation_percent == null ? null : r.budget.deviation_percent / 100,
              ]
            : []),
          r.prior_period,
        ],
      },
    ])

    const filename = xlsxFilename(
      `resultatrapport${dimensionFilterFileSuffix(dimFilter.dimensions)}`,
      companyRow?.company_name ?? '',
      report.period.end,
    )
    return fileResponse(new Uint8Array(buffer), { filename: filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  } catch (err) {
    if (err instanceof ReportBudgetError) return errorResponseFromCode(err.code, log, { requestId })
    log.error('resultatrapport xlsx generation failed', err as Error, { periodId })
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera resultatrapport' },
      { status: 500 }
    )
  }
}, { requireCompleteLedger: true })
