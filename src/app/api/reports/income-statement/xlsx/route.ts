import { NextResponse } from 'next/server'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { buildIncomeStatementPdfModel, incomeStatementLayout } from '@/lib/reports/financial-statement-pdf'
import { withRouteContext } from '@/lib/api/with-route-context'
import { parseReportDateRange } from '@/lib/reports/date-range'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import type { IncomeStatementSection } from '@/types'
import { parseDimensionFilterParams, dimensionFilterDisclosure, dimensionFilterFileSuffix } from '@/lib/reports/dimension-filter'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { fileResponse } from '@/lib/api/file-response'

interface FlatRow {
  section: string
  account_number: string
  account_name: string
  amount: number
}

function flatten(
  sections: IncomeStatementSection[],
  groupLabel: string,
  groupTotalLabel: string,
  groupTotal: number,
): FlatRow[] {
  const rows: FlatRow[] = []
  for (const s of sections) {
    for (const r of s.rows) {
      rows.push({
        section: s.title,
        account_number: r.account_number,
        account_name: r.account_name,
        amount: r.amount,
      })
    }
    rows.push({
      section: s.title,
      account_number: '',
      account_name: `Summa ${s.title}`,
      amount: s.subtotal,
    })
  }
  rows.push({
    section: groupLabel,
    account_number: '',
    account_name: groupTotalLabel,
    amount: groupTotal,
  })
  return rows
}

export const GET = withRouteContext('report.income_statement.xlsx', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const periodId = searchParams.get('period_id')

  if (!periodId) {
    return NextResponse.json({ error: 'period_id is required' }, { status: 400 })
  }

  const [{ data: period }, { data: companyRow }] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('period_start, period_end')
      .eq('id', periodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', companyId)
      .single(),
  ])

  if (!period) {
    return NextResponse.json({ error: 'Räkenskapsperioden kunde inte läsas.' }, { status: 400 })
  }

  const parsedRange = parseReportDateRange(searchParams, period)
  if (!parsedRange.ok) {
    return NextResponse.json({ error: parsedRange.error }, { status: 400 })
  }
  const range = parsedRange.range
  const effectiveEnd = range.toDate ?? period.period_end

  const dimFilter = parseDimensionFilterParams(searchParams)
  if (!dimFilter.ok) {
    return NextResponse.json({ error: dimFilter.error }, { status: 400 })
  }

  try {
    const report = await generateIncomeStatement(supabase, companyId, periodId, {
      ...range,
      dimensions: dimFilter.dimensions,
    })

    const revenueRows = flatten(
      report.revenue_sections,
      'Rörelseintäkter',
      'Summa rörelseintäkter',
      report.total_revenue,
    )
    const expenseRows = flatten(
      report.expense_sections,
      'Rörelsekostnader',
      'Summa rörelsekostnader',
      report.total_expenses,
    )
    // One sheet per class-8 block of the uppställningsform, as the PDF groups
    // them: 88 and 89 are not finansiella poster.
    const class8Sheets = incomeStatementLayout(report).class8.map((block) => ({
      name: block.group.heading,
      rows: flatten(block.sections, block.group.heading, block.group.totalLabel, block.total),
    }))

    // The PDF's summary lines, Resultat efter finansiella poster included.
    const summaryRows: FlatRow[] = buildIncomeStatementPdfModel(report).summary.map((line) => ({
      section: 'Sammanfattning',
      account_number: '',
      account_name: line.label,
      amount: line.amount,
    }))

    const columns = [
      textColumn('Sektion'),
      textColumn('Konto'),
      textColumn('Kontonamn'),
      currencyColumn('Belopp'),
    ]
    const mapRow = (r: FlatRow) => [r.section, r.account_number, r.account_name, r.amount]

    // Partial-view disclosure on every sheet: any tab opened alone must
    // still identify the export as filtered (BFNAR 2013:2).
    const disclosure = dimensionFilterDisclosure(dimFilter.dimensions)
    if (disclosure) {
      const note: FlatRow = {
        section: disclosure,
        account_number: '',
        account_name: '',
        amount: null as unknown as number,
      }
      for (const sheetRows of [revenueRows, expenseRows, ...class8Sheets.map((sheet) => sheet.rows), summaryRows]) {
        sheetRows.unshift(note)
      }
    }

    const buffer = await reportToWorkbook<FlatRow>([
      { name: 'Intäkter', columns, rows: revenueRows, mapRow },
      { name: 'Kostnader', columns, rows: expenseRows, mapRow },
      ...class8Sheets.map((sheet) => ({ name: sheet.name, columns, rows: sheet.rows, mapRow })),
      { name: 'Sammanfattning', columns, rows: summaryRows, mapRow },
    ])

    const filename = xlsxFilename(
      `resultatrakning${dimensionFilterFileSuffix(dimFilter.dimensions)}`,
      companyRow?.company_name ?? '',
      effectiveEnd,
    )
    return fileResponse(new Uint8Array(buffer), { filename: filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera resultaträkning' },
      { status: 500 }
    )
  }
}, { requireCompleteLedger: true })
