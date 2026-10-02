import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput } from '@/types'
import type { AccountDimensionRule } from '@/lib/bookkeeping/dimension-rules'

// Capture pattern: mock the engine and assert on the CreateJournalEntryInput
// each salary sub-entry builder produces (same approach as
// lib/bookkeeping/__tests__/invoice-entries.test.ts). The run posts through
// createJournalEntries (kept real): every voucher is drafted first, then
// committed in order. The fake ledger records what commitEntry posted, and
// the supabase mock below serves it back to the resume lookup, so a retry
// test sees exactly what the interrupted attempt left behind.
const fake = vi.hoisted(() => ({
  drafts: new Map<string, CreateJournalEntryInput>(),
  ledger: [] as Array<Record<string, unknown> & { id: string; source_id?: string | null; status: string }>,
  rules: [] as AccountDimensionRule[],
  failCommit: null as ((input: CreateJournalEntryInput) => boolean) | null,
  failDraft: null as ((input: CreateJournalEntryInput) => boolean) | null,
  seq: 0,
  voucherSeq: 0,
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  createDraftEntry: vi.fn(async (_s: unknown, _c: string, _u: string, input: CreateJournalEntryInput) => {
    if (fake.failDraft?.(input)) throw new Error(`draft refused: ${input.description}`)
    const id = `je-${++fake.seq}`
    fake.drafts.set(id, input)
    return { id, status: 'draft', voucher_number: 0, ...input }
  }),
  commitEntry: vi.fn(async (_s: unknown, _c: string, _u: string, id: string) => {
    const input = fake.drafts.get(id)
    if (!input) throw new Error(`no draft ${id}`)
    if (fake.failCommit?.(input)) throw new Error(`commit failed: ${input.description}`)
    const row = { ...input, id, status: 'posted', voucher_number: ++fake.voucherSeq }
    fake.ledger.push(row)
    return row
  }),
  cancelDraftEntry: vi.fn(async (_s: unknown, _c: string, _u: string, id: string) => ({ id, status: 'cancelled' })),
  findFiscalPeriod: vi.fn(async () => 'fp-1'),
}))

vi.mock('@/lib/bookkeeping/dimension-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/dimension-rules')>()),
  fetchActiveDimensionRules: vi.fn(async () => fake.rules),
}))

import { cancelDraftEntry, commitEntry, createDraftEntry } from '@/lib/bookkeeping/engine'
import { MandatoryDimensionMissingError } from '@/lib/bookkeeping/dimension-errors'
import {
  buildSalaryRunEntryLines,
  createSalaryRunEntries,
  SalaryRunPartiallyBookedError,
  salaryRunDataFromRows,
} from '../salary-entries'

const mockedCreateEntry = vi.mocked(createDraftEntry)
const mockedCommit = vi.mocked(commitEntry)
const mockedCancel = vi.mocked(cancelDraftEntry)

interface CashAccountFixture {
  ledger_account: string
  enabled: boolean
  currency: string
}

/** A seeded company: 1930 Företagskonto, enabled SEK, primary. */
const PRIMARY_1930: CashAccountFixture = { ledger_account: '1930', enabled: true, currency: 'SEK' }

/**
 * Supabase mock for the reads createSalaryRunEntries makes:
 *   - cash_accounts (resolvePrimaryBankAccount): the primary row, then, when
 *     the primary cannot carry the payment, the enabled SEK candidates;
 *   - chart_of_accounts (ensureSalaryAccountsExist): every account exists,
 *     and the account numbers asked for are recorded in `ensured`;
 *   - journal_entries (the resume lookup): the fake ledger's posted rows for
 *     the asked source_id, or a read error when `ledgerError` is set.
 * The default is a company whose bank account IS 1930, so every test written
 * before issue #3097 keeps asserting the 1930 leg.
 */
