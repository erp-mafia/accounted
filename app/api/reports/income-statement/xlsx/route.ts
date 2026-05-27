import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { requireCompanyId } from '@/lib/company/context'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'
import type { IncomeStatementSection } from '@/types'

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

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

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

  try {
    const report = await generateIncomeStatement(supabase, companyId, periodId)

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
    const financialRows = flatten(
      report.financial_sections,
      'Finansiella poster',
      'Summa finansiella poster',
      report.total_financial,
    )

    const summaryRows: FlatRow[] = [
      {
        section: 'Sammanfattning',
        account_number: '',
        account_name: 'Rörelseresultat',
        amount: Math.round((report.total_revenue - report.total_expenses) * 100) / 100,
      },
      {
        section: 'Sammanfattning',
        account_number: '',
        account_name: 'Årets resultat',
        amount: report.net_result,
      },
    ]

    const columns = [
      textColumn('Sektion'),
      textColumn('Konto'),
      textColumn('Kontonamn'),
      currencyColumn('Belopp'),
    ]
    const mapRow = (r: FlatRow) => [r.section, r.account_number, r.account_name, r.amount]

    const buffer = reportToWorkbook<FlatRow>([
      { name: 'Intäkter', columns, rows: revenueRows, mapRow },
      { name: 'Kostnader', columns, rows: expenseRows, mapRow },
      { name: 'Finansiella poster', columns, rows: financialRows, mapRow },
      { name: 'Sammanfattning', columns, rows: summaryRows, mapRow },
    ])

    const filename = xlsxFilename(
      'resultatrakning',
      companyRow?.company_name ?? '',
      period.period_end,
    )
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera resultaträkning' },
      { status: 500 }
    )
  }
}
