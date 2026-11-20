/**
 * Builders for salary-run fixtures over payroll-fake-db.ts: rows shaped like
 * the real tables, with defaults a test overrides per case, plus a stand-in
 * for Skatteverket's tax-table API that serves the bundled 2026 tables.
 */
import { FALLBACK_TAX_TABLES } from '../tax-tables-fallback'
import type { Row } from './payroll-fake-db'

// ---------------------------------------------------------------------------
// Skatteverket's rowstore API, served from the bundled 2026 tables
// ---------------------------------------------------------------------------

export function skatteverketFetch(url: string | URL): Promise<Response> {
  const params = new URL(String(url)).searchParams
  const year = Number(params.get('år'))
  const table = Number(params.get('tabellnr'))
  const percentSection = params.get('antal dgr') === '30%'
  const offset = Number(params.get('_offset') ?? 0)
  const limit = Number(params.get('_limit') ?? 500)
  const rows = (FALLBACK_TAX_TABLES[year]?.[table] ?? []).filter((row) => (row[8] === 1) === percentSection)
  const results = rows.slice(offset, offset + limit).map((row) => ({
    'år': String(year),
    tabellnr: String(table),
    'inkomst fr.o.m.': String(row[0]),
    'inkomst t.o.m.': row[1] === 0 ? '' : String(row[1]),
    'kolumn 1': String(row[2]),
    'kolumn 2': String(row[3]),
    'kolumn 3': String(row[4]),
    'kolumn 4': String(row[5]),
    'kolumn 5': String(row[6]),
    'kolumn 6': String(row[7]),
  }))
  return Promise.resolve(new Response(JSON.stringify({ results, resultCount: rows.length }), { status: 200 }))
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

export const PAYROLL_CONFIG_2026: Row = {
  config_year: 2026,
  avgifter_total: 0.3142,
  avgifter_alderspension: 0.1021,
  avgifter_sjukforsakring: 0.0355,
  avgifter_foraldraforsakring: 0.02,
  avgifter_efterlevandepension: 0.003,
  avgifter_arbetsmarknad: 0.0264,
  avgifter_arbetsskada: 0.001,
  avgifter_allman_loneavgift: 0.1262,
  avgifter_reduced_65plus: 0.1021,
  avgifter_youth_rate: 0.2081,
  avgifter_youth_salary_cap: 25000,
  avgifter_vaxa_stod_rate: 0.1021,
  avgifter_vaxa_stod_cap: 35000,
  avgifter_minimum_annual: 1000,
  egenavgifter_total: 0.2897,
  slp_rate: 0.2426,
  prisbasbelopp: 59200,
  inkomstbasbelopp: 83400,
  max_pgi: 625500,
  sgi_ceiling: 592000,
  statlig_skatt_brytpunkt: 660400,
  traktamente_heldag: 300,
  traktamente_halvdag: 150,
  traktamente_natt: 150,
  milersattning_egen_bil: 25,
  milersattning_formansbil_fossil: 12,
  milersattning_formansbil_el: 9.5,
  kostforman_heldag: 310,
  kostforman_lunch: 124,
  kostforman_frukost: 62,
  friskvard_cap: 5000,
  bilforman_slr: 0.0255,
  sjuklon_rate: 0.8,
  karensavdrag_factor: 0.2,
  max_karensavdrag_per_year: 10,
  reduced_avgift_age: 67,
}

export function employee(companyId: string, id: string, overrides: Row = {}): Row {
  return {
    id,
    company_id: companyId,
    first_name: id,
    last_name: 'Testsson',
    personnummer: '198504120000',
    salary_type: 'monthly',
    employment_type: 'employee',
    employment_degree: 100,
    employment_start: '2019-03-01',
    employment_end: null,
    monthly_salary: 30000,
    hourly_rate: null,
    hours_per_week: 40,
    workdays_per_week: 5,
    f_skatt_status: 'a_skatt',
    is_sidoinkomst: false,
    tax_table_number: 33,
    tax_column: 1,
    jamkning_percentage: null,
    jamkning_valid_from: null,
    jamkning_valid_to: null,
    vacation_rule: 'procentregeln',
    vacation_days_per_year: 25,
    semestertillagg_rate: 0.0043,
    vacation_pay_rate: null,
    vaxa_stod_eligible: false,
    vaxa_stod_start: null,
    vaxa_stod_end: null,
    is_active: true,
    ...overrides,
  }
}

export function rosterRow(companyId: string, runId: string, emp: Row, overrides: Row = {}): Row {
  return {
    id: `sre-${runId}-${emp.id as string}`,
    salary_run_id: runId,
    employee_id: emp.id,
    company_id: companyId,
    employment_degree: emp.employment_degree,
    monthly_salary: emp.salary_type === 'monthly' ? emp.monthly_salary : 0,
    salary_type: emp.salary_type,
    hours_worked: null,
    gross_salary: 0,
    gross_deductions: 0,
    benefit_values: 0,
    taxable_income: 0,
    tax_withheld: 0,
    net_deductions: 0,
    net_salary: 0,
    avgifter_rate: 0.3142,
    avgifter_amount: 0,
    avgifter_basis: 0,
    avgifter_category: null,
    vacation_accrual: 0,
    vacation_accrual_avgifter: 0,
    tax_table_number: emp.tax_table_number,
    tax_column: emp.tax_column,
    tax_table_year: null,
    sick_days: 0,
    vab_days: 0,
    parental_days: 0,
    vacation_days_taken: 0,
    calculation_breakdown: null,
    ytd_gross: 0,
    ytd_tax: 0,
    ytd_net: 0,
    removed_from_agi: false,
    tax_withheld_override: null,
    avgifter_amount_override: null,
    avgifter_basis_override: null,
    override_reason: null,
    ...overrides,
  }
}

export function line(companyId: string, sreId: string, id: string, fields: Row): Row {
  return {
    id,
    salary_run_employee_id: sreId,
    company_id: companyId,
    quantity: null,
    unit_price: null,
    is_taxable: true,
    is_avgift_basis: true,
    is_vacation_basis: true,
    is_gross_deduction: false,
    is_net_deduction: false,
    account_number: null,
    sort_order: 0,
    source_benefit_id: null,
    source_recurring_line_id: null,
    calculation_source: null,
    one_off_tax_percent: null,
    ...fields,
  }
}

export function draftRun(companyId: string, id: string, fields: Row): Row {
  return {
    id,
    company_id: companyId,
    status: 'draft',
    deviation_period_start: null,
    deviation_period_end: null,
    total_gross: 0,
    total_tax: 0,
    total_net: 0,
    total_avgifter: 0,
    total_vacation_accrual: 0,
    total_employer_cost: 0,
    calculation_params: null,
    ...fields,
  }
}

export function absence(companyId: string, employeeId: string, rows: Array<[string, string, number?]>): Row[] {
  return rows.map(([date, type, hours]) => ({
    id: `abs-${employeeId}-${date}-${type}`,
    company_id: companyId,
    employee_id: employeeId,
    absence_date: date,
    absence_type: type,
    hours: hours ?? 8,
  }))
}

export function worked(
  companyId: string,
  employeeId: string,
  rows: Array<[string, number, string | null, string | null]>,
): Row[] {
  return rows.map(([date, hours, start, end]) => ({
    id: `wd-${employeeId}-${date}`,
    company_id: companyId,
    employee_id: employeeId,
    work_date: date,
    hours,
    start_time: start,
    end_time: end,
  }))
}
