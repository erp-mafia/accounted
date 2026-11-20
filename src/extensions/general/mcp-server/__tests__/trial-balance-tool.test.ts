/**
 * gnubok_get_trial_balance returns the saldobalans the shared generator
 * (lib/reports/trial-balance.ts) builds, as v1 /reports/trial-balance and the
 * dashboard show it: IB, period and UB per side for every account. The tool
 * used to net each account to one side and drop the IB, so the MCP
 * saldobalans disagreed with the other two doors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { tools } from '../server'

vi.mock('@/lib/reports/trial-balance', () => ({ generateTrialBalance: vi.fn() }))

const trialBalance = tools.find((t) => t.name === 'gnubok_get_trial_balance')!
const mockTrialBalance = vi.mocked(generateTrialBalance)

const PERIOD_ROW = { id: 'fp-1', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }

// Generator rows: 1930 opens at 100 000 kr and moves both ways, 2440 opens
// as a payable and is paid off, 3001 is a period-only credit.
const GENERATOR_ROWS = [
  {
    account_number: '1930', account_name: 'Företagskonto', account_class: 1,
    opening_debit: 100000, opening_credit: 0, period_debit: 25000, period_credit: 18000.1,
    closing_debit: 125000, closing_credit: 18000.1,
  },
  {
    account_number: '2440', account_name: 'Leverantörsskulder', account_class: 2,
    opening_debit: 0, opening_credit: 4000, period_debit: 4000, period_credit: 0,
    closing_debit: 4000, closing_credit: 4000,
  },
  {
    account_number: '3001', account_name: 'Försäljning 25 %', account_class: 3,
    opening_debit: 0, opening_credit: 0, period_debit: 0, period_credit: 6999.9,
    closing_debit: 0, closing_credit: 6999.9,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_get_trial_balance: the generator saldobalans', () => {
  it('returns every generator row with its IB, and balance = UB debit minus credit', async () => {
    mockTrialBalance.mockResolvedValueOnce({
      rows: GENERATOR_ROWS, totalDebit: 129000, totalCredit: 29000, isBalanced: false,
    } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })

    const result = (await trialBalance.execute(
      { period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never,
    )) as {
      rows: Array<Record<string, unknown>>
      total_debit: number
      total_credit: number
      is_balanced: boolean
      account_count: number
    }

    expect(result.rows).toEqual([
      { ...GENERATOR_ROWS[0], balance: 106999.9 },
      { ...GENERATOR_ROWS[1], balance: 0 },
      { ...GENERATOR_ROWS[2], balance: -6999.9 },
    ])
    // The generator's own totals and balance flag, not a door-local recount.
    expect(result.total_debit).toBe(129000)
    expect(result.total_credit).toBe(29000)
    expect(result.is_balanced).toBe(false)
    expect(result.account_count).toBe(3)
  })

  it('reads the saldobalans as posted, resultatavslut included', async () => {
    mockTrialBalance.mockResolvedValueOnce({ rows: [], totalDebit: 0, totalCredit: 0, isBalanced: true } as never)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: PERIOD_ROW, error: null })

    const result = (await trialBalance.execute(
      { period_id: 'fp-1' }, 'company-1', 'user-1', supabase as never,
    )) as { rows: unknown[]; is_balanced: boolean }

    expect(mockTrialBalance).toHaveBeenCalledWith(supabase, 'company-1', 'fp-1', { closingEntry: 'include' })
    expect(result).toMatchObject({ rows: [], is_balanced: true })
  })
})
