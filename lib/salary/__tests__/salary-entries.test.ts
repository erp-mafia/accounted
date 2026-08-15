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
  avgifter_basis?: number
  avgifter_category?: string | null
  avgifter_amount_overridden?: boolean
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
    avgifter_basis: 30000,
    avgifter_category: 'standard',
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
    calculation_params: { slpRate: 0.2426 },
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

describe('salary entries: net deductions', () => {
  it('credits a union-fee liability and keeps the salary entry balanced', async () => {
    const run = makeRun([
      makeEmployee({
        gross_salary: 40000,
        tax_withheld: 12000,
        net_salary: 27500,
        line_items: [
          {
            item_type: 'net_deduction_union',
            amount: -500,
            account_number: null,
            is_net_deduction: true,
            is_gross_deduction: false,
          },
        ],
      }),
    ])

    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')

    expect(linesOn(salary, '7210')[0].debit_amount).toBe(40000)
    expect(linesOn(salary, '2710')[0].credit_amount).toBe(12000)
    expect(linesOn(salary, '1930')[0].credit_amount).toBe(27500)
    expect(linesOn(salary, '2794')[0].credit_amount).toBe(500)
    assertBalanced(salary)
  })

  it('uses BAS-specific defaults and preserves an explicit account override', async () => {
    const run = makeRun([
      makeEmployee({
        gross_salary: 40000,
        tax_withheld: 10000,
        net_salary: 28000,
        line_items: [
          {
            item_type: 'net_deduction_advance',
            amount: -200,
            account_number: null,
            is_net_deduction: true,
            is_gross_deduction: false,
          },
          {
            item_type: 'net_deduction_union',
            amount: -300,
            account_number: null,
            is_net_deduction: true,
            is_gross_deduction: false,
          },
          {
            item_type: 'net_deduction_benefit_payment',
            amount: -400,
            account_number: null,
            is_net_deduction: true,
            is_gross_deduction: false,
          },
          {
            item_type: 'net_deduction_other',
            amount: -500,
            account_number: null,
            is_net_deduction: true,
            is_gross_deduction: false,
          },
          {
            item_type: 'net_deduction_other',
            amount: -600,
            account_number: '2890',
            is_net_deduction: true,
            is_gross_deduction: false,
          },
        ],
      }),
    ])

    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')

    expect(linesOn(salary, '1613')[0].credit_amount).toBe(200)
    expect(linesOn(salary, '2794')[0].credit_amount).toBe(300)
    expect(linesOn(salary, '7385')[0].credit_amount).toBe(400)
    expect(linesOn(salary, '2799')[0].credit_amount).toBe(500)
    expect(linesOn(salary, '2890')[0].credit_amount).toBe(600)
    assertBalanced(salary)
  })

  it('books a positive correction as a debit repayment', async () => {
    const run = makeRun([
      makeEmployee({
        gross_salary: 30000,
        tax_withheld: 7000,
        net_salary: 23200,
        line_items: [
          {
            item_type: 'net_deduction_union',
            amount: 200,
            account_number: null,
            is_net_deduction: true,
            is_gross_deduction: false,
          },
        ],
      }),
    ])

    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')

    expect(linesOn(salary, '2794')[0].debit_amount).toBe(200)
    expect(linesOn(salary, '2794')[0].credit_amount).toBe(0)
    assertBalanced(salary)
  })
})

