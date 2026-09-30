import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/company/context', () => ({
  getCompanyDisplayName: vi.fn().mockResolvedValue('Testbolaget AB'),
}))

import { buildSalaryRunUnderlag, salaryRunUnderlagFileName } from '../run-underlag'
import type { SupabaseClient } from '@supabase/supabase-js'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const db = supabase as unknown as SupabaseClient

const BOOKED_RUN = {
  id: 'run-1',
  company_id: 'company-1',
  status: 'booked',
  period_year: 2026,
  period_month: 8,
  payment_date: '2026-08-25',
  is_correction: false,
  salary_entry_id: 'je-1',
  avgifter_entry_id: 'je-2',
  vacation_entry_id: null,
  pension_entry_id: null,
}

const SRE = (name: [string, string], gross: number, tax: number, avgifter: number, vacation: number) => ({
  employee_id: `emp-${name[0]}`,
  employee: { first_name: name[0], last_name: name[1], personnummer_last4: '1234', employment_type: 'employee' },
  gross_salary: gross,
  tax_withheld: tax,
  net_salary: gross - tax,
  avgifter_amount: avgifter,
  avgifter_rate: 0.3142,
  vacation_accrual: vacation,
  vacation_accrual_avgifter: 0,
  sick_days: 0,
  vab_days: 0,
  parental_days: 0,
  vacation_days_taken: 0,
})

const POSTED = [
  {
    id: 'je-1',
    description: 'Lön augusti 2026',
    voucher_series: 'L',
    voucher_number: 8,
    lines: [
      { account_number: '7210', line_description: 'Bruttolön', debit_amount: 70000, credit_amount: 0 },
      { account_number: '2710', line_description: 'Skatt', debit_amount: 0, credit_amount: 21000 },
      { account_number: '1930', line_description: 'Nettolön', debit_amount: 0, credit_amount: 49000 },
    ],
  },
  {
    id: 'je-2',
    description: 'Lön augusti 2026: Arbetsgivaravgifter',
    voucher_series: 'L',
    voucher_number: 9,
    lines: [
      { account_number: '7510', line_description: null, debit_amount: 21994, credit_amount: null },
      { account_number: '2731', line_description: null, debit_amount: null, credit_amount: 21994 },
    ],
  },
]

