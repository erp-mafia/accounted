/**
 * Fora's monthly report from the books (lib/salary/fora/monthly-report.ts):
 * which runs count for the payment month, the pay per worker over them, and
 * the warnings. The database is a per-table mock; personnummer decryption is
 * the identity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/salary/personnummer', () => ({
  decryptPersonnummer: (value: string) => value,
}))

import { generateForaMonthlyReport } from '../monthly-report'

const { supabase, setTable, reset, findCalls } = createTableMockSupabase()

function employee(overrides: Record<string, unknown> = {}) {
  return {
    id: 'emp-1',
    first_name: 'Kalle',
    last_name: 'Hall',
    personnummer: '195408012230',
    employment_type: 'employee',
    personnel_category: 'arbetare',
    employment_start: '2020-03-01',
    employment_end: null,
    address_line1: null,
    postal_code: null,
    city: null,
    fora_fok_id: 'FOK306834',
    fora_fok_start_date: '2024-01-01',
    is_active: true,
    ...overrides,
  }
}

function line(item_type: string, amount: number) {
  return { item_type, amount, is_taxable: true, is_gross_deduction: false, is_net_deduction: false }
}

type ChainCall = { method: string; args: unknown[] }

/** The coded roster for the `.not('fora_fok_id', ...)` read, `paid` for the `.in('id', ...)` read. */
function employeesTable(coded: unknown[], paid: unknown[] = []) {
  return (calls: ChainCall[]) => ({ data: calls.some((c) => c.method === 'not') ? coded : paid })
}

const generate = () => generateForaMonthlyReport(supabase as never, { companyId: 'company-1', year: 2026, month: 10 })

beforeEach(() => {
  reset()
  setTable('companies', { data: { org_number: '556560-1712' } })
  setTable('company_settings', { data: { org_number: null } })
})

