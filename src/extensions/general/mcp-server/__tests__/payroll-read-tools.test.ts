/**
 * Tests for the payroll MCP read tools (payroll gap-closure 1.6):
 * gnubok_get_employee, gnubok_get_payslip, gnubok_list_absence, plus the
 * personnummer contract on gnubok_list_employees and gnubok_get_salary_run.
 *
 * PII rule under test: personnummer is ALWAYS masked on the MCP surface
 * (LLM context is a leak surface); there is no full-value drill-in here,
 * unlike v1's GET /employees/{id}. The mask is YYYYMMDD-XXXX, so
 * personnummer_last4 must never ride along in the same payload: mask + last4
 * reconstructs the full personnummer by concatenation. Responses expose only
 * personnummer_masked (via maskEmployeeForResponse), never the ciphertext,
 * never last4, and never a mask under the writable `personnummer` key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

import { tools } from '../server'

const getEmployee = tools.find((t) => t.name === 'gnubok_get_employee')!
const getPayslip = tools.find((t) => t.name === 'gnubok_get_payslip')!
const listAbsence = tools.find((t) => t.name === 'gnubok_list_absence')!
const getVacationBalance = tools.find((t) => t.name === 'gnubok_get_vacation_balance')!
const listEmployees = tools.find((t) => t.name === 'gnubok_list_employees')!
const getSalaryRun = tools.find((t) => t.name === 'gnubok_get_salary_run')!

// Synthetic fixture personnummer (year 1900, zero suffix): must not look
// like production-format PII.
const SAMPLE_PERSONNUMMER = '190001010000'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tool registration', () => {
  it('all three read tools exist and are read-only', () => {
    for (const tool of [getEmployee, getPayslip, listAbsence]) {
      expect(tool).toBeDefined()
      expect(tool.annotations?.readOnlyHint).toBe(true)
    }
  })
})

describe('gnubok_get_employee', () => {
  const EMPLOYEE_ROW = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    first_name: 'Anna',
    last_name: 'Andersson',
    personnummer: SAMPLE_PERSONNUMMER,
    employment_type: 'employee',
    personnel_category: 'arbetare',
    employment_start: '2024-01-15',
    employment_end: null,
    employment_degree: 100,
    salary_type: 'monthly',
    monthly_salary: 35000,
    hourly_rate: null,
    tax_table_number: 33,
    tax_column: 1,
    tax_municipality: 'Stockholm',
    is_sidoinkomst: false,
    f_skatt_status: 'a_skatt',
    f_skatt_verified_at: null,
    jamkning_percentage: 15,
    jamkning_valid_from: '2026-01-01',
    jamkning_valid_to: null,
    clearing_number: '6000',
    bank_account_number: '12345678',
    vacation_rule: 'procentregeln',
    vacation_days_per_year: 25,
    vacation_days_saved: 3,
    semestertillagg_rate: 0.0043,
    vaxa_stod_eligible: false,
    vaxa_stod_start: null,
    vaxa_stod_end: null,
    default_dimensions: {},
    is_active: true,
  }

  it('returns the grouped config with masked personnummer and qualified id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: EMPLOYEE_ROW })

    const result = (await getEmployee.execute(
      { employee_id: EMPLOYEE_ROW.id }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as Record<string, unknown>

    expect(result.employee_id).toBe(EMPLOYEE_ROW.id)
    expect(result.personnummer_masked).toBe('19000101-XXXX')
    expect((result.tax as Record<string, unknown>).jamkning_percentage).toBe(15)
    expect((result.vacation as Record<string, unknown>).vacation_days_saved).toBe(3)
    expect((result.employment as Record<string, unknown>).personnel_category).toBe('arbetare')
    // Raw personnummer never leaks anywhere in the payload, and there is no
    // bare `id` key (qualified ids only).
    expect(JSON.stringify(result)).not.toContain(SAMPLE_PERSONNUMMER)
    expect(result.id).toBeUndefined()
  })

  it('returns the requested extra tax in the tax group', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...EMPLOYEE_ROW, extra_tax_amount: null, extra_tax_percentage: 45 } })

    const result = (await getEmployee.execute(
      { employee_id: EMPLOYEE_ROW.id }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { tax: Record<string, unknown> }

    expect(result.tax).toMatchObject({ extra_tax_amount: null, extra_tax_percentage: 45 })
  })

  it('throws for an unknown employee', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      getEmployee.execute({ employee_id: 'nope' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/not found/i)
  })
})

describe('gnubok_list_employees: personnummer contract', () => {
  it('strips personnummer + personnummer_last4 and exposes only personnummer_masked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // The fixture deliberately carries personnummer_last4 even though the
    // select no longer requests it: the helper must strip it regardless, so
    // a projection regression can never leak it again.
    enqueue({
      data: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          first_name: 'Anna',
          last_name: 'Andersson',
          personnummer: SAMPLE_PERSONNUMMER,
          personnummer_last4: '0000',
          employment_type: 'employee',
          monthly_salary: 35000,
          hourly_rate: null,
          employment_degree: 100,
          tax_table_number: 33,
          tax_column: 1,
          salary_type: 'monthly',
          default_dimensions: {},
          is_active: true,
        },
      ],
    })

    const result = (await listEmployees.execute(
      {}, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { employees: Array<Record<string, unknown>>; count: number }

    expect(result.count).toBe(1)
    const emp = result.employees[0]
    expect(emp.personnummer_masked).toBe('19000101-XXXX')
    expect(emp.first_name).toBe('Anna')
    expect(emp.monthly_salary).toBe(35000)
    // Neither the ciphertext key nor last4 survives, and the mask never goes
    // out under the writable `personnummer` key.
    expect(emp).not.toHaveProperty('personnummer')
    expect(emp).not.toHaveProperty('personnummer_last4')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SAMPLE_PERSONNUMMER)
    expect(serialized).not.toContain('personnummer_last4')
  })
})

describe('gnubok_get_salary_run: personnummer contract', () => {
  it('masks the embedded employee and never returns last4 or ciphertext', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'run-1',
        status: 'draft',
        period_year: 2026,
        period_month: 6,
        total_gross: 35000,
        total_net: 26800,
      },
    })
    enqueue({
      data: [
        {
          id: 'sre-1',
          salary_run_id: 'run-1',
          employee_id: 'emp-1',
          gross_salary: 35000,
          net_salary: 26800,
          // Fixture carries last4 on purpose: the helper must strip it even
          // if the embed projection ever regresses to include it.
          employee: {
            first_name: 'Anna',
            last_name: 'Andersson',
            personnummer: SAMPLE_PERSONNUMMER,
            personnummer_last4: '0000',
          },
        },
      ],
    })

    const result = (await getSalaryRun.execute(
      { salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { employees: Array<{ employee: Record<string, unknown> | null }> }

    const emp = result.employees[0].employee!
    expect(emp.personnummer_masked).toBe('19000101-XXXX')
    expect(emp.first_name).toBe('Anna')
    expect(emp).not.toHaveProperty('personnummer')
    expect(emp).not.toHaveProperty('personnummer_last4')
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SAMPLE_PERSONNUMMER)
    expect(serialized).not.toContain('personnummer_last4')
  })

  it('keeps a null employee embed as null', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-1', status: 'draft' } })
    enqueue({ data: [{ id: 'sre-1', salary_run_id: 'run-1', employee_id: 'emp-1', employee: null }] })

    const result = (await getSalaryRun.execute(
      { salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { employees: Array<{ employee: unknown }> }

    expect(result.employees[0].employee).toBeNull()
  })
})

describe('gnubok_get_salary_run: effective figures', () => {
  it('adds per-employee `effective` and run `effective_totals` with the overrides applied', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Stored totals predate the override.
    enqueue({ data: { id: 'run-1', status: 'review', total_tax: 7000, total_net: 23000, total_avgifter: 9426 } })
    enqueue({
      data: [
        {
          id: 'sre-1',
          salary_run_id: 'run-1',
          employee_id: 'emp-1',
          gross_salary: 30000,
          tax_withheld: 7000,
          tax_withheld_override: 0,
          net_salary: 23000,
          avgifter_amount: 9426,
          avgifter_amount_override: 0,
          vacation_accrual: 0,
          vacation_accrual_avgifter: 0,
          employee: { first_name: 'Anna', last_name: 'Andersson', personnummer: SAMPLE_PERSONNUMMER, f_skatt_status: 'a_skatt' },
        },
      ],
    })

    const result = (await getSalaryRun.execute(
      { salary_run_id: 'run-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as {
      total_tax: number
      effective_totals: Record<string, number>
      employees: Array<{ tax_withheld: number; effective: Record<string, number> }>
    }

    expect(result.total_tax).toBe(7000) // stored column untouched
    expect(result.employees[0].tax_withheld).toBe(7000) // raw column untouched
    expect(result.employees[0].effective.tax_withheld).toBe(0)
    expect(result.employees[0].effective.net_salary).toBe(30000)
    expect(result.effective_totals.total_tax).toBe(0)
    expect(result.effective_totals.total_net).toBe(30000)
    expect(result.effective_totals.total_avgifter).toBe(0)
  })
})

describe('gnubok_get_payslip', () => {
  const SRE_ROW = {
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    gross_salary: 35000,
    gross_deductions: 0,
    benefit_values: 0,
    taxable_income: 35000,
    tax_withheld: 8200,
    tax_withheld_override: null,
    net_deductions: 0,
    net_salary: 26800,
    avgifter_rate: 0.3142,
    avgifter_basis: 35000,
    avgifter_amount: 10997,
    avgifter_basis_override: null,
    avgifter_amount_override: null,
    avgifter_category: 'standard',
    override_reason: null,
    vacation_accrual: 4200,
    vacation_accrual_avgifter: 1319.64,
    ytd_gross: 70000,
    ytd_tax: 16400,
    ytd_net: 53600,
    sick_days: 0,
    vab_days: 0,
    parental_days: 0,
    vacation_days_taken: 0,
    calculation_breakdown: { steps: [] },
    employee: { first_name: 'Anna', last_name: 'Andersson', personnummer: SAMPLE_PERSONNUMMER },
    line_items: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        item_type: 'monthly_salary',
        description: 'Grundlön',
        quantity: null,
        unit_price: null,
        amount: 35000,
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
        is_gross_deduction: false,
        is_net_deduction: false,
        account_number: '7210',
        sort_order: 0,
      },
    ],
  }

  it('returns the payslip with qualified line ids and masked personnummer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: SRE_ROW })

    const result = (await getPayslip.execute(
      { salary_run_id: 'run-1', employee_id: 'emp-1' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as {
      salary_run_employee_id: string
      employee_name: string
      personnummer_masked: string
      amounts: Record<string, number>
      line_items: Array<Record<string, unknown>>
    }

    expect(result.salary_run_employee_id).toBe(SRE_ROW.id)
    expect(result.employee_name).toBe('Anna Andersson')
    expect(result.personnummer_masked).toBe('19000101-XXXX')
    expect(result.amounts.gross_salary).toBe(35000)
    expect(result.line_items).toHaveLength(1)
    expect(result.line_items[0].salary_line_item_id).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
    expect(result.line_items[0].id).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain(SAMPLE_PERSONNUMMER)
  })

  it('reports the requested extra tax in amounts and effective, and drops it from effective under an override', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...SRE_ROW, tax_withheld: 11200, extra_tax_withheld: 3000, net_salary: 23800 } })
    const result = (await getPayslip.execute(
      { salary_run_id: 'run-1', employee_id: 'emp-1' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { amounts: Record<string, number>; effective: Record<string, number> }
    expect(result.amounts).toMatchObject({ tax_withheld: 11200, extra_tax_withheld: 3000 })
    expect(result.effective).toMatchObject({ tax_withheld: 11200, extra_tax_withheld: 3000 })

    const overridden = createQueuedMockSupabase()
    overridden.enqueue({
      data: { ...SRE_ROW, tax_withheld: 11200, extra_tax_withheld: 3000, net_salary: 23800, tax_withheld_override: 9000 },
    })
    const withOverride = (await getPayslip.execute(
      { salary_run_id: 'run-1', employee_id: 'emp-1' },
      'company-1', 'user-1', overridden.supabase as never, { type: 'api_key' },
    )) as { amounts: Record<string, number>; effective: Record<string, number> }
    expect(withOverride.amounts.extra_tax_withheld).toBe(3000)
    expect(withOverride.effective).toMatchObject({ tax_withheld: 9000, extra_tax_withheld: 0 })
  })

  it('reads a payslip calculated before the column existed as no extra', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: SRE_ROW })
    const result = (await getPayslip.execute(
      { salary_run_id: 'run-1', employee_id: 'emp-1' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { amounts: Record<string, number> }
    expect(result.amounts.extra_tax_withheld).toBe(0)
  })

  it('reports the effective tax and net when a tax override is set (agent feedback seq 911374)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        ...SRE_ROW,
        tax_withheld_override: 12000,
        avgifter_amount_override: 0,
        override_reason: 'Frivilligt extra skatteavdrag',
        employee: { ...SRE_ROW.employee, f_skatt_status: 'a_skatt' },
      },
    })

    const result = (await getPayslip.execute(
      { salary_run_id: 'run-1', employee_id: 'emp-1' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as {
      amounts: Record<string, number>
      effective: Record<string, number | boolean>
    }

    // Raw calculated values stay under `amounts` for compatibility.
    expect(result.amounts.tax_withheld).toBe(8200)
    expect(result.amounts.net_salary).toBe(26800)
    // `effective` is what the booking, AGI and bank file use.
    expect(result.effective.tax_withheld).toBe(12000)
    expect(result.effective.net_salary).toBe(23000)
    expect(result.effective.avgifter_amount).toBe(0)
    expect(result.effective.employer_cost).toBe(40519.64)
    expect(result.effective.tax_overridden).toBe(true)
  })

  it('throws when the employee is not in the run', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      getPayslip.execute(
        { salary_run_id: 'run-1', employee_id: 'emp-x' },
        'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toThrow(/not found/i)
  })
})

describe('gnubok_get_vacation_balance', () => {
  const BALANCE_ROW = {
    id: 'vb-1',
    employee_id: 'emp-1',
    vacation_year_start: '2026-01-01',
    entitled_days: 25,
    accrued_days: 0,
    taken_days: 10,
    saved_days: { '2025': 5 },
    forced_payout_days: 0,
  }
  // Procentregeln, 25 days, 35 000 kr/month: day value = 35000*12*0.12/25 = 2016.
  const EMPLOYEE_ROW = {
    vacation_rule: 'procentregeln',
    vacation_days_per_year: 25,
    salary_type: 'monthly',
    monthly_salary: 35000,
    hourly_rate: null,
    hours_per_week: null,
    workdays_per_week: null,
  }

  it('returns the open balance with qualified id, remaining days and the SEK estimate', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: EMPLOYEE_ROW })
    enqueue({ data: BALANCE_ROW })

    const result = (await getVacationBalance.execute(
      { employee_id: 'emp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as Record<string, unknown>

    expect(result.employee_vacation_balance_id).toBe('vb-1')
    expect(result.remaining_days).toBe(15)
    expect(result.saved_days).toEqual({ '2025': 5 })
    expect(result.id).toBeUndefined()
    // (15 remaining + 5 saved) * 2016 kr: the same valuation the v1 route and
    // the year-close use, so the description's promise is a real field.
    expect(result.estimated_liability_sek).toBe(40320)
    expect(getVacationBalance.outputSchema?.properties).toHaveProperty('estimated_liability_sek')
    expect(result.remaining_days_off).toBe(15)
  })

  it('shows the days still to take off on a four-day week (Semesterlagen 12 a §)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...EMPLOYEE_ROW, workdays_per_week: 4 } })
    enqueue({ data: BALANCE_ROW })

    const result = (await getVacationBalance.execute(
      { employee_id: 'emp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as Record<string, unknown>

    // 15 paid days left are 12 days off at 1.25 paid days per day off; a
    // missing schedule (the other cases) takes them one for one.
    expect(result.remaining_days).toBe(15)
    expect(result.remaining_days_off).toBe(12)
  })

  it('floors the SEK estimate at zero when the balance is overdrawn', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: EMPLOYEE_ROW })
    enqueue({ data: { ...BALANCE_ROW, entitled_days: 5, taken_days: 12, saved_days: {} } })

    const result = (await getVacationBalance.execute(
      { employee_id: 'emp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as Record<string, unknown>

    expect(result.remaining_days).toBe(-7)
    expect(result.estimated_liability_sek).toBe(0)
  })

  it('throws EMPLOYEE_NOT_FOUND before reading the ledger when the employee is not the company\'s', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      getVacationBalance.execute(
        { employee_id: 'emp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toMatchObject({ code: 'EMPLOYEE_NOT_FOUND', message: expect.stringMatching(/emp-1/) })
    expect(findCalls('employee_vacation_balances', 'select')).toHaveLength(0)
  })

  it('throws VACATION_BALANCE_NOT_FOUND before the ledger has seeded', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: EMPLOYEE_ROW })
    enqueue({ data: null })
    await expect(
      getVacationBalance.execute(
        { employee_id: 'emp-x' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toMatchObject({ code: 'VACATION_BALANCE_NOT_FOUND', message: expect.stringMatching(/No vacation balance/) })
  })
})

describe('gnubok_list_absence', () => {
  it('lists absence days with qualified ids', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // Service: employees existence check, then the range query.
    enqueue({ data: { id: 'emp-1' } })
    enqueue({
      data: [
        {
          id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
          absence_date: '2026-03-03',
          absence_type: 'sick',
          hours: 8,
          notes: null,
          salary_run_employee_id: null,
          created_at: '2026-03-03T08:00:00Z',
          updated_at: '2026-03-03T08:00:00Z',
        },
      ],
    })

    const result = (await listAbsence.execute(
      { employee_id: 'emp-1', from: '2026-03-01', to: '2026-03-31' },
      'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { absence_days: Array<Record<string, unknown>>; count: number }

    expect(result.count).toBe(1)
    expect(result.absence_days[0].salary_absence_day_id).toBe('ffffffff-ffff-4fff-8fff-ffffffffffff')
    expect(result.absence_days[0].absence_type).toBe('sick')
    expect(result.absence_days[0].id).toBeUndefined()
  })

  it('throws for an unknown employee', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      listAbsence.execute(
        { employee_id: 'emp-x', from: '2026-03-01', to: '2026-03-31' },
        'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toThrow(/not found/i)
  })
})

describe('gnubok_get_salary_run: period selector', () => {
  it('resolves the live run for period_year + period_month', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'run-6', status: 'review', period_year: 2026, period_month: 6 } })
    enqueue({ data: [] })

    const result = (await getSalaryRun.execute(
      { period_year: 2026, period_month: 6 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as { id: string; employees: unknown[] }

    expect(result.id).toBe('run-6')
    expect(result.employees).toEqual([])
    // A corrected original coexists with its correction in the same period:
    // the lookup must exclude it or maybeSingle() would see two rows.
    expect(findCalls('salary_runs', 'neq')).toEqual([['status', 'corrected']])
    expect(findCalls('salary_runs', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['period_year', 2026],
      ['period_month', 6],
    ])
  })

  it('names the period when no run exists for it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      getSalaryRun.execute({ period_year: 2026, period_month: 2 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow('No salary run for 2026-02')
  })

  it('requires exactly one selector', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      getSalaryRun.execute({}, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/either salary_run_id or period_year/)
    await expect(
      getSalaryRun.execute(
        { salary_run_id: 'run-1', period_year: 2026, period_month: 6 },
        'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toThrow(/either salary_run_id or period_year/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects a month outside 1-12 and a half-given period', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      getSalaryRun.execute({ period_year: 2026, period_month: 13 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/period_month: must be an integer month 1-12/)
    await expect(
      getSalaryRun.execute({ period_year: 2026 }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/period_month: must be an integer month 1-12/)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
