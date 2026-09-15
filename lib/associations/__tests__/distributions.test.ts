import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))
vi.mock('@/lib/associations/member-register', () => ({
  listContributions: vi.fn(),
  listMembers: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))

import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { listContributions, listMembers } from '@/lib/associations/member-register'
import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import {
  allocateByBasis,
  bookDistribution,
  createDistribution,
  distributableEquity,
  payDistribution,
} from '../distributions'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
const client = supabase as unknown as Parameters<typeof createDistribution>[0]

const PERIOD = 'p1'
const tb = (rows: Array<[string, number, number]>) => ({
  rows: rows.map(([account_number, closing_debit, closing_credit]) => ({
    account_number,
    account_name: account_number,
    account_class: Number(account_number[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit,
    closing_credit,
  })),
  totalDebit: 0,
  totalCredit: 0,
})

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  vi.mocked(listMembers).mockResolvedValue([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }] as never)
})

describe('allocateByBasis', () => {
  it('spreads in öre and puts the rounding residual on the largest basis', () => {
    // 100 kr over three equal shares: 33,33 + 33,33 + 33,33 = 99,99; the öre
    // lands on the first (largest, tie broken toward the earlier line).
    const plan = allocateByBasis(100, [
      { member_id: 'm1', basis_value: 1 },
      { member_id: 'm2', basis_value: 1 },
      { member_id: 'm3', basis_value: 1 },
    ])
    expect(plan.map((l) => l.amount)).toEqual([33.34, 33.33, 33.33])
    expect(plan.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(100, 2)
  })

  it('drops zero-basis members and refuses an empty basis', () => {
    const plan = allocateByBasis(500, [
      { member_id: 'm1', basis_value: 3000 },
      { member_id: 'm2', basis_value: 0 },
      { member_id: 'm3', basis_value: 1000 },
    ])
    expect(plan).toEqual([
      { member_id: 'm1', basis_value: 3000, amount: 375 },
      { member_id: 'm3', basis_value: 1000, amount: 125 },
    ])
    expect(() => allocateByBasis(500, [{ member_id: 'm2', basis_value: 0 }])).toThrow(
      expect.objectContaining({ code: 'ASSOCIATION_DISTRIBUTION_NO_BASIS' }),
    )
  })
})

describe('distributableEquity', () => {
  it('sums 2091/2098/2099 credit balances, ignores 2097, and subtracts earlier dividend decisions', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue(
      tb([
        ['2083', 0, 200_000],
        ['2091', 0, 10_000],
        ['2097', 0, 50_000],
        ['2098', 2_000, 0],
        ['2099', 0, 20_000],
      ]) as never,
    )
    enqueue({
      data: [
        { id: 'd0', kind: 'insats_dividend', total_amount: '5000.00', decision_date: '2026-05-01', created_at: 'a' },
        { id: 'd9', kind: 'cooperative_rebate', total_amount: '9000.00', decision_date: '2026-05-01', created_at: 'b' },
      ],
    })
    await expect(distributableEquity(client, 'company-1', PERIOD)).resolves.toBe(23_000)
  })
})

describe('createDistribution', () => {
  const decision = {
    kind: 'insats_dividend' as const,
    fiscal_period_id: PERIOD,
    decision_date: '2026-05-20',
    decided_by: 'stamma' as const,
    allocation_basis: 'contributions' as const,
    total_amount: 1000,
  }

  it('refuses a dividend above the free equity (beloppsspärren, EFL 12 kap. 2 §)', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue(tb([['2091', 0, 800]]) as never)
    enqueue({ data: [] })
    await expect(createDistribution(client, 'company-1', 'user-1', decision)).rejects.toMatchObject({
      code: 'ASSOCIATION_DISTRIBUTION_EXCEEDS_FREE_EQUITY',
    })
  })

  it('spreads an insats dividend on paid insatser (not förlagsinsatser) and stores the plan', async () => {
    vi.mocked(generateTrialBalance).mockResolvedValue(tb([['2091', 0, 5000]]) as never)
    enqueue({ data: [] }) // earlier decisions
    vi.mocked(listContributions).mockResolvedValue([
      { member_id: 'm1', kind: 'obligatory', status: 'paid', amount: '300.00' },
      { member_id: 'm1', kind: 'emission', status: 'paid', amount: '100.00' },
      { member_id: 'm2', kind: 'obligatory', status: 'paid', amount: '600.00' },
      { member_id: 'm2', kind: 'obligatory', status: 'repaid', amount: '900.00' },
      { member_id: 'm3', kind: 'forlags', status: 'paid', amount: '10000.00' },
    ] as never)
    enqueue({ data: { id: 'd1', ...decision, status: 'decided', total_amount: '1000.00' } })
    enqueue({ data: [{ id: 'a1' }, { id: 'a2' }] })
    const result = await createDistribution(client, 'company-1', 'user-1', decision)
    expect(result.id).toBe('d1')
    const inserted = findCall('association_distribution_allocations', 'insert')?.[0] as Array<{
      member_id: string
      basis_value: number
      amount: number
    }>
    expect(inserted).toEqual([
      expect.objectContaining({ member_id: 'm1', basis_value: 400, amount: 400 }),
      expect.objectContaining({ member_id: 'm2', basis_value: 600, amount: 600 }),
    ])
  })

  it('uses the caller-supplied basis for a rebate and skips the equity check', async () => {
    enqueue({ data: { id: 'd2', kind: 'cooperative_rebate', status: 'decided', total_amount: '1000.00' } })
    enqueue({ data: [] })
    await createDistribution(client, 'company-1', 'user-1', {
      ...decision,
      kind: 'cooperative_rebate',
      allocation_basis: 'turnover',
      allocations: [
        { member_id: 'm1', basis_value: 75_000 },
        { member_id: 'm2', basis_value: 25_000 },
      ],
    })
    expect(generateTrialBalance).not.toHaveBeenCalled()
    const inserted = findCall('association_distribution_allocations', 'insert')?.[0] as Array<{ amount: number }>
    expect(inserted.map((l) => l.amount)).toEqual([750, 250])
  })

  it('refuses a basis line for a member outside the register', async () => {
    await expect(
      createDistribution(client, 'company-1', 'user-1', {
        ...decision,
        kind: 'cooperative_rebate',
        allocation_basis: 'custom',
        allocations: [{ member_id: 'nobody', basis_value: 1 }],
      }),
    ).rejects.toMatchObject({ code: 'ASSOCIATION_MEMBER_NOT_FOUND' })
  })
})

