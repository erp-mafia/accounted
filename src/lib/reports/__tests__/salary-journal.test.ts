import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { generateSalaryJournal, toSalaryJournalRow } from '../salary-journal'

const RUN = { period_year: 2026, period_month: 9, payment_date: '2026-09-25', status: 'booked' }

function sre(overrides: Record<string, unknown> = {}) {
  return {
    employee_id: 'emp-1',
    gross_salary: 30000,
    tax_withheld: 7000,
    tax_withheld_override: null,
    net_salary: 23000,
    avgifter_amount: 9426,
    avgifter_amount_override: null,
    avgifter_rate: 0.3142,
    vacation_accrual: 3600,
    vacation_accrual_avgifter: 1131.12,
    sick_days: 0,
    vab_days: 0,
    parental_days: 0,
    vacation_days_taken: 0,
    employee: {
      first_name: 'Test',
      last_name: 'Testsson',
      personnummer_last4: '0000',
      employment_type: 'employee',
      f_skatt_status: 'a_skatt',
    },
    salary_run: RUN,
    ...overrides,
  }
}

describe('toSalaryJournalRow', () => {
  it('carries the calculated figures when nothing is overridden', () => {
    const row = toSalaryJournalRow(sre(), RUN)
    expect(row.taxWithheld).toBe(7000)
    expect(row.netSalary).toBe(23000)
    expect(row.avgifterAmount).toBe(9426)
    expect(row.totalEmployerCost).toBe(44157.12)
  })

  it('carries the effective figures when review-step overrides are set (the booked values)', () => {
    const row = toSalaryJournalRow(
      sre({ tax_withheld_override: 9000, avgifter_amount_override: 8000 }),
      RUN,
    )
    expect(row.grossSalary).toBe(30000)
    expect(row.taxWithheld).toBe(9000)
    expect(row.netSalary).toBe(21000)
    expect(row.avgifterAmount).toBe(8000)
    expect(row.totalEmployerCost).toBe(42731.12)
  })

  it('ignores an avgifter override on an F-skatt row', () => {
    const row = toSalaryJournalRow(
      sre({
        tax_withheld: 0,
        net_salary: 30000,
        avgifter_amount: 0,
        avgifter_amount_override: 5000,
        vacation_accrual: 0,
        vacation_accrual_avgifter: 0,
        employee: {
          first_name: 'Test',
          last_name: 'Testsson',
          personnummer_last4: '0000',
          employment_type: 'employee',
          f_skatt_status: 'f_skatt',
        },
      }),
      RUN,
    )
    expect(row.avgifterAmount).toBe(0)
    expect(row.totalEmployerCost).toBe(30000)
  })
})

describe('generateSalaryJournal', () => {
  it('totals the effective figures', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: [
        sre({ tax_withheld_override: 9000 }),
        sre({ employee_id: 'emp-2' }),
      ],
    })

    const report = await generateSalaryJournal(supabase as never, 'company-1', 2026)

    expect(report.rows).toHaveLength(2)
    expect(report.totals.taxWithheld).toBe(16000)
    expect(report.totals.netSalary).toBe(44000)
    // The embed carries f_skatt_status so the F-skatt rule can apply.
    expect(String(findCall('salary_run_employees', 'select')?.[0])).toContain('f_skatt_status')
  })
})

// Plan 1: the lönejournal carries the personnel category (Fora reads the
// arbetare totals, Collectum the tjänstemän ones) and totals per group.
describe('personnel category in the lönejournal', () => {
  const employee = (employment_type: string, personnel_category: string) => ({
    first_name: 'Test',
    last_name: 'Testsson',
    personnummer_last4: '0000',
    employment_type,
    personnel_category,
    f_skatt_status: 'a_skatt',
  })

  it('reads the booking stamp on a booked run, not the employee category it has today', () => {
    const row = toSalaryJournalRow(
      sre({ personnel_category: 'tjansteman', employee: employee('employee', 'arbetare') }),
      RUN,
    )
    expect(row.personnelCategory).toBe('tjansteman')
  })

  it('reads the live employee category on an unbooked run, as its booking will', () => {
    const row = toSalaryJournalRow(
      sre({ personnel_category: 'tjansteman', employee: employee('employee', 'arbetare') }),
      { ...RUN, status: 'approved' },
    )
    expect(row.personnelCategory).toBe('arbetare')
  })

  it('leaves the category out for owners and board members', () => {
    expect(toSalaryJournalRow(sre({ personnel_category: 'arbetare', employee: employee('company_owner', 'arbetare') }), RUN).personnelCategory).toBeNull()
    expect(toSalaryJournalRow(sre({ personnel_category: 'tjansteman', employee: employee('board_member', 'tjansteman') }), RUN).personnelCategory).toBeNull()
  })

  it('totals per group: arbetare, tjänstemän, owners and board, only the groups with rows', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        sre({ employee_id: 'arb-1', personnel_category: 'arbetare', employee: employee('employee', 'arbetare') }),
        sre({ employee_id: 'arb-2', personnel_category: 'arbetare', gross_salary: 20000, employee: employee('employee', 'arbetare') }),
        sre({ employee_id: 'tj-1', personnel_category: 'tjansteman', employee: employee('employee', 'tjansteman') }),
        sre({ employee_id: 'own-1', personnel_category: 'arbetare', employee: employee('company_owner', 'arbetare') }),
      ],
    })

    const report = await generateSalaryJournal(supabase as never, 'company-1', 2026)

    expect(report.groupTotals.map((g) => [g.group, g.employeeCount, g.grossSalary])).toEqual([
      ['arbetare', 2, 50000],
      ['tjansteman', 1, 30000],
      ['company_owner', 1, 30000],
    ])
    const sum = report.groupTotals.reduce((s, g) => s + g.grossSalary, 0)
    expect(sum).toBe(report.totals.grossSalary)
  })
})
