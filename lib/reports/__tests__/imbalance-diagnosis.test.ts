import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

import { findUntransferredResults, buildImbalanceDiagnosis } from '../imbalance-diagnosis'
import { generateTrialBalance } from '../trial-balance'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { TrialBalanceRow, UntransferredResult } from '@/types'

const mockTrialBalance = vi.mocked(generateTrialBalance)

beforeEach(() => {
  vi.clearAllMocks()
})

function makeRow(overrides: Partial<TrialBalanceRow>): TrialBalanceRow {
  return {
    account_number: '1930',
    account_name: 'Bank',
    account_class: 1,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...overrides,
  }
}

function tb(rows: TrialBalanceRow[]) {
  return { rows, totalDebit: 0, totalCredit: 0, isBalanced: true }
}

const PERIODS = [
  { id: 'p1', name: 'Räkenskapsår 2023/2024', period_start: '2023-03-01' },
  { id: 'p2', name: 'Räkenskapsår 2024/2025', period_start: '2024-03-01' },
  { id: 'p3', name: 'Räkenskapsår 2025/2026', period_start: '2025-03-01' },
]

describe('findUntransferredResults', () => {
  it('flags a non-latest year whose P&L does not net to zero', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: PERIODS })

    // p1: P&L nets to zero (result was transferred)
    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '3001', account_class: 3, closing_credit: 1000 }),
        makeRow({ account_number: '8999', account_class: 8, closing_debit: 1000 }),
      ])
    )
    // p2: 97 kr profit left on P&L accounts (omföring missing)
    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '3001', account_class: 3, closing_credit: 197 }),
        makeRow({ account_number: '5010', account_class: 5, closing_debit: 100 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findUntransferredResults(q.supabase as any, 'company-1')

    expect(mockTrialBalance).toHaveBeenCalledTimes(2)
    expect(result).toEqual([
      { fiscal_period_id: 'p2', period_name: 'Räkenskapsår 2024/2025', pl_net: 97 },
    ])
  })

  it('never flags the chronologically last period (running year)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: PERIODS })

    // Both candidates (p1, p2) net to zero; p3 is never checked even though
    // a running year always carries its result on class 3-8.
    mockTrialBalance.mockResolvedValue(tb([]))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findUntransferredResults(q.supabase as any, 'company-1')

    expect(result).toEqual([])
    expect(mockTrialBalance).toHaveBeenCalledTimes(2)
    const checkedPeriodIds = mockTrialBalance.mock.calls.map((c) => c[2])
    expect(checkedPeriodIds).toEqual(['p1', 'p2'])
  })

  it('respects the beforePeriodStart cutoff', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: PERIODS })

    mockTrialBalance.mockResolvedValue(tb([]))

    // Diagnosing p2 → only p1 can affect its opening balance.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await findUntransferredResults(q.supabase as any, 'company-1', {
      beforePeriodStart: '2024-03-01',
    })

    expect(mockTrialBalance).toHaveBeenCalledTimes(1)
    expect(mockTrialBalance.mock.calls[0][2]).toBe('p1')
  })

  it('ignores residuals below the öre tolerance', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [PERIODS[0], PERIODS[1]] })

    mockTrialBalance.mockResolvedValueOnce(
      tb([makeRow({ account_number: '3001', account_class: 3, closing_credit: 0.004 })])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findUntransferredResults(q.supabase as any, 'company-1')

    expect(result).toEqual([])
  })

  it('returns empty without checking anything when fewer than two periods exist', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [PERIODS[0]] })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findUntransferredResults(q.supabase as any, 'company-1')

    expect(result).toEqual([])
    expect(mockTrialBalance).not.toHaveBeenCalled()
  })

  it('only counts class 3-8 rows toward the residual', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [PERIODS[0], PERIODS[1]] })

    mockTrialBalance.mockResolvedValueOnce(
      tb([
        makeRow({ account_number: '1930', account_class: 1, closing_debit: 5000 }),
        makeRow({ account_number: '2440', account_class: 2, closing_credit: 5000 }),
        makeRow({ account_number: '3001', account_class: 3, closing_credit: 97 }),
      ])
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await findUntransferredResults(q.supabase as any, 'company-1')

    expect(result).toHaveLength(1)
    expect(result[0].pl_net).toBe(97)
  })
})

describe('buildImbalanceDiagnosis', () => {
  const culprit: UntransferredResult = {
    fiscal_period_id: 'p2',
    period_name: 'Räkenskapsår 2024/2025',
    pl_net: 97,
  }

  it('returns null when the differens is below one öre', () => {
    expect(buildImbalanceDiagnosis([culprit], 0.004)).toBeNull()
    expect(buildImbalanceDiagnosis([], 0)).toBeNull()
  })

  it('names the culprit year and amount in the single-year message', () => {
    const diagnosis = buildImbalanceDiagnosis([culprit], 97)

    expect(diagnosis).not.toBeNull()
    expect(diagnosis!.differens).toBe(97)
    expect(diagnosis!.untransferred_results).toEqual([culprit])
    expect(diagnosis!.message).toContain('Räkenskapsår 2024/2025')
    expect(diagnosis!.message).toContain('97,00')
    expect(diagnosis!.message).toContain('förts om till eget kapital')
    expect(diagnosis!.message).toContain('8999')
  })

  it('lists every culprit year in the multi-year message', () => {
    const other: UntransferredResult = {
      fiscal_period_id: 'p1',
      period_name: 'Räkenskapsår 2023/2024',
      pl_net: -50,
    }
    const diagnosis = buildImbalanceDiagnosis([other, culprit], 47)

    expect(diagnosis!.message).toContain('Räkenskapsår 2023/2024')
    expect(diagnosis!.message).toContain('Räkenskapsår 2024/2025')
    expect(diagnosis!.message).toContain('respektive år')
  })

  it('falls back to a generic message when no culprit was found', () => {
    const diagnosis = buildImbalanceDiagnosis([], 97)

    expect(diagnosis).not.toBeNull()
    expect(diagnosis!.untransferred_results).toEqual([])
    expect(diagnosis!.message).toContain('Ingen orsak kunde fastställas automatiskt')
  })
})
