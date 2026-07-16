/**
 * Tests for the payroll MCP read tools (payroll gap-closure 1.6):
 * gnubok_get_employee, gnubok_get_payslip, gnubok_list_absence.
 *
 * PII rule under test: personnummer is ALWAYS masked on the MCP surface
 * (LLM context is a leak surface); there is no full-value drill-in here,
 * unlike v1's GET /employees/{id}.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

import { tools } from '../server'

const getEmployee = tools.find((t) => t.name === 'gnubok_get_employee')!
const getPayslip = tools.find((t) => t.name === 'gnubok_get_payslip')!
const listAbsence = tools.find((t) => t.name === 'gnubok_list_absence')!
const getVacationBalance = tools.find((t) => t.name === 'gnubok_get_vacation_balance')!

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
    // Raw personnummer never leaks anywhere in the payload, and there is no
    // bare `id` key (qualified ids only).
    expect(JSON.stringify(result)).not.toContain(SAMPLE_PERSONNUMMER)
    expect(result.id).toBeUndefined()
  })

  it('throws for an unknown employee', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      getEmployee.execute({ employee_id: 'nope' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow(/not found/i)
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
  it('returns the open balance with qualified id and remaining days', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: {
        id: 'vb-1',
        employee_id: 'emp-1',
        vacation_year_start: '2026-01-01',
        entitled_days: 25,
        accrued_days: 0,
        taken_days: 10,
        saved_days: { '2025': 5 },
        forced_payout_days: 0,
      },
    })

    const result = (await getVacationBalance.execute(
      { employee_id: 'emp-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
    )) as Record<string, unknown>

    expect(result.employee_vacation_balance_id).toBe('vb-1')
    expect(result.remaining_days).toBe(15)
    expect(result.saved_days).toEqual({ '2025': 5 })
    expect(result.id).toBeUndefined()
  })

  it('throws before the ledger has seeded', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      getVacationBalance.execute(
        { employee_id: 'emp-x' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' },
      ),
    ).rejects.toThrow(/No vacation balance/)
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
