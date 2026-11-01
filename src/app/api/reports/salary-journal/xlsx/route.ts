import { withRouteContext } from '@/lib/api/with-route-context'
import { NextResponse } from 'next/server'
import {
  generateSalaryJournal,
  type SalaryJournalGroup,
  type SalaryJournalGroupTotals,
} from '@/lib/reports/salary-journal'
import {
  reportToWorkbook,
  textColumn,
  currencyColumn,
  dateColumn,
  integerColumn,
  xlsxFilename,
  parseCellDate,
} from '@/lib/reports/xlsx-export'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { fileResponse } from '@/lib/api/file-response'
import { stockholmYearMonth } from '@/lib/dates/iso'

/** Personalkategori column: the category for employees, empty for owners and board. */
const CATEGORY_LABELS: Record<string, string> = { arbetare: 'Arbetare', tjansteman: 'Tjänsteman' }

/** The groups the totals sheet sums by (Fora reads arbetare, Collectum tjänstemän). */
const GROUP_LABELS: Record<SalaryJournalGroup, string> = {
  arbetare: 'Arbetare',
  tjansteman: 'Tjänstemän',
  company_owner: 'Företagsledare',
  board_member: 'Styrelse',
}

export const GET = withRouteContext('report.salary_journal.xlsx', async (request, { supabase, companyId }) => {
  const { searchParams } = new URL(request.url)
  const year = parseInt(searchParams.get('year') || String(stockholmYearMonth().year))
  const monthFrom = searchParams.get('month_from') ? parseInt(searchParams.get('month_from')!) : undefined
  const monthTo = searchParams.get('month_to') ? parseInt(searchParams.get('month_to')!) : undefined

  const { data: companyRow } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .single()

  try {
    const report = await generateSalaryJournal(supabase, companyId, year, monthFrom, monthTo)

    const buffer = await reportToWorkbook([
      {
        name: 'Lönejournal',
        columns: [
          textColumn('Anställd'),
          textColumn('Personnr (4)'),
          textColumn('Anställning'),
          textColumn('Personalkategori'),
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
          r.personnelCategory ? CATEGORY_LABELS[r.personnelCategory] : '',
          r.periodYear,
          r.periodMonth,
          parseCellDate(r.paymentDate),
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
      {
        name: 'Summa per kategori',
        columns: [
          textColumn('Kategori'),
          integerColumn('Anställda'),
          currencyColumn('Bruttolön'),
          currencyColumn('Skatt'),
          currencyColumn('Nettolön'),
          currencyColumn('Arbetsgivaravgifter'),
          currencyColumn('Semesterlönereservation'),
          currencyColumn('Semesterskuld avgifter'),
          currencyColumn('Total arbetsgivarkostnad'),
        ],
        rows: report.groupTotals,
        mapRow: (g: SalaryJournalGroupTotals) => [
          GROUP_LABELS[g.group],
          g.employeeCount,
          g.grossSalary,
          g.taxWithheld,
          g.netSalary,
          g.avgifterAmount,
          g.vacationAccrual,
          g.vacationAccrualAvgifter,
          g.totalEmployerCost,
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
    return fileResponse(new Uint8Array(buffer), { filename: filename, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? getUserErrorMessage(err) : 'Kunde inte generera lönejournal' },
      { status: 500 }
    )
  }
}, { requireCompleteLedger: true })
