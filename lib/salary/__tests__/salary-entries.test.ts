import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput } from '@/types'

// Capture pattern: mock the engine and assert on the CreateJournalEntryInput
// each salary sub-entry builder produces (same approach as
// lib/bookkeeping/__tests__/invoice-entries.test.ts).
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async (_s: unknown, _c: string, _u: string, input: CreateJournalEntryInput) => ({
    id: `je-${input.description}`,
    ...input,
  })),
  findFiscalPeriod: vi.fn(async () => 'fp-1'),
}))

import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { createSalaryRunEntries } from '../salary-entries'

const mockedCreateEntry = vi.mocked(createJournalEntry)

// Supabase mock only needs the chart_of_accounts existence check in
// ensureSalaryAccountsExist: pretend every account already exists.
function makeSupabase() {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          in: vi.fn(async (_col: string, accounts: string[]) => ({
            data: accounts.map((account_number) => ({ account_number })),
            error: null,
          })),
        })),
      })),
    })),
  } as never
}

interface EmployeeOverrides {
  employee_id?: string
  employment_type?: string
  gross_salary?: number
  tax_withheld?: number
  net_salary?: number
  avgifter_amount?: number
  vacation_accrual?: number
  vacation_accrual_avgifter?: number
  default_dimensions?: Record<string, string>
  pension_contribution?: number
  pension_slp?: number
  line_items?: Array<{
    item_type: string
    amount: number
    account_number: string | null
    is_net_deduction: boolean
    is_gross_deduction: boolean
  }>
}

function makeEmployee(overrides: EmployeeOverrides = {}) {
  return {
    employee_id: 'emp-1',
    employment_type: 'employee',
    gross_salary: 30000,
    tax_withheld: 7000,
    net_salary: 23000,
    avgifter_amount: 9426,
    avgifter_rate: 0.3142,
    vacation_accrual: 0,
    vacation_accrual_avgifter: 0,
    line_items: [],
    ...overrides,
  }
}

function makeRun(employees: ReturnType<typeof makeEmployee>[]) {
  return {
    id: 'run-1',
    period_year: 2026,
    period_month: 6,
    payment_date: '2026-06-25',
    voucher_series: 'L',
    total_gross: employees.reduce((s, e) => s + e.gross_salary, 0),
    total_tax: employees.reduce((s, e) => s + e.tax_withheld, 0),
    total_net: employees.reduce((s, e) => s + e.net_salary, 0),
    total_avgifter: employees.reduce((s, e) => s + e.avgifter_amount, 0),
    total_vacation_accrual: employees.reduce((s, e) => s + e.vacation_accrual, 0),
    employees,
  }
}

function entryByDescription(pattern: string): CreateJournalEntryInput {
  const call = mockedCreateEntry.mock.calls.find((c) => c[3].description.includes(pattern))
  if (!call) throw new Error(`no entry matching "${pattern}"`)
  return call[3]
}

function assertBalanced(input: CreateJournalEntryInput) {
  const debit = input.lines.reduce((s, l) => s + l.debit_amount, 0)
  const credit = input.lines.reduce((s, l) => s + l.credit_amount, 0)
  expect(Math.abs(debit - credit)).toBeLessThan(0.005)
}

function linesOn(input: CreateJournalEntryInput, account: string): CreateJournalEntryLineInput[] {
  return input.lines.filter((l) => l.account_number === account)
}

beforeEach(() => {
  mockedCreateEntry.mockClear()
})

