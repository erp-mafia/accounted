/**
 * Fora's monthly report for one company and one payment month: the file the
 * employer uploads on Fora's Mina sidor, and the summary the user checks
 * before uploading it. A pure read: nothing is stored or stamped, because a
 * file sent twice replaces itself at Fora (./file.ts).
 *
 * The month is the payment month, as for the AGI (kontantprincipen; Fora:
 * "Lönen ska rapporteras på den månad den har betalats ut"): every salary run
 * whose payment_date falls in it. Approved, paid and booked runs count. A
 * run a correction replaced ('corrected') is left out for its correction,
 * which keeps the original payment_date. A draft or a run in review is not
 * paid yet: it is left out with a warning.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre, sumOre } from '@/lib/money'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import { maskPersonnummer } from '@/lib/salary/personnummer-format'
import { foraPayAmount, type ForaPayLine } from './pay'
import {
  buildForaFile,
  foraOrganizationNumber,
  type ForaEmployeeInput,
  type ForaFile,
  type ForaIssue,
  type ForaWarning,
} from './file'

const COUNTED_STATUSES = new Set(['approved', 'paid', 'booked'])
const UNPAID_STATUSES = new Set(['draft', 'review'])

export interface ForaReportPayroll {
  employee_id: string
  employee_name: string
  personnummer_masked: string
  fok_id: string
  /** Whole kronor, as in the file. */
  pay_amount: number
  employment_end: string | null
}

export interface ForaMonthlyReport {
  year: number
  month: number
  /** "Fora_<orgnr>_<YYYYMM>.json" */
  filename: string
  file: ForaFile
  payrolls: ForaReportPayroll[]
  total_pay_amount: number
  /** The salary runs whose pay is in the file. */
  salary_run_ids: string[]
  warnings: ForaWarning[]
}

export type ForaMonthlyReportResult =
  | { ok: true; data: ForaMonthlyReport }
  | { ok: false; code: 'FORA_REPORT_INCOMPLETE'; issues: ForaIssue[] }
  | { ok: false; code: 'COMPANY_NOT_FOUND' }
  | { ok: false; code: 'DB_ERROR'; cause: unknown }

interface RunRow {
  id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string
}

interface RunEmployeeRow {
  id: string
  salary_run_id: string
  employee_id: string
  gross_salary: number | string
  line_items: ForaPayLine[] | null
}

interface EmployeeRow {
  id: string
  first_name: string
  last_name: string
  personnummer: string
  employment_type: string
  personnel_category: string
  employment_start: string
  employment_end: string | null
  address_line1: string | null
  postal_code: string | null
  city: string | null
  fora_fok_id: string | null
  fora_fok_start_date: string | null
  is_active: boolean
}