describe('bookDistribution and payDistribution', () => {
  const row = {
    id: 'd1',
    company_id: 'company-1',
    kind: 'cooperative_rebate',
    fiscal_period_id: PERIOD,
    decision_date: '2026-05-20',
    decided_by: 'board',
    decision_reference: 'Styrelsemöte § 4',
    allocation_basis: 'turnover',
    total_amount: '1000.00',
    status: 'decided',
    journal_entry_id: null,
    payment_journal_entry_id: null,
    notes: null,
    created_at: 'a',
    updated_at: 'a',
  }

  it('books a gottgörelse Dr 8840 / Cr 2890 through the engine once the allocations match', async () => {
    enqueue({ data: row })
    enqueue({ data: [{ id: 'a1', amount: '600.00' }, { id: 'a2', amount: '400.00' }] })
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je1' } as never)
    enqueue({ data: { ...row, status: 'booked', journal_entry_id: 'je1' } })
    const booked = await bookDistribution(client, 'company-1', 'user-1', 'd1', {})
    expect(booked.status).toBe('booked')
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        fiscal_period_id: PERIOD,
        entry_date: '2026-05-20',
        source_id: 'd1',
        lines: [
          { account_number: '8840', debit_amount: 1000, credit_amount: 0 },
          { account_number: '2890', debit_amount: 0, credit_amount: 1000 },
        ],
      }),
    )
  })

  it('refuses to book when the allocations do not add up, and refuses a second booking', async () => {
    enqueue({ data: row })
    enqueue({ data: [{ id: 'a1', amount: '600.00' }] })
    await expect(bookDistribution(client, 'company-1', 'user-1', 'd1', {})).rejects.toMatchObject({
      code: 'ASSOCIATION_DISTRIBUTION_ALLOCATIONS_MISMATCH',
    })
    expect(createJournalEntry).not.toHaveBeenCalled()
    enqueue({ data: { ...row, status: 'booked', journal_entry_id: 'je1' } })
    await expect(bookDistribution(client, 'company-1', 'user-1', 'd1', {})).rejects.toMatchObject({
      code: 'ASSOCIATION_DISTRIBUTION_ALREADY_BOOKED',
    })
  })

  it('pays a dividend Dr 2898 / Cr bank in the period covering the payment date', async () => {
    const dividend = { ...row, kind: 'insats_dividend', status: 'booked', journal_entry_id: 'je1' }
    enqueue({ data: dividend })
    vi.mocked(findFiscalPeriod).mockResolvedValue('p2')
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je2' } as never)
    enqueue({ data: { ...dividend, status: 'paid', payment_journal_entry_id: 'je2' } })
    const paid = await payDistribution(client, 'company-1', 'user-1', 'd1', { paid_on: '2027-01-15', bank_account: '1930' })
    expect(paid.status).toBe('paid')
    expect(findFiscalPeriod).toHaveBeenCalledWith(expect.anything(), 'company-1', '2027-01-15')
    expect(createJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        fiscal_period_id: 'p2',
        lines: [
          { account_number: '2898', debit_amount: 1000, credit_amount: 0 },
          { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
        ],
      }),
    )
  })

  it('refuses a payment before booking, after paying, and without an open period', async () => {
    enqueue({ data: row })
    await expect(payDistribution(client, 'company-1', 'user-1', 'd1', { paid_on: '2026-06-01', bank_account: '1930' })).rejects.toMatchObject({
      code: 'ASSOCIATION_DISTRIBUTION_NOT_BOOKED',
    })
    enqueue({ data: { ...row, status: 'paid', journal_entry_id: 'je1', payment_journal_entry_id: 'je2' } })
    await expect(payDistribution(client, 'company-1', 'user-1', 'd1', { paid_on: '2026-06-01', bank_account: '1930' })).rejects.toMatchObject({
      code: 'ASSOCIATION_DISTRIBUTION_ALREADY_PAID',
    })
    enqueue({ data: { ...row, status: 'booked', journal_entry_id: 'je1' } })
    vi.mocked(findFiscalPeriod).mockResolvedValue(null)
    await expect(payDistribution(client, 'company-1', 'user-1', 'd1', { paid_on: '2030-06-01', bank_account: '1930' })).rejects.toMatchObject({
      code: 'ASSOCIATION_DISTRIBUTION_NO_OPEN_PERIOD',
    })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })
})