describe('salary entries: dimensions propagation (PR8)', () => {
  it('splits the salary expense per employee bag; tax and bank legs stay untagged', async () => {
    const run = makeRun([
      makeEmployee({ employee_id: 'a', default_dimensions: { '1': 'KS01' } }),
      makeEmployee({ employee_id: 'b', default_dimensions: { '1': 'KS02', '6': 'P001' } }),
      makeEmployee({ employee_id: 'c' }), // untagged
    ])

    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')

    const salaryLines = linesOn(salary, '7210')
    expect(salaryLines).toHaveLength(3)
    expect(salaryLines.map((l) => l.dimensions)).toEqual([
      { '1': 'KS01' },
      { '1': 'KS02', '6': 'P001' },
      undefined,
    ])
    for (const line of salaryLines) expect(line.debit_amount).toBe(30000)

    const taxLine = linesOn(salary, '2710')[0]
    expect(taxLine.credit_amount).toBe(21000)
    expect(taxLine.dimensions).toBeUndefined()
    const bankLine = linesOn(salary, '1930')[0]
    expect(bankLine.credit_amount).toBe(69000)
    expect(bankLine.dimensions).toBeUndefined()

    assertBalanced(salary)
  })

  it('employees sharing a bag aggregate onto one line (and a dimension-less run books like before)', async () => {
    const run = makeRun([
      makeEmployee({ employee_id: 'a', default_dimensions: { '1': 'KS01' } }),
      makeEmployee({ employee_id: 'b', default_dimensions: { '1': 'KS01' } }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')
    const salaryLines = linesOn(salary, '7210')
    expect(salaryLines).toHaveLength(1)
    expect(salaryLines[0].debit_amount).toBe(60000)
    expect(salaryLines[0].dimensions).toEqual({ '1': 'KS01' })

    mockedCreateEntry.mockClear()
    const bagless = makeRun([makeEmployee({ employee_id: 'a' }), makeEmployee({ employee_id: 'b' })])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', bagless)
    const legacy = entryByDescription('Lön 2026-06')
    const legacyLines = linesOn(legacy, '7210')
    expect(legacyLines).toHaveLength(1)
    expect(legacyLines[0].debit_amount).toBe(60000)
    expect(legacyLines[0].dimensions).toBeUndefined()
  })

  it('line items and the base remainder follow the employee bag', async () => {
    const run = makeRun([
      makeEmployee({
        employee_id: 'a',
        gross_salary: 32000,
        default_dimensions: { '6': 'P001' },
        line_items: [
          { item_type: 'overtime', amount: 2000, account_number: '7281', is_net_deduction: false, is_gross_deduction: false },
        ],
      }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')

    const overtime = linesOn(salary, '7281')[0]
    expect(overtime.debit_amount).toBe(2000)
    expect(overtime.dimensions).toEqual({ '6': 'P001' })
    // Remainder (32000 - 2000) books to 7210 in the same bag.
    const base = linesOn(salary, '7210')[0]
    expect(base.debit_amount).toBe(30000)
    expect(base.dimensions).toEqual({ '6': 'P001' })
  })

  it('splits avgifter per bag with a single aggregated 2731 liability', async () => {
    const run = makeRun([
      makeEmployee({ employee_id: 'a', avgifter_amount: 9426.505, default_dimensions: { '1': 'KS01' } }),
      makeEmployee({ employee_id: 'b', avgifter_amount: 9426.505, default_dimensions: { '1': 'KS02' } }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')

    const expense = linesOn(avgifter, '7510')
    expect(expense).toHaveLength(2)
    expect(expense.map((l) => l.dimensions)).toEqual([{ '1': 'KS01' }, { '1': 'KS02' }])

    const liability = linesOn(avgifter, '2731')
    expect(liability).toHaveLength(1)
    expect(liability[0].dimensions).toBeUndefined()
    // Balance by construction: credit equals the sum of the ROUNDED debits,
    // even when the partition rounds differently from the raw total.
    expect(liability[0].credit_amount).toBe(
      Math.round(expense.reduce((s, l) => s + l.debit_amount, 0) * 100) / 100,
    )
    assertBalanced(avgifter)
  })

  it('keeps the legacy zero-avgifter shape (single untagged debit)', async () => {
    const run = makeRun([
      makeEmployee({ employee_id: 'a', avgifter_amount: 0, gross_salary: 1000, tax_withheld: 0, net_salary: 1000 }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')
    const expense = linesOn(avgifter, '7510')
    expect(expense).toHaveLength(1)
    expect(expense[0].debit_amount).toBe(0)
    expect(expense[0].dimensions).toBeUndefined()
  })

  it('splits vacation accrual + its avgifter per bag; liabilities stay aggregated', async () => {
    const run = makeRun([
      makeEmployee({
        employee_id: 'a',
        vacation_accrual: 3600,
        vacation_accrual_avgifter: 1131.12,
        default_dimensions: { '1': 'KS01' },
      }),
      makeEmployee({
        employee_id: 'b',
        vacation_accrual: 3600,
        vacation_accrual_avgifter: 1131.12,
        default_dimensions: { '6': 'P001' },
      }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const vacation = entryByDescription('Semesteravsättning')

    expect(linesOn(vacation, '7290')).toHaveLength(2)
    expect(linesOn(vacation, '7290').map((l) => l.dimensions)).toEqual([{ '1': 'KS01' }, { '6': 'P001' }])
    expect(linesOn(vacation, '2920')).toHaveLength(1)
    expect(linesOn(vacation, '2920')[0].dimensions).toBeUndefined()
    expect(linesOn(vacation, '2920')[0].credit_amount).toBe(7200)

    expect(linesOn(vacation, '7519')).toHaveLength(2)
    expect(linesOn(vacation, '2940')).toHaveLength(1)
    expect(linesOn(vacation, '2940')[0].credit_amount).toBe(2262.24)
    assertBalanced(vacation)
  })

  it('splits pension + SLP per bag; liabilities stay aggregated', async () => {
    const run = makeRun([
      makeEmployee({
        employee_id: 'a',
        pension_contribution: 2116,
        pension_slp: 513.34,
        default_dimensions: { '1': 'KS01' },
      }),
      makeEmployee({
        employee_id: 'b',
        pension_contribution: 1058,
        pension_slp: 256.67,
      }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const pension = entryByDescription('Pensionsavsättning')

    const pensionLines = linesOn(pension, '7410')
    expect(pensionLines).toHaveLength(2)
    expect(pensionLines.map((l) => l.dimensions)).toEqual([{ '1': 'KS01' }, undefined])
    expect(linesOn(pension, '2740')[0].credit_amount).toBe(3174)
    expect(linesOn(pension, '2740')[0].dimensions).toBeUndefined()

    const slpLines = linesOn(pension, '7533')
    expect(slpLines).toHaveLength(2)
    expect(linesOn(pension, '2514')[0].credit_amount).toBe(770.01)
    assertBalanced(pension)
  })

  it('rejects an invalid bag (coerce gate) rather than booking junk keys', async () => {
    const run = makeRun([
      makeEmployee({ employee_id: 'a', default_dimensions: { '0': 'BAD' } as Record<string, string> }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')
    expect(linesOn(salary, '7210')[0].dimensions).toBeUndefined()
  })
})