function monthRange(year: number, month: number): { first: string; last: string } {
  const mm = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { first: `${year}-${mm}-01`, last: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` }
}

function periodLabel(run: { period_year: number; period_month: number }): string {
  return `${run.period_year}-${String(run.period_month).padStart(2, '0')}`
}

export async function generateForaMonthlyReport(
  supabase: SupabaseClient,
  args: { companyId: string; year: number; month: number },
): Promise<ForaMonthlyReportResult> {
  const { companyId, year, month } = args
  const { first, last } = monthRange(year, month)

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('org_number')
    .eq('id', companyId)
    .maybeSingle()
  if (companyError) return { ok: false, code: 'DB_ERROR', cause: companyError }
  if (!company) return { ok: false, code: 'COMPANY_NOT_FOUND' }
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('org_number')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) return { ok: false, code: 'DB_ERROR', cause: settingsError }
  // The current number wins over the one frozen at onboarding, as for the AGI.
  const orgNumber = (settings?.org_number || company.org_number || '').trim()

  const { data: runRows, error: runError } = await supabase
    .from('salary_runs')
    .select('id, status, period_year, period_month, payment_date')
    .eq('company_id', companyId)
    .gte('payment_date', first)
    .lte('payment_date', last)
    .order('payment_date', { ascending: true })
  if (runError) return { ok: false, code: 'DB_ERROR', cause: runError }
  const runs = (runRows ?? []) as RunRow[]

  const warnings: ForaWarning[] = []
  for (const run of runs) {
    if (UNPAID_STATUSES.has(run.status)) {
      warnings.push({
        code: 'FORA_RUN_NOT_APPROVED',
        salary_run_id: run.id,
        run_period: periodLabel(run),
        payment_date: run.payment_date,
        message: `Lönekörningen för ${periodLabel(run)} med utbetalning ${run.payment_date} är inte godkänd och är inte med i filen.`,
      })
    }
  }
  const countedRuns = runs.filter((run) => COUNTED_STATUSES.has(run.status))
  const countedRunIds = countedRuns.map((run) => run.id)

  let runEmployees: RunEmployeeRow[] = []
  if (countedRunIds.length > 0) {
    try {
      runEmployees = await fetchAllRows<RunEmployeeRow>(({ from, to }) =>
        supabase
          .from('salary_run_employees')
          .select(
            'id, salary_run_id, employee_id, gross_salary, line_items:salary_line_items(item_type, amount, is_taxable, is_gross_deduction, is_net_deduction)',
          )
          .eq('company_id', companyId)
          .in('salary_run_id', countedRunIds)
          .order('id', { ascending: true })
          .range(from, to),
      )
    } catch (cause) {
      return { ok: false, code: 'DB_ERROR', cause }
    }
  }

  // Fora pay per employee, summed over the month's runs.
  const payByEmployee = new Map<string, number[]>()
  for (const sre of runEmployees) {
    const amounts = payByEmployee.get(sre.employee_id) ?? []
    amounts.push(foraPayAmount(sre.gross_salary, sre.line_items ?? []))
    payByEmployee.set(sre.employee_id, amounts)
  }

  // Everyone with a code, plus whoever was paid (to name an arbetare without one).
  let employees: EmployeeRow[]
  try {
    employees = await fetchAllRows<EmployeeRow>(({ from, to }) =>
      supabase
        .from('employees')
        .select(
          'id, first_name, last_name, personnummer, employment_type, personnel_category, employment_start, employment_end, address_line1, postal_code, city, fora_fok_id, fora_fok_start_date, is_active',
        )
        .eq('company_id', companyId)
        .not('fora_fok_id', 'is', null)
        .order('id', { ascending: true })
        .range(from, to),
    )
    const coded = new Set(employees.map((e) => e.id))
    const paidWithoutCode = [...payByEmployee.keys()].filter((id) => !coded.has(id))
    if (paidWithoutCode.length > 0) {
      const { data, error } = await supabase
        .from('employees')
        .select(
          'id, first_name, last_name, personnummer, employment_type, personnel_category, employment_start, employment_end, address_line1, postal_code, city, fora_fok_id, fora_fok_start_date, is_active',
        )
        .eq('company_id', companyId)
        .in('id', paidWithoutCode)
      if (error) return { ok: false, code: 'DB_ERROR', cause: error }
      employees = [...employees, ...((data ?? []) as EmployeeRow[])]
    }
  } catch (cause) {
    return { ok: false, code: 'DB_ERROR', cause }
  }

  const hasCodedEmployees = employees.some((e) => e.fora_fok_id)
  const inputs: ForaEmployeeInput[] = []
  const personnummerById = new Map<string, string>()
  for (const e of employees) {
    const amounts = payByEmployee.get(e.id)
    const pay = amounts ? roundOre(sumOre(amounts)) : null
    if (!e.fora_fok_id || !e.fora_fok_start_date) {
      // Only worth saying once the company reports to Fora at all.
      if (hasCodedEmployees && pay !== null && e.employment_type === 'employee' && e.personnel_category === 'arbetare') {
        const name = `${e.first_name} ${e.last_name}`.trim()
        warnings.push({
          code: 'FORA_ARBETARE_WITHOUT_CODE',
          employee_id: e.id,
          employee_name: name,
          message: `${name} är arbetare och fick lön i månaden men har ingen Fora-kod, så lönen är inte med i filen. Lägg in koden på den anställda om hen ska rapporteras till Fora.`,
        })
      }
      continue
    }
    // A deactivated employee with nothing paid this month is not reported again.
    if (!e.is_active && pay === null) continue
    const personnummer = decryptPersonnummer(e.personnummer)
    personnummerById.set(e.id, personnummer)
    inputs.push({
      id: e.id,
      personnummer,
      firstName: e.first_name,
      lastName: e.last_name,
      addressLine1: e.address_line1,
      postalCode: e.postal_code,
      city: e.city,
      fokId: e.fora_fok_id,
      fokStartDate: e.fora_fok_start_date,
      employmentStart: e.employment_start,
      employmentEnd: e.employment_end,
      pay,
    })
  }

  const built = buildForaFile({ orgNumber, year, month, employees: inputs })
  if (!built.ok) return { ok: false, code: 'FORA_REPORT_INCOMPLETE', issues: built.issues }

  const payrolls: ForaReportPayroll[] = built.payrolls.map((p) => ({
    ...p,
    personnummer_masked: maskPersonnummer(personnummerById.get(p.employee_id)),
  }))
  const period = `${year}${String(month).padStart(2, '0')}`
  return {
    ok: true,
    data: {
      year,
      month,
      filename: `Fora_${foraOrganizationNumber(orgNumber)}_${period}.json`,
      file: built.file,
      payrolls,
      total_pay_amount: payrolls.reduce((sum, p) => sum + p.pay_amount, 0),
      salary_run_ids: countedRunIds,
      warnings: [...warnings, ...built.warnings],
    },
  }
}
