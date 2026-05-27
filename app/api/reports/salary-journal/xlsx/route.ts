import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { generateSalaryJournal } from '@/lib/reports/salary-journal'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  dateColumn,
  integerColumn,
  xlsxFilename,
} from '@/lib/reports/xlsx-export'

function toDate(s: string): Date | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || new Date().getFullYear().toString())
  const monthFrom = searchParams.get('month_from') ? parseInt(searchParams.get('month_from')!) : undefined
  const monthTo = searchParams.get('month_to') ? parseInt(searchParams.get('month_to')!) : undefined

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  try {
    const report = await generateSalaryJournal(supabase, companyId, year, monthFrom, monthTo)

    const buffer = reportToWorkbook([
      {
        name: 'Lönejournal',
        columns: [
          textColumn('Anställd'),
          textColumn('Personnr (4)'),
          textColumn('Anställning'),
          integerColumn('År'),
          integerColumn('Månad'),
          dateColumn('Utbetalningsdatum'),
          currencyColumn('Bruttolön'),
          currencyColumn('Skatt'),
          currencyColumn('Nettolön'),
          currencyColumn('Arbetsgivaravgifter'),
          currencyColumn('Semesterlönereservation'),
          currencyColumn('Semesterskuld avgifter'),
          currencyColumn('Total arbetsgivarkostnad'),
          integerColumn('Sjukdagar'),
          integerColumn('VAB-dagar'),
          integerColumn('Föräldradagar'),
          integerColumn('Semesterdagar uttagna'),
          textColumn('Status'),
        ],
        rows: report.rows,
        mapRow: (r) => [
          r.employeeName,
          r.personnummerLast4,
          r.employmentType,
          r.periodYear,
          r.periodMonth,
          toDate(r.paymentDate),
          r.grossSalary,
          r.taxWithheld,
          r.netSalary,
          r.avgifterAmount,
          r.vacationAccrual,
          r.vacationAccrualAvgifter,
          r.totalEmployerCost,
          r.sickDays,
          r.vabDays,
          r.parentalDays,
          r.vacationDaysTaken,
          r.salaryRunStatus,
        ],
      },
    ])

    // Use the period's last month-end as the filename anchor. For full-year
    // reports this is `YYYY-12-31`; for narrowed month ranges we approximate
    // with the end month's last day (good enough for filename ordering).
    const endMonth = monthTo ?? 12
    const periodAnchor = `${year}-${String(endMonth).padStart(2, '0')}-31`
    const filename = xlsxFilename(
      'lonejournal',
      companyRow?.company_name ?? '',
      periodAnchor,
    )
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Kunde inte generera lönejournal' },
      { status: 500 }
    )
  }
}
