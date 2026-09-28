import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getCompanyDisplayName } from '@/lib/company/context'
import { roundOre } from '@/lib/money'
import {
  salaryJournalTotals,
  toSalaryJournalRow,
  type SalaryJournalReport,
  type SalaryJournalRow,
} from '@/lib/reports/salary-journal'
import { loadPostedSalaryRunEntries, type PostedSalaryEntry } from '@/lib/salary/posted-run-entries'

/**
 * Bokföringsunderlag for one salary run (Lönesammanställning): the document
 * a reader files with the run's verifikat. Per employee it carries the
 * lönejournal figures (same mapping as the lönejournal report), and below
 * them the posted verifikat exactly as booked, with account names.
 *
 * Only booked (and corrected) runs have one: before booking there is no
 * verifikat to be underlag for, and the run page already shows the preview.
 */

export interface SalaryRunUnderlagLine {
  account_number: string
  account_name: string | null
  line_description: string
  debit_amount: number
  credit_amount: number
}

export interface SalaryRunUnderlagEntry {
  description: string
  voucher: string | null
  lines: SalaryRunUnderlagLine[]
  totalDebit: number
  totalCredit: number
}

export interface SalaryRunUnderlagData {
  companyName: string
  companyOrgNumber: string
  periodYear: number
  periodMonth: number
  paymentDate: string
  /** This run is a rättelsekörning of an earlier run. */
  isCorrection: boolean
  /** This run was later replaced by a rättelsekörning. */
  corrected: boolean
  /** ISO timestamp the document was produced. */
  generatedAt: string
  rows: SalaryJournalRow[]
  totals: SalaryJournalReport['totals']
  entries: SalaryRunUnderlagEntry[]
}

export type SalaryRunUnderlagResult =
  | { ok: true; data: SalaryRunUnderlagData }
  | { ok: false; code: 'SALARY_RUN_NOT_FOUND' | 'SALARY_RUN_UNDERLAG_NOT_BOOKED' }

const UNDERLAG_STATUSES = ['booked', 'corrected']

export async function buildSalaryRunUnderlag(
  supabase: SupabaseClient,
  companyId: string,
  runId: string,
  now: Date = new Date(),
): Promise<SalaryRunUnderlagResult> {
  const { data: run, error: runError } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', runId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (runError) throw runError
  if (!run) return { ok: false, code: 'SALARY_RUN_NOT_FOUND' }
  if (!UNDERLAG_STATUSES.includes(run.status)) {
    return { ok: false, code: 'SALARY_RUN_UNDERLAG_NOT_BOOKED' }
  }

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .maybeSingle()
  if (companyError) throw companyError
  // Employer name follows the current company name, as on the payslip.
  const displayName = await getCompanyDisplayName(supabase, companyId)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const employees: any[] = await fetchAllRows(({ from, to }) =>
    supabase
      .from('salary_run_employees')
      .select('*, employee:employees(first_name, last_name, personnummer_last4, employment_type)')
      .eq('company_id', companyId)
      .eq('salary_run_id', runId)
      .order('id', { ascending: true })
      .range(from, to),
  )
  const rows = employees
    .map((sre) => toSalaryJournalRow(sre, run))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName, 'sv'))

  const posted = await loadPostedSalaryRunEntries(supabase, companyId, run)
  const postedEntries = [
    posted.salaryEntry,
    posted.avgifterEntry,
    posted.vacationEntry,
    posted.pensionEntry,
  ].filter((e): e is PostedSalaryEntry => e !== null)

  const accountNumbers = [...new Set(postedEntries.flatMap((e) => e.lines.map((l) => l.account_number)))]
  const accountNames = new Map<string, string>()
  if (accountNumbers.length > 0) {
    const { data: accounts, error: accountsError } = await supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .in('account_number', accountNumbers)
    if (accountsError) throw accountsError
    for (const a of (accounts ?? []) as Array<{ account_number: string; account_name: string }>) {
      accountNames.set(a.account_number, a.account_name)
    }
  }

  const entries: SalaryRunUnderlagEntry[] = postedEntries.map((entry) => {
    const lines = entry.lines.map((l) => ({
      account_number: l.account_number,
      account_name: accountNames.get(l.account_number) ?? null,
      line_description: l.line_description,
      debit_amount: l.debit_amount ?? 0,
      credit_amount: l.credit_amount ?? 0,
    }))
    return {
      description: entry.description,
      voucher: entry.voucher,
      lines,
      totalDebit: roundOre(lines.reduce((s, l) => s + l.debit_amount, 0)),
      totalCredit: roundOre(lines.reduce((s, l) => s + l.credit_amount, 0)),
    }
  })

  return {
    ok: true,
    data: {
      companyName: displayName ?? company?.name ?? '',
      companyOrgNumber: company?.org_number ?? '',
      periodYear: run.period_year,
      periodMonth: run.period_month,
      paymentDate: run.payment_date,
      isCorrection: run.is_correction === true,
      corrected: run.status === 'corrected',
      generatedAt: now.toISOString(),
      rows,
      totals: salaryJournalTotals(rows),
      entries,
    },
  }
}

/** "lonesammanstallning_2026-08.pdf", or "_rattelse" for a correction run. */
export function salaryRunUnderlagFileName(data: Pick<SalaryRunUnderlagData, 'periodYear' | 'periodMonth' | 'isCorrection'>): string {
  const period = `${data.periodYear}-${String(data.periodMonth).padStart(2, '0')}`
  return `lonesammanstallning_${period}${data.isCorrection ? '_rattelse' : ''}.pdf`
}
