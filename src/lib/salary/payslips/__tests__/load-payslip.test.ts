/**
 * The one payslip render path (lib/salary/payslips/load-payslip.ts): the load
 * every payslip door shares, and the audience and issuing rules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/salary/payslips/section-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/payslips/section-snapshot')>()),
  issuePayslipSections: vi.fn(),
}))
vi.mock('@/lib/salary/personnummer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/salary/personnummer')>()),
  decryptPersonnummer: vi.fn((v: string) => v),
}))

import { loadPayslip, preparePayslip } from '../load-payslip'
import { issuePayslipSections } from '@/lib/salary/payslips/section-snapshot'

const ARGS = { companyId: 'company-1', salaryRunId: 'run-1', employeeId: 'emp-1' }
const RUN = { id: 'run-1', status: 'approved', period_year: 2026, period_month: 6, payment_date: '2026-06-25' }
const SRE = {
  gross_salary: 30000,
  tax_withheld: 7000,
  net_salary: 23000,
  avgifter_amount: 9426,
  vacation_accrual: 0,
  vacation_accrual_avgifter: 0,
  line_items: [],
  employee: {
    first_name: 'Anna',
    last_name: 'Svensson',
    personnummer: '199001019802',
    employment_type: 'employee',
    tax_table_number: 33,
    tax_column: 1,
    clearing_number: null,
    bank_account_number: null,
    f_skatt_status: 'a_skatt',
  },
}

function tables(overrides: Record<string, unknown> = {}) {
  return createTableMockSupabase({
    salary_runs: { data: RUN, error: null },
    salary_run_employees: { data: SRE, error: null },
    companies: { data: { name: 'Onboarding AB', org_number: '5560000000' }, error: null },
    company_settings: { data: { company_name: 'Nytt Namn AB', salary_payslip_show_employer_cost: false }, error: null },
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(issuePayslipSections).mockResolvedValue({
    ok: true,
    snapshot: { payslip_sections_issued_at: '2026-06-20T00:00:00Z', payslip_show_employer_cost: false, payslip_show_breakdown: true },
  } as never)
})

describe('loadPayslip', () => {
  it('prints the current company name, and scopes the roster row to the company', async () => {
    const mock = tables()
    const result = await loadPayslip(mock.supabase as never, ARGS)

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.payslip.company).toEqual({ name: 'Nytt Namn AB', org_number: '5560000000' })
    expect(mock.findCalls('salary_run_employees', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('falls back to the onboarding name when the settings name is empty', async () => {
    const result = await loadPayslip(tables({ company_settings: { data: { company_name: '' }, error: null } }).supabase as never, ARGS)
    if (result.ok) expect(result.payslip.company.name).toBe('Onboarding AB')
  })

  it('names what is missing', async () => {
    expect(await loadPayslip(tables({ salary_runs: { data: null, error: null } }).supabase as never, ARGS)).toEqual({
      ok: false,
      reason: 'run_not_found',
    })
    expect(
      await loadPayslip(tables({ salary_run_employees: { data: null, error: null } }).supabase as never, ARGS),
    ).toEqual({ ok: false, reason: 'employee_not_found' })
  })
})

describe('preparePayslip', () => {
  async function loaded(overrides: Record<string, unknown> = {}) {
    const result = await loadPayslip(tables(overrides).supabase as never, ARGS)
    if (!result.ok) throw new Error('fixture did not load')
    return result.payslip
  }

  it('prints every section for the employer and issues nothing', async () => {
    const result = await preparePayslip({} as never, await loaded(), { companyId: 'company-1', audience: 'employer', mayIssue: true })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.employerCost).not.toBeNull()
    expect(issuePayslipSections).not.toHaveBeenCalled()
  })

  it('follows the switches on the employee copy, issuing the run only when the reader may', async () => {
    const read = await preparePayslip({} as never, await loaded(), { companyId: 'company-1', audience: 'employee', mayIssue: false })
    expect(read.ok && read.data.employerCost).toBeNull()
    expect(issuePayslipSections).not.toHaveBeenCalled()

    await preparePayslip({} as never, await loaded(), { companyId: 'company-1', audience: 'employee', mayIssue: true })
    expect(issuePayslipSections).toHaveBeenCalledTimes(1)
  })

  it('refuses the employee copy when the switches could not be read, instead of printing the defaults', async () => {
    const payslip = await loaded({ company_settings: { data: null, error: { message: 'timeout' } } })
    const result = await preparePayslip({} as never, payslip, { companyId: 'company-1', audience: 'employee', mayIssue: true })

    expect(result).toMatchObject({ ok: false, reason: 'sections_unavailable' })
  })
})