describe('salary entries: öresavrundning', () => {
  const roundingItem = (amount: number) => ({
    item_type: 'oresavrundning',
    amount,
    account_number: '3740',
    is_net_deduction: false,
    is_gross_deduction: false,
  })

  it('debits 3740 for the rounding without shrinking the base salary line', async () => {
    // net_salary is stored rounded (22999.70 → 23000); the line item carries
    // the 0.30 diff. The 7210 debit must stay the full gross.
    const run = makeRun([
      makeEmployee({
        gross_salary: 30000,
        tax_withheld: 7000.3,
        net_salary: 23000,
        line_items: [roundingItem(0.3)],
      }),
    ])

    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')

    expect(linesOn(salary, '7210')[0].debit_amount).toBe(30000)
    expect(linesOn(salary, '3740')[0].debit_amount).toBe(0.3)
    expect(linesOn(salary, '2710')[0].credit_amount).toBe(7000.3)
    expect(linesOn(salary, '1930')[0].credit_amount).toBe(23000)
    assertBalanced(salary)
  })

  it('keeps the base remainder correct next to other line items', async () => {
    const run = makeRun([
      makeEmployee({
        gross_salary: 32000,
        tax_withheld: 8000.55,
        net_salary: 24000,
        line_items: [
          { item_type: 'overtime', amount: 2000, account_number: '7281', is_net_deduction: false, is_gross_deduction: false },
          roundingItem(0.55),
        ],
      }),
    ])

    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')

    expect(linesOn(salary, '7281')[0].debit_amount).toBe(2000)
    // Remainder is gross - overtime, NOT gross - overtime - rounding.
    expect(linesOn(salary, '7210')[0].debit_amount).toBe(30000)
    expect(linesOn(salary, '3740')[0].debit_amount).toBe(0.55)
    assertBalanced(salary)
  })

  it('tags the rounding line with the employee dimensions bag and aggregates per bag', async () => {
    const run = makeRun([
      makeEmployee({
        employee_id: 'a',
        gross_salary: 30000,
        tax_withheld: 7000.3,
        net_salary: 23000,
        default_dimensions: { '1': 'KS01' },
        line_items: [roundingItem(0.3)],
      }),
      makeEmployee({
        employee_id: 'b',
        gross_salary: 30000,
        tax_withheld: 7000.6,
        net_salary: 23000,
        default_dimensions: { '1': 'KS01' },
        line_items: [roundingItem(0.6)],
      }),
    ])

    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')

    const roundingLines = linesOn(salary, '3740')
    expect(roundingLines).toHaveLength(1)
    expect(roundingLines[0].debit_amount).toBe(0.9)
    expect(roundingLines[0].dimensions).toEqual({ '1': 'KS01' })
    assertBalanced(salary)
  })
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
    // avgifter_basis undefined = legacy caller shape: the declared-avgifter
    // split is skipped and 2731 takes the full öre-exact liability, which is
    // what this test asserts below.
    const run = makeRun([
      makeEmployee({ employee_id: 'a', avgifter_amount: 9426.505, avgifter_basis: undefined, default_dimensions: { '1': 'KS01' } }),
      makeEmployee({ employee_id: 'b', avgifter_amount: 9426.505, avgifter_basis: undefined, default_dimensions: { '1': 'KS02' } }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')

    const expense = linesOn(avgifter, '7510')
    expect(expense).toHaveLength(2)
    expect(expense.map((l) => l.dimensions)).toEqual([{ '1': 'KS01' }, { '1': 'KS02' }])

    const liability = linesOn(avgifter, '2731')
    expect(liability).toHaveLength(1)
    expect(liability[0].dimensions).toBeUndefined()
    // Balance by construction: without avgifter_basis (legacy caller shape)
    // 2731 carries the full sum of the ROUNDED debits, even when the
    // partition rounds differently from the raw total, and no 3740 appears.
    expect(liability[0].credit_amount).toBe(
      Math.round(expense.reduce((s, l) => s + l.debit_amount, 0) * 100) / 100,
    )
    expect(linesOn(avgifter, '3740')).toHaveLength(0)
    assertBalanced(avgifter)
  })

  it('books 2731 in whole kronor and the öre remainder on 3740', async () => {
    // The reported first-lönekörning case: 51 158 kr gross at 31,42 % gives
    // avgifter 16 073,8436 → 16 073,84 booked cost. Skatteverket computes
    // trunc(51 158 × 31,42 %) = 16 073 from the declared underlag and draws
    // that, so the liability must be 16 073 and the 84 öre settle as
    // öresutjämning: crediting 2731 with the öre would leave a perpetual
    // residual after the whole-krona skattekonto draw.
    const run = makeRun([
      makeEmployee({
        gross_salary: 51158,
        tax_withheld: 12268,
        net_salary: 38890,
        avgifter_amount: 16073.84,
        avgifter_basis: 51158,
      }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')

    expect(linesOn(avgifter, '7510')[0].debit_amount).toBe(16073.84)
    expect(linesOn(avgifter, '2731')[0].credit_amount).toBe(16073)
    const utjamning = linesOn(avgifter, '3740')
    expect(utjamning).toHaveLength(1)
    expect(utjamning[0].credit_amount).toBe(0.84)
    expect(utjamning[0].debit_amount).toBe(0)
    expect(utjamning[0].line_description).toContain('Öres- och kronutjämning')
    assertBalanced(avgifter)
  })

  it('books the declared per-sats amount on 2731, kronor of utjämning included (öre wages)', async () => {
    // Skatteverket sums the whole-krona per-IU underlag before applying the
    // sats: two employees at 30 000,99 kr declare 30 000 each, so SKV draws
    // trunc(60 000 × 31,42 %) = 18 852 while the öre-exact cost is
    // 2 × 9 426,51 = 18 853,02. The 1,02 kr difference is real utjämning:
    // truncating the öre-exact sum (18 853) would leave 1 kr stuck on 2731.
    const run = makeRun([
      makeEmployee({
        employee_id: 'a',
        avgifter_amount: 9426.51,
        avgifter_basis: 30000.99,
      }),
      makeEmployee({
        employee_id: 'b',
        avgifter_amount: 9426.51,
        avgifter_basis: 30000.99,
      }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')

    expect(linesOn(avgifter, '2731')[0].credit_amount).toBe(18852)
    expect(linesOn(avgifter, '3740')[0].credit_amount).toBe(1.02)
    assertBalanced(avgifter)
  })

  it('falls back to the öre-exact liability when unflagged amounts diverge from the underlag', async () => {
    // No override flag but the stored amount is unrelated to basis × sats
    // (corrupt or legacy data): the magnitude band rejects the declared
    // split, so no utjämning is manufactured and 2731 takes the full amount.
    const run = makeRun([
      makeEmployee({ avgifter_amount: 25000.5, avgifter_basis: 30000 }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')

    expect(linesOn(avgifter, '2731')[0].credit_amount).toBe(25000.5)
    expect(linesOn(avgifter, '3740')).toHaveLength(0)
    assertBalanced(avgifter)
  })

  it('keeps a flagged amount override on 2731 and books only the truncation remainder to 3740', async () => {
    // A small upward override (16 075,90 against declared-from-basis 16 073)
    // sits INSIDE the magnitude band: without the explicit flag, the split
    // would book 2731 = 16 073 and launder the operator's +2,06 kr
    // adjustment as öresutjämning. The flag switches to the override mirror
    // (per-category truncation, the same number the AGI stores and the
    // payment pays): 2731 = 16 075, and only 90 öre book as utjämning.
    const run = makeRun([
      makeEmployee({
        avgifter_amount: 16075.9,
        avgifter_basis: 51158,
        avgifter_amount_overridden: true,
      }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')

    expect(linesOn(avgifter, '2731')[0].credit_amount).toBe(16075)
    expect(linesOn(avgifter, '3740')[0].credit_amount).toBe(0.9)
    assertBalanced(avgifter)
  })

  it('mixes an overridden employee with computed colleagues without stranding öre (FoU case)', async () => {
    // Downward FoU-avdrag override 7 855 next to a colleague's computed
    // 16 073,84: the colleague keeps the SKV-exact declared amount
    // (trunc(51 158 × 31,42 %) = 16 073) and the override contributes 7 855
    // → 2731 = 23 928 (what the AGI stores and the payment pays), 84 öre to
    // 3740. Booking, declaration and payment stay one number.
    const run = makeRun([
      makeEmployee({
        employee_id: 'a',
        avgifter_amount: 7855,
        avgifter_basis: 51158,
        avgifter_amount_overridden: true,
      }),
      makeEmployee({
        employee_id: 'b',
        avgifter_amount: 16073.84,
        avgifter_basis: 51158,
      }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')

    expect(linesOn(avgifter, '2731')[0].credit_amount).toBe(23928)
    expect(linesOn(avgifter, '3740')[0].credit_amount).toBe(0.84)
    assertBalanced(avgifter)
  })

  it('emits no 3740 line when the avgifter total is already whole kronor', async () => {
    const run = makeRun([
      // 30 000 × 0,3142 = 9 426,00 exactly.
      makeEmployee({ avgifter_amount: 9426 }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')
    expect(linesOn(avgifter, '2731')[0].credit_amount).toBe(9426)
    expect(linesOn(avgifter, '3740')).toHaveLength(0)
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

  it('derives pension + SLP from gross_deduction_pension line items', async () => {
    const run = makeRun([
      makeEmployee({
        employee_id: 'a',
        default_dimensions: { '1': 'KS01' },
        line_items: [
          {
            item_type: 'gross_deduction_pension',
            amount: -2000,
            account_number: '7218',
            is_net_deduction: false,
            is_gross_deduction: true,
          },
        ],
      }),
    ])

    const result = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const pension = entryByDescription('Pensionsavsättning')

    expect(result.pensionEntry).not.toBeNull()
    expect(linesOn(pension, '7410')).toEqual([
      expect.objectContaining({ debit_amount: 2116, dimensions: { '1': 'KS01' } }),
    ])
    expect(linesOn(pension, '2740')[0].credit_amount).toBe(2116)
    expect(linesOn(pension, '7533')[0].debit_amount).toBe(513.34)
    expect(linesOn(pension, '2514')[0].credit_amount).toBe(513.34)
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