describe('generateForaMonthlyReport', () => {
  it('reads the payment month and sums every counted run in it, less what Fora leaves out', async () => {
    setTable('salary_runs', {
      data: [
        { id: 'run-sep', status: 'booked', period_year: 2026, period_month: 9, payment_date: '2026-10-05' },
        { id: 'run-oct', status: 'approved', period_year: 2026, period_month: 10, payment_date: '2026-10-25' },
        { id: 'run-old', status: 'corrected', period_year: 2026, period_month: 10, payment_date: '2026-10-25' },
      ],
    })
    setTable('salary_run_employees', {
      data: [
        { id: 'sre-1', salary_run_id: 'run-sep', employee_id: 'emp-1', gross_salary: 4800, line_items: [line('hourly_salary', 4800)] },
        {
          id: 'sre-2',
          salary_run_id: 'run-oct',
          employee_id: 'emp-1',
          gross_salary: 31730.4,
          line_items: [line('monthly_salary', 31250), line('traktamente_taxable', 480.4)],
        },
      ],
    })
    setTable('employees', employeesTable([employee()]))

    const result = await generate()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(findCalls('salary_runs', 'gte')).toEqual([['payment_date', '2026-10-01']])
    expect(findCalls('salary_runs', 'lte')).toEqual([['payment_date', '2026-10-31']])
    // The corrected run is replaced by its correction, so it is not read.
    expect(findCalls('salary_run_employees', 'in')).toEqual([['salary_run_id', ['run-sep', 'run-oct']]])
    expect(result.data.salary_run_ids).toEqual(['run-sep', 'run-oct'])
    expect(result.data.filename).toBe('Fora_5565601712_202610.json')
    expect(result.data.file.reports[0].payrolls).toEqual([
      { employeeId: '195408012230', firstName: 'Kalle', lastName: 'Hall', payMonth: '202610', payAmount: 36050 },
    ])
    expect(result.data.payrolls).toEqual([
      {
        employee_id: 'emp-1',
        employee_name: 'Kalle Hall',
        personnummer_masked: expect.stringMatching(/^19540801-/),
        fok_id: 'FOK306834',
        pay_amount: 36050,
        employment_end: null,
      },
    ])
    expect(result.data.payrolls[0].personnummer_masked).not.toContain('2230')
    expect(result.data.total_pay_amount).toBe(36050)
    expect(result.data.warnings).toEqual([])
  })

  it('leaves out a run that is not approved yet, and warns', async () => {
    setTable('salary_runs', {
      data: [{ id: 'run-draft', status: 'review', period_year: 2026, period_month: 10, payment_date: '2026-10-25' }],
    })
    setTable('employees', employeesTable([employee()]))

    const result = await generate()

    if (!result.ok) throw new Error('expected a report')
    expect(findCalls('salary_run_employees', 'in')).toEqual([])
    // Still employed: reported with 0, Fora wants every coded worker every month.
    expect(result.data.payrolls[0].pay_amount).toBe(0)
    expect(result.data.warnings).toEqual([
      expect.objectContaining({ code: 'FORA_RUN_NOT_APPROVED', salary_run_id: 'run-draft', run_period: '2026-10', payment_date: '2026-10-25' }),
    ])
  })

  it('names a paid arbetare without a code, and not a paid tjänsteman', async () => {
    setTable('salary_runs', { data: [{ id: 'run-oct', status: 'booked', period_year: 2026, period_month: 10, payment_date: '2026-10-25' }] })
    setTable('salary_run_employees', {
      data: [
        { id: 'sre-1', salary_run_id: 'run-oct', employee_id: 'emp-1', gross_salary: 30000, line_items: [] },
        { id: 'sre-2', salary_run_id: 'run-oct', employee_id: 'emp-2', gross_salary: 28000, line_items: [] },
        { id: 'sre-3', salary_run_id: 'run-oct', employee_id: 'emp-3', gross_salary: 45000, line_items: [] },
      ],
    })
    setTable(
      'employees',
      employeesTable(
        [employee()],
        [
          employee({ id: 'emp-2', first_name: 'Bo', fora_fok_id: null, fora_fok_start_date: null }),
          employee({ id: 'emp-3', first_name: 'Cia', personnel_category: 'tjansteman', fora_fok_id: null, fora_fok_start_date: null }),
        ],
      ),
    )

    const result = await generate()

    if (!result.ok) throw new Error('expected a report')
    expect(result.data.payrolls.map((p) => p.employee_id)).toEqual(['emp-1'])
    expect(result.data.warnings).toEqual([
      expect.objectContaining({ code: 'FORA_ARBETARE_WITHOUT_CODE', employee_id: 'emp-2', employee_name: 'Bo Hall' }),
    ])
  })

  it('does not report a deactivated worker again once nothing is paid', async () => {
    setTable('salary_runs', { data: [] })
    setTable('employees', employeesTable([employee(), employee({ id: 'emp-2', personnummer: '199812172386', is_active: false })]))

    const result = await generate()

    if (!result.ok) throw new Error('expected a report')
    expect(result.data.payrolls.map((p) => p.employee_id)).toEqual(['emp-1'])
  })

  it('prefers the current organisation number from company settings', async () => {
    setTable('company_settings', { data: { org_number: '559000-0001' } })
    setTable('salary_runs', { data: [] })
    setTable('employees', employeesTable([employee()]))

    const result = await generate()

    if (!result.ok) throw new Error('expected a report')
    expect(result.data.file.reports[0].organizationNumber).toBe('5590000001')
  })

  it('answers FORA_REPORT_INCOMPLETE with the issues when nobody has a code', async () => {
    setTable('salary_runs', { data: [] })
    setTable('employees', employeesTable([]))

    const result = await generate()

    expect(result).toEqual({
      ok: false,
      code: 'FORA_REPORT_INCOMPLETE',
      issues: [expect.objectContaining({ code: 'FORA_NO_CODED_EMPLOYEES' })],
    })
  })

  it('answers COMPANY_NOT_FOUND and DB_ERROR', async () => {
    setTable('companies', { data: null })
    expect(await generate()).toEqual({ ok: false, code: 'COMPANY_NOT_FOUND' })

    setTable('companies', { data: { org_number: '5565601712' } })
    setTable('salary_runs', { error: { message: 'boom' } })
    expect(await generate()).toMatchObject({ ok: false, code: 'DB_ERROR' })
  })
})