describe('buildSalaryRunUnderlag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('returns SALARY_RUN_NOT_FOUND for an unknown run', async () => {
    enqueue({ data: null }) // salary_runs
    const result = await buildSalaryRunUnderlag(db, 'company-1', 'run-x')
    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_NOT_FOUND' })
  })

  it.each(['draft', 'review', 'approved', 'paid'])('refuses a %s run: no verifikat to be underlag for', async (status) => {
    enqueue({ data: { ...BOOKED_RUN, status } })
    const result = await buildSalaryRunUnderlag(db, 'company-1', 'run-1')
    expect(result).toEqual({ ok: false, code: 'SALARY_RUN_UNDERLAG_NOT_BOOKED' })
  })

  it('carries the per-employee lönejournal figures, totals and the posted verifikat with account names', async () => {
    enqueue({ data: BOOKED_RUN }) // salary_runs
    enqueue({ data: { name: 'Gammalt Namn AB', org_number: '556677-8899' } }) // companies
    enqueue({
      data: [SRE(['Örjan', 'Berg'], 40000, 12000, 12568, 4800), SRE(['Anna', 'Ek'], 30000, 9000, 9426, 3600)],
    }) // salary_run_employees
    enqueue({ data: POSTED }) // journal_entries
    enqueue({
      data: [
        { account_number: '7210', account_name: 'Löner till tjänstemän' },
        { account_number: '2710', account_name: 'Personalskatt' },
      ],
    }) // chart_of_accounts

    const result = await buildSalaryRunUnderlag(db, 'company-1', 'run-1', new Date('2026-09-01T10:00:00Z'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const data = result.data

    // Current company name, as on the payslip; org number from companies.
    expect(data.companyName).toBe('Testbolaget AB')
    expect(data.companyOrgNumber).toBe('556677-8899')
    expect(data.generatedAt).toBe('2026-09-01T10:00:00.000Z')
    expect(data.isCorrection).toBe(false)
    expect(data.corrected).toBe(false)

    // Sorted by name, Swedish collation: Ö after A.
    expect(data.rows.map((r) => r.employeeName)).toEqual(['Anna Ek', 'Örjan Berg'])
    expect(data.totals.grossSalary).toBe(70000)
    expect(data.totals.taxWithheld).toBe(21000)
    expect(data.totals.netSalary).toBe(49000)
    expect(data.totals.avgifterAmount).toBe(21994)
    expect(data.totals.vacationAccrual).toBe(8400)

    expect(data.entries).toHaveLength(2)
    expect(data.entries[0].voucher).toBe('L-8')
    expect(data.entries[0].lines[0]).toEqual({
      account_number: '7210',
      account_name: 'Löner till tjänstemän',
      line_description: 'Bruttolön',
      debit_amount: 70000,
      credit_amount: 0,
    })
    expect(data.entries[0].totalDebit).toBe(70000)
    expect(data.entries[0].totalCredit).toBe(70000)
    // A null amount is a zero on the page; an unknown account has no name.
    expect(data.entries[1].lines[0].credit_amount).toBe(0)
    expect(data.entries[1].lines[0].account_name).toBeNull()

    // Scoped to the company and to this run.
    expect(findCall('salary_run_employees', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('chart_of_accounts', 'in')).toEqual(['account_number', ['7210', '2710', '1930', '7510', '2731']])
  })

  it('prints a corrected run with its original verifikat: the correction keeps the entry ids on the run', async () => {
    // lib/salary/correct-run.ts only flips status to 'corrected' and storno-
    // reverses the entries; the run's *_entry_id columns stay, so the
    // underlag still names the vouchers it was booked with.
    enqueue({ data: { ...BOOKED_RUN, status: 'corrected' } })
    enqueue({ data: { name: 'X AB', org_number: '556677-8899' } })
    enqueue({ data: [] })
    enqueue({ data: POSTED })
    enqueue({ data: [] })
    const corrected = await buildSalaryRunUnderlag(db, 'company-1', 'run-1')
    expect(corrected.ok && corrected.data.corrected).toBe(true)
    expect(corrected.ok && corrected.data.entries.map((e) => e.voucher)).toEqual(['L-8', 'L-9'])
  })

  it('marks a correction run, and skips the account-name lookup when nothing was posted', async () => {
    enqueue({ data: { ...BOOKED_RUN, is_correction: true, salary_entry_id: null, avgifter_entry_id: null } })
    enqueue({ data: { name: 'X AB', org_number: '556677-8899' } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    const correction = await buildSalaryRunUnderlag(db, 'company-1', 'run-1')
    expect(correction.ok && correction.data.isCorrection).toBe(true)
    expect(correction.ok && correction.data.entries).toEqual([])
    expect(findCall('chart_of_accounts', 'in')).toBeUndefined()
  })

  it('throws when the posted-voucher lookup fails, never prints an underlag without its verifikat', async () => {
    enqueue({ data: BOOKED_RUN })
    enqueue({ data: { name: 'X AB', org_number: '556677-8899' } })
    enqueue({ data: [] })
    enqueue({ data: null, error: { message: 'rls denied' } }) // journal_entries
    await expect(buildSalaryRunUnderlag(db, 'company-1', 'run-1')).rejects.toThrow(
      'Kunde inte läsa lönekörningens bokförda verifikat',
    )
  })
})

describe('salaryRunUnderlagFileName', () => {
  it('names the period and marks a correction run', () => {
    expect(salaryRunUnderlagFileName({ periodYear: 2026, periodMonth: 8, isCorrection: false })).toBe(
      'lonesammanstallning_2026-08.pdf',
    )
    expect(salaryRunUnderlagFileName({ periodYear: 2026, periodMonth: 11, isCorrection: true })).toBe(
      'lonesammanstallning_2026-11_rattelse.pdf',
    )
  })
})