function makeSupabase(
  cash: { primary?: CashAccountFixture | null; enabledSek?: string[] } = { primary: PRIMARY_1930 },
  ensured: string[] = [],
  { ledgerError = false }: { ledgerError?: boolean } = {},
) {
  const cashChain = () => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: cash.primary ?? null, error: null }),
      limit: async () => ({
        data: (cash.enabledSek ?? []).map((ledger_account) => ({ ledger_account })),
        error: null,
      }),
    }
    return chain
  }
  const ledgerChain = () => {
    const filters: Record<string, unknown> = {}
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters[column] = value
        return chain
      },
      order: async () =>
        ledgerError
          ? { data: null, error: { message: 'connection reset' } }
          : {
              data: fake.ledger.filter(
                (row) => row.source_id === filters.source_id && row.status === filters.status,
              ),
              error: null,
            },
    }
    return chain
  }
  return {
    from: vi.fn((table: string) => {
      if (table === 'cash_accounts') return cashChain()
      if (table === 'journal_entries') return ledgerChain()
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            in: vi.fn(async (_col: string, accounts: string[]) => {
              ensured.push(...accounts)
              return { data: accounts.map((account_number) => ({ account_number })), error: null }
            }),
          })),
        })),
      }
    }),
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
  mockedCommit.mockClear()
  mockedCancel.mockClear()
  fake.drafts.clear()
  fake.ledger.length = 0
  fake.rules = []
  fake.failCommit = null
  fake.failDraft = null
  fake.seq = 0
  fake.voucherSeq = 0
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

  it('a fully paid car benefit books a balanced verifikat: salary in full, payment credited, benefit value not booked', async () => {
    // The engine's totals for salary 48 000, bilförmån 6 664 and a payment of
    // the same amount (lib/salary/__tests__/benefit-payment.test.ts): the
    // taxable förmånsvärde is 0, tax is on 48 000, net = 48 000 - 10 050 - 6 664.
    const run = makeRun([
      makeEmployee({
        gross_salary: 48000,
        tax_withheld: 10050,
        net_salary: 31286,
        avgifter_basis: 48000,
        avgifter_amount: 15081.6,
        line_items: [
          { item_type: 'monthly_salary', amount: 48000, account_number: null, is_net_deduction: false, is_gross_deduction: false },
          { item_type: 'benefit_car', amount: 6664, account_number: null, is_net_deduction: false, is_gross_deduction: false },
          {
            item_type: 'net_deduction_benefit_payment',
            amount: -6664,
            account_number: null,
            is_net_deduction: true,
            is_gross_deduction: false,
          },
        ],
      }),
    ])

    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')

    expect(linesOn(salary, '7210')[0].debit_amount).toBe(48000)
    // The employee's payment for the benefit is the only 7385 line, a credit.
    // The förmånsvärde itself has no cash flow and is never booked.
    expect(linesOn(salary, '7385')).toHaveLength(1)
    expect(linesOn(salary, '7385')[0].credit_amount).toBe(6664)
    expect(linesOn(salary, '7385')[0].debit_amount).toBe(0)
    expect(linesOn(salary, '2710')[0].credit_amount).toBe(10050)
    expect(linesOn(salary, '1930')[0].credit_amount).toBe(31286)
    // 48 000 = 6 664 + 10 050 + 31 286
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

    // A separate booking of a separate run: start from an empty ledger, or
    // the resume lookup would (rightly) refuse the first booking's vouchers.
    mockedCreateEntry.mockClear()
    fake.ledger.length = 0
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

  it('a run without avgifter builds and posts no avgifter voucher (the engine refuses an all-zero one)', async () => {
    const run = makeRun([
      makeEmployee({ employee_id: 'a', avgifter_amount: 0, gross_salary: 1000, tax_withheld: 0, net_salary: 1000 }),
    ])
    expect(buildSalaryRunEntryLines(run, 'Lön 2026-06', '1930').avgifterLines).toEqual([])

    const result = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)

    expect(mockedCreateEntry.mock.calls.map((call) => call[3].description)).toEqual(['Lön 2026-06'])
    expect(result.avgifterEntry).toBeNull()
    expect(result.salaryEntry.id).toBe(fake.ledger[0].id)
  })

  it('opposite-signed avgifter buckets that net to zero still book, without a 0/0 liability line', async () => {
    const run = makeRun([
      makeEmployee({ employee_id: 'a', avgifter_amount: 500, default_dimensions: { '1': 'KS01' } }),
      makeEmployee({ employee_id: 'b', avgifter_amount: -500, default_dimensions: { '1': 'KS02' } }),
    ])
    const { avgifterLines } = buildSalaryRunEntryLines(run, 'Lön 2026-06', '1930')

    expect(avgifterLines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['7510', 500, 0],
      ['7510', 0, 500],
    ])
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

describe('salary entries: negative avgifter keep one non-negative side', () => {
  it('books a negative avgifter month as 7510 K / 2731 D instead of a negative debit', async () => {
    // Full-month unpaid leave plus a manual deduction pushes gross below zero;
    // avgifter follow (31,42 % of -2 000 = -628,40). The old builder emitted
    // 7510 D -628,40, which the engine now refuses; the side must flip.
    const run = makeRun([
      makeEmployee({ employee_id: 'a', gross_salary: -2000, avgifter_amount: -628.4, avgifter_basis: undefined }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const avgifter = entryByDescription('Arbetsgivaravgifter')

    const expense = linesOn(avgifter, '7510')
    expect(expense).toHaveLength(1)
    expect(expense[0]).toMatchObject({ debit_amount: 0, credit_amount: 628.4 })
    const liability = linesOn(avgifter, '2731')
    expect(liability).toHaveLength(1)
    expect(liability[0]).toMatchObject({ debit_amount: 628.4, credit_amount: 0 })
    for (const l of avgifter.lines) {
      expect(l.debit_amount).toBeGreaterThanOrEqual(0)
      expect(l.credit_amount).toBeGreaterThanOrEqual(0)
    }
    assertBalanced(avgifter)
  })
})

describe('salary entries: kostnadsersättning (#2331)', () => {
  const claimLine = (amount: number, account: string | null = '2820') => ({
    item_type: 'expense_reimbursement',
    amount,
    account_number: account,
    is_net_deduction: false,
    is_gross_deduction: false,
  })

  it('debits 2820 for an utlägg line on top of the full gross and keeps the entry balanced', async () => {
    // net = gross - tax + reimbursement: the 1930 credit carries the claim.
    const run = makeRun([
      makeEmployee({
        net_salary: 23000 + 1234.5,
        line_items: [
          { item_type: 'monthly_salary', amount: 30000, account_number: '7210', is_net_deduction: false, is_gross_deduction: false },
          claimLine(1234.5),
        ],
      }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')
    expect(linesOn(salary, '7210')).toEqual([expect.objectContaining({ debit_amount: 30000 })])
    expect(linesOn(salary, '2820')).toEqual([
      expect.objectContaining({ debit_amount: 1234.5, credit_amount: 0, line_description: 'Lön 2026-06: Kortfristiga skulder till anställda' }),
    ])
    expect(linesOn(salary, '1930')[0].credit_amount).toBe(24234.5)
    assertBalanced(salary)
  })

  it('falls back to 2820 without an account on the line and never dimensions the liability leg', async () => {
    const run = makeRun([
      makeEmployee({ net_salary: 23500, default_dimensions: { '1': 'KS01' }, line_items: [claimLine(500, null)] }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')
    expect(linesOn(salary, '7210')[0]).toEqual(
      expect.objectContaining({ debit_amount: 30000, dimensions: { '1': 'KS01' } }),
    )
    expect(linesOn(salary, '2820')[0].debit_amount).toBe(500)
    expect(linesOn(salary, '2820')[0].dimensions).toBeUndefined()
    assertBalanced(salary)
  })

  it('books skattefri milersättning on 7331 on top of gross, following the employee bag', async () => {
    const run = makeRun([
      makeEmployee({
        net_salary: 23250,
        default_dimensions: { '1': 'KS01' },
        line_items: [
          { item_type: 'mileage_taxfree', amount: 250, account_number: '7331', is_net_deduction: false, is_gross_deduction: false },
        ],
      }),
    ])
    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')
    // The base salary debit is NOT reduced by the reimbursement.
    expect(linesOn(salary, '7210')[0].debit_amount).toBe(30000)
    expect(linesOn(salary, '7331')[0]).toEqual(
      expect.objectContaining({ debit_amount: 250, dimensions: { '1': 'KS01' } }),
    )
    assertBalanced(salary)
  })

  it('books a run that only repays utlägg as 2820 D / 1930 K', async () => {
    const run = makeRun([
      makeEmployee({
        gross_salary: 0,
        tax_withheld: 0,
        net_salary: 800,
        avgifter_amount: 0,
        avgifter_basis: 0,
        line_items: [claimLine(800)],
      }),
    ])
    const result = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)
    const salary = entryByDescription('Lön 2026-06')
    expect(salary.lines).toEqual([
      expect.objectContaining({ account_number: '2820', debit_amount: 800, credit_amount: 0 }),
      expect.objectContaining({ account_number: '1930', debit_amount: 0, credit_amount: 800 }),
    ])
    // No avgifter anywhere: the utlägg run posts only its salary voucher.
    expect(fake.ledger.map((row) => row.description)).toEqual(['Lön 2026-06'])
    expect(result.avgifterEntry).toBeNull()
  })
})

describe('salary entries: one line builder for booking and preview (feedback seq 384229)', () => {
  const benefitCar = {
    item_type: 'benefit_car',
    amount: 7049,
    account_number: '7385',
    is_net_deduction: false,
    is_gross_deduction: false,
  }

  it('skips förmånsvärden (no cash flow) and keeps the salary lines balanced', () => {
    const run = makeRun([
      makeEmployee({
        line_items: [
          { item_type: 'base_salary', amount: 30000, account_number: '7210', is_net_deduction: false, is_gross_deduction: false },
          benefitCar,
        ],
      }),
    ])
    const { salaryLines } = buildSalaryRunEntryLines(run, 'Lön 2026-06', '1930')
    // The bilförmån raises the tax base, not the cost: no 7385 line, and no
    // orphan debit for the preview to be off by.
    expect(salaryLines.some((l) => l.account_number === '7385')).toBe(false)
    expect(salaryLines.find((l) => l.account_number === '7210')?.debit_amount).toBe(30000)
    const debit = salaryLines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = salaryLines.reduce((s, l) => s + l.credit_amount, 0)
    expect(Math.round((debit - credit) * 100) / 100).toBe(0)
  })

  it('books exactly the lines the builder returns, so a preview built from it cannot diverge', async () => {
    const run = makeRun([
      makeEmployee({ line_items: [benefitCar], vacation_accrual: 1200, vacation_accrual_avgifter: 377.04 }),
    ])
    const built = buildSalaryRunEntryLines(run, 'Lön 2026-06', '1930')
    await createSalaryRunEntries(makeSupabase(), 'co-1', 'user-1', run)
    expect(mockedCreateEntry.mock.calls.map((c) => c[3].lines)).toEqual([
      built.salaryLines,
      built.avgifterLines,
      built.vacationLines,
    ])
    expect(built.pensionLines).toEqual([])
  })

  it('maps roster rows once: tax override moves tax and net, dimensions follow, F-skatt ignores avgifter overrides', () => {
    const runRow = {
      id: 'run-1',
      period_year: 2026,
      period_month: 6,
      payment_date: '2026-06-25',
      voucher_series: 'L',
      total_gross: 0,
      total_tax: 0,
      total_net: 0,
      total_avgifter: 0,
      total_vacation_accrual: 0,
      calculation_params: { slpRate: 0.2426 },
    }
    const rosterRow = {
      employee_id: 'emp-1',
      gross_salary: 30000,
      tax_withheld: 7000,
      tax_withheld_override: 6000,
      net_salary: 23000,
      avgifter_amount: 9426,
      avgifter_amount_override: 9000,
      avgifter_basis: 30000,
      avgifter_rate: 0.3142,
      avgifter_category: 'standard',
      vacation_accrual: 0,
      vacation_accrual_avgifter: 0,
      employee: { employment_type: 'company_owner', default_dimensions: { '1': 'HQ' }, f_skatt_status: null },
      line_items: [benefitCar],
    }
    const run = salaryRunDataFromRows(runRow, [
      rosterRow,
      {
        ...rosterRow,
        employee_id: 'emp-2',
        tax_withheld_override: null,
        avgifter_amount: 100,
        avgifter_amount_override: 0,
        employee: { employment_type: 'employee', default_dimensions: null, f_skatt_status: 'f_skatt' },
        line_items: [],
      },
    ])
    expect(run.calculation_params).toEqual({ slpRate: 0.2426 })
    expect(run.employees[0]).toMatchObject({
      employment_type: 'company_owner',
      tax_withheld: 6000,
      net_salary: 24000,
      avgifter_amount: 9000,
      avgifter_basis: 30000,
      avgifter_amount_overridden: true,
      default_dimensions: { '1': 'HQ' },
    })
    expect(run.employees[0].line_items).toEqual([benefitCar])
    expect(run.employees[1]).toMatchObject({
      employment_type: 'employee',
      tax_withheld: 7000,
      net_salary: 23000,
      avgifter_amount: 100,
      avgifter_basis: 0,
      avgifter_amount_overridden: false,
      default_dimensions: undefined,
    })
  })
})

// Issue #3097: the net pay left the company's real bank account (1931, the
// primary) while the verifikat credited 1930, so the bank row could never be
// matched and the voucher needed a storno.
describe("salary entries: net pay on the company's own bank account", () => {
  const run = () => makeRun([makeEmployee()])

  it('credits the net pay on the primary cash account when it is not 1930', async () => {
    const ensured: string[] = []
    await createSalaryRunEntries(
      makeSupabase({ primary: { ledger_account: '1931', enabled: true, currency: 'SEK' } }, ensured),
      'company-1',
      'user-1',
      run(),
    )
    const salary = entryByDescription('Lön 2026-06')

    expect(linesOn(salary, '1931')).toEqual([
      expect.objectContaining({ debit_amount: 0, credit_amount: 23000, line_description: 'Lön 2026-06: Nettolön' }),
    ])
    expect(linesOn(salary, '1930')).toEqual([])
    assertBalanced(salary)
    // The chart check covers the account actually booked, not a constant 1930.
    expect(ensured).toContain('1931')
    expect(ensured).not.toContain('1930')
    // No other entry of the run touches a bank account.
    for (const call of mockedCreateEntry.mock.calls) {
      if (call[3].description === 'Lön 2026-06') continue
      expect(call[3].lines.some((l) => /^19/.test(l.account_number))).toBe(false)
    }
  })

  it('never credits a disabled 1930: the only enabled SEK account carries the net pay', async () => {
    // The reported shape: 1930 under "Avstängda bankkonton" and still flagged
    // primary, the PSD2 account on 1931 enabled.
    await createSalaryRunEntries(
      makeSupabase({ primary: { ledger_account: '1930', enabled: false, currency: 'SEK' }, enabledSek: ['1931'] }),
      'company-1',
      'user-1',
      run(),
    )
    const salary = entryByDescription('Lön 2026-06')
    expect(linesOn(salary, '1931')[0].credit_amount).toBe(23000)
    expect(linesOn(salary, '1930')).toEqual([])
  })

  it('keeps 1930 for a legacy company with no cash accounts at all', async () => {
    await createSalaryRunEntries(makeSupabase({ primary: null, enabledSek: [] }), 'company-1', 'user-1', run())
    expect(linesOn(entryByDescription('Lön 2026-06'), '1930')[0].credit_amount).toBe(23000)
  })

  it('the builder books the net pay on whatever account the caller resolved', () => {
    const { salaryLines } = buildSalaryRunEntryLines(run(), 'Lön 2026-06', '1931')
    expect(salaryLines.filter((l) => /^19/.test(l.account_number))).toEqual([
      expect.objectContaining({ account_number: '1931', debit_amount: 0, credit_amount: 23000 }),
    ])
  })
})

describe('salary entries: all vouchers or none, and a retry never posts one twice', () => {
  const PROJECT_REQUIRED_ON = (account: string): AccountDimensionRule => ({
    account_number: account,
    rule_type: 'required',
    sie_dim_no: '6',
    dimension_name: 'Projekt',
    value_code: null,
  })

  /** Salary + avgifter + vacation: three vouchers, so "partway" has a middle. */
  const threeVoucherRun = () =>
    makeRun([makeEmployee({ vacation_accrual: 1200, vacation_accrual_avgifter: 377.04 })])

  const postedDescriptions = () => fake.ledger.map((row) => row.description)

  it('drafts every voucher before committing the first, then posts each once', async () => {
    const result = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', threeVoucherRun())

    expect(Math.max(...mockedCreateEntry.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...mockedCommit.mock.invocationCallOrder),
    )
    expect(postedDescriptions()).toEqual([
      'Lön 2026-06',
      'Lön 2026-06: Arbetsgivaravgifter',
      'Lön 2026-06: Semesteravsättning',
    ])
    expect(result.salaryEntry.id).toBe(fake.ledger[0].id)
    expect(result.avgifterEntry?.id).toBe(fake.ledger[1].id)
    expect(result.vacationEntry?.id).toBe(fake.ledger[2].id)
    expect(result.pensionEntry).toBeNull()
    expect(mockedCancel).not.toHaveBeenCalled()
  })

  it.each([
    ['7510, the avgifter voucher (a P&L account the employee bag should tag)', '7510'],
    ['2731, a balance account salary never tags', '2731'],
    ['2920, the vacation liability of the third voucher', '2920'],
  ])('a required dimension on %s refuses the run before any voucher is drafted or posted', async (_label, account) => {
    fake.rules = [PROJECT_REQUIRED_ON(account)]

    await expect(
      createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', threeVoucherRun()),
    ).rejects.toBeInstanceOf(MandatoryDimensionMissingError)

    expect(mockedCreateEntry).not.toHaveBeenCalled()
    expect(mockedCommit).not.toHaveBeenCalled()
    expect(fake.ledger).toHaveLength(0)
  })

  it('names every missing value of the whole run in one refusal', async () => {
    fake.rules = [PROJECT_REQUIRED_ON('7210'), PROJECT_REQUIRED_ON('7510')]

    const error = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', threeVoucherRun()).catch(
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(MandatoryDimensionMissingError)
    expect((error as MandatoryDimensionMissingError).violations.map((v) => v.account_number).sort()).toEqual([
      '7210',
      '7510',
    ])
  })

  it('an engine refusal of voucher 2 at draft time posts nothing and cancels voucher 1\'s draft', async () => {
    // Stands in for every draft-time check of the engine: an archived
    // dimension value, a deactivated account, an unbalanced voucher.
    fake.failDraft = (input) => input.description.endsWith('Arbetsgivaravgifter')

    await expect(
      createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', threeVoucherRun()),
    ).rejects.toThrow('draft refused')

    expect(mockedCommit).not.toHaveBeenCalled()
    expect(fake.ledger).toHaveLength(0)
    expect(mockedCancel.mock.calls.map((call) => call[3])).toEqual(['je-1'])
  })

  it('a commit failure after voucher 1 cancels the remaining drafts; the retry posts only what is missing', async () => {
    fake.failCommit = (input) => input.description.endsWith('Arbetsgivaravgifter')
    await expect(
      createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', threeVoucherRun()),
    ).rejects.toThrow('commit failed')

    // The interrupted state: voucher 1 is in the ledger, the rest are not.
    expect(postedDescriptions()).toEqual(['Lön 2026-06'])
    expect(mockedCancel).toHaveBeenCalledTimes(2)
    const firstSalaryId = fake.ledger[0].id

    mockedCreateEntry.mockClear()
    mockedCommit.mockClear()
    fake.failCommit = null
    const retry = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', threeVoucherRun())

    // Voucher 1 is adopted, not posted again: one voucher per slot.
    expect(postedDescriptions()).toEqual([
      'Lön 2026-06',
      'Lön 2026-06: Arbetsgivaravgifter',
      'Lön 2026-06: Semesteravsättning',
    ])
    expect(mockedCreateEntry.mock.calls.map((call) => call[3].description)).toEqual([
      'Lön 2026-06: Arbetsgivaravgifter',
      'Lön 2026-06: Semesteravsättning',
    ])
    expect(retry.salaryEntry.id).toBe(firstSalaryId)
    expect(retry.avgifterEntry?.id).toBe(fake.ledger[1].id)
    expect(retry.vacationEntry?.id).toBe(fake.ledger[2].id)
  })

  it('a retry after every voucher posted (the run flip failed) adopts them all and posts nothing', async () => {
    const first = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', threeVoucherRun())
    mockedCreateEntry.mockClear()
    mockedCommit.mockClear()

    const again = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', threeVoucherRun())

    expect(mockedCreateEntry).not.toHaveBeenCalled()
    expect(mockedCommit).not.toHaveBeenCalled()
    expect(fake.ledger).toHaveLength(3)
    expect([again.salaryEntry.id, again.avgifterEntry?.id, again.vacationEntry?.id]).toEqual([
      first.salaryEntry.id,
      first.avgifterEntry?.id,
      first.vacationEntry?.id,
    ])
  })

  it('refuses by voucher number a posted voucher of the run that this booking would not post', async () => {
    fake.ledger.push({
      id: 'je-stale',
      source_id: 'run-1',
      status: 'posted',
      voucher_series: 'L',
      voucher_number: 7,
      entry_date: '2026-06-25',
      description: 'Lön 2026-06',
      // Booked before the run changed: different amounts than the run now.
      lines: [
        { account_number: '7210', debit_amount: 29000, credit_amount: 0 },
        { account_number: '2710', debit_amount: 0, credit_amount: 7000 },
        { account_number: '1930', debit_amount: 0, credit_amount: 22000 },
      ],
    })

    const error = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', threeVoucherRun()).catch(
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(SalaryRunPartiallyBookedError)
    expect((error as SalaryRunPartiallyBookedError).details).toEqual({
      voucher_numbers: ['L7'],
      entry_ids: ['je-stale'],
    })
    expect((error as Error).message).toContain('(L7)')
    expect(mockedCreateEntry).not.toHaveBeenCalled()
    expect(mockedCommit).not.toHaveBeenCalled()
  })

  it('never adopts a voucher with the right lines on another date', async () => {
    const run = threeVoucherRun()
    const built = buildSalaryRunEntryLines(run, 'Lön 2026-06', '1930')
    fake.ledger.push({
      id: 'je-other-date',
      source_id: 'run-1',
      status: 'posted',
      voucher_series: 'L',
      voucher_number: 3,
      entry_date: '2026-06-24',
      description: 'Lön 2026-06',
      lines: built.salaryLines,
    })

    await expect(createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)).rejects.toBeInstanceOf(
      SalaryRunPartiallyBookedError,
    )
    expect(mockedCommit).not.toHaveBeenCalled()
  })

  it('a duplicate left by the old retry is named; the first copy is the one kept', async () => {
    const run = threeVoucherRun()
    const built = buildSalaryRunEntryLines(run, 'Lön 2026-06', '1930')
    for (const [id, voucher_number] of [['je-first', 3], ['je-duplicate', 4]] as const) {
      fake.ledger.push({
        id,
        source_id: 'run-1',
        status: 'posted',
        voucher_series: 'L',
        voucher_number,
        entry_date: '2026-06-25',
        description: 'Lön 2026-06',
        lines: built.salaryLines,
      })
    }

    const error = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run).catch(
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(SalaryRunPartiallyBookedError)
    expect((error as SalaryRunPartiallyBookedError).details.voucher_numbers).toEqual(['L4'])
    expect(mockedCommit).not.toHaveBeenCalled()
  })

  it('ignores a voucher the user already reversed (status reversed) and books the run in full', async () => {
    const run = threeVoucherRun()
    fake.ledger.push({
      id: 'je-reversed',
      source_id: 'run-1',
      status: 'reversed',
      voucher_series: 'L',
      voucher_number: 3,
      entry_date: '2026-06-25',
      description: 'Lön 2026-06',
      lines: [{ account_number: '7210', debit_amount: 1, credit_amount: 0 }],
    })

    await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run)

    expect(mockedCommit).toHaveBeenCalledTimes(3)
  })

  it('a run without avgifter books its other vouchers, and a retry treats the avgifter voucher as absent', async () => {
    // F-skatt-only style run: pay and a vacation accrual, no avgifter at all.
    const run = () =>
      makeRun([
        makeEmployee({ avgifter_amount: 0, avgifter_basis: 0, vacation_accrual: 1200, vacation_accrual_avgifter: 0 }),
      ])
    fake.failCommit = (input) => input.description.endsWith('Semesteravsättning')
    await expect(createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run())).rejects.toThrow(
      'commit failed',
    )
    expect(postedDescriptions()).toEqual(['Lön 2026-06'])

    fake.failCommit = null
    mockedCreateEntry.mockClear()
    const retry = await createSalaryRunEntries(makeSupabase(), 'company-1', 'user-1', run())

    expect(mockedCreateEntry.mock.calls.map((call) => call[3].description)).toEqual([
      'Lön 2026-06: Semesteravsättning',
    ])
    expect(postedDescriptions()).toEqual(['Lön 2026-06', 'Lön 2026-06: Semesteravsättning'])
    expect(retry.avgifterEntry).toBeNull()
    expect(retry.vacationEntry?.id).toBe(fake.ledger[1].id)
  })

  it('fails closed: when the lookup of already-posted vouchers fails, nothing is posted', async () => {
    await expect(
      createSalaryRunEntries(makeSupabase(undefined, [], { ledgerError: true }), 'company-1', 'user-1', threeVoucherRun()),
    ).rejects.toThrow('Kunde inte kontrollera lönekörningens tidigare bokförda verifikationer')

    expect(mockedCreateEntry).not.toHaveBeenCalled()
    expect(mockedCommit).not.toHaveBeenCalled()
  })
})
