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
