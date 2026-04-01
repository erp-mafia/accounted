import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================
// Mock Supabase — table-keyed result queues
// ============================================================

type MockResult = { data?: unknown; error?: unknown; count?: number }
let mockResults: Record<string, MockResult[]>

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'neq', 'range', 'update']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  const consume = (): MockResult => {
    const queue = mockResults[tableName]
    if (!queue || queue.length === 0) return { data: null, error: null }
    return queue.shift()!
  }
  b.single = vi.fn().mockImplementation(async () => consume())
  b.then = (resolve: (v: unknown) => void) => resolve(consume())
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { validateBalanceContinuity } from '../continuity-check'

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  mockResults = {}
  supabase = makeClient()
})

describe('validateBalanceContinuity', () => {
  it('returns valid for first period (no previous_period_id)', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { id: 'p1', name: 'FY2024', period_start: '2024-01-01', previous_period_id: null, opening_balance_entry_id: null } },
      ],
    }

    const result = await validateBalanceContinuity(supabase, 'company-1', 'p1')

    expect(result.valid).toBe(true)
    expect(result.discrepancies).toEqual([])
    expect(result.checked_accounts).toBe(0)
    expect(result.previous_period_name).toBeNull()
  })

  it('returns valid when IB matches UB', async () => {
    mockResults = {
      fiscal_periods: [
        // Target period
        { data: { id: 'p2', name: 'FY2025', period_start: '2025-01-01', previous_period_id: 'p1', opening_balance_entry_id: 'ob-1' } },
        // Previous period (for name)
        { data: { id: 'p1', name: 'FY2024' } },
        // Previous period (for generateTrialBalance)
        { data: { period_start: '2024-01-01', opening_balance_entry_id: null } },
      ],
      journal_entry_lines: [
        // Previous period OB (fallback — no OB entry)
        { data: [] },
        // Previous period lines (trial balance)
        {
          data: [
            { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
            { account_number: '2099', debit_amount: 0, credit_amount: 30000 },
            { account_number: '1510', debit_amount: 10000, credit_amount: 0 },
          ],
        },
        // Current period OB entry lines (getOpeningBalances)
        {
          data: [
            { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
            { account_number: '2099', debit_amount: 0, credit_amount: 30000 },
            { account_number: '1510', debit_amount: 10000, credit_amount: 0 },
          ],
        },
      ],
      chart_of_accounts: [
        {
          data: [
            { account_number: '1510', account_name: 'Kundfordringar', account_class: 1 },
            { account_number: '1930', account_name: 'Företagskonto', account_class: 1 },
            { account_number: '2099', account_name: 'Årets resultat', account_class: 2 },
          ],
        },
      ],
    }

    const result = await validateBalanceContinuity(supabase, 'company-1', 'p2')

    expect(result.valid).toBe(true)
    expect(result.discrepancies).toEqual([])
    expect(result.checked_accounts).toBe(3)
    expect(result.period_name).toBe('FY2025')
    expect(result.previous_period_name).toBe('FY2024')
  })

  it('detects discrepancy in one account', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { id: 'p2', name: 'FY2025', period_start: '2025-01-01', previous_period_id: 'p1', opening_balance_entry_id: 'ob-1' } },
        { data: { id: 'p1', name: 'FY2024' } },
        { data: { period_start: '2024-01-01', opening_balance_entry_id: null } },
      ],
      journal_entry_lines: [
        { data: [] },
        // Previous UB: 1930 = 50000 debit
        {
          data: [
            { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
            { account_number: '2099', debit_amount: 0, credit_amount: 50000 },
          ],
        },
        // Current IB: 1930 = 49000 debit (mismatch!)
        {
          data: [
            { account_number: '1930', debit_amount: 49000, credit_amount: 0 },
            { account_number: '2099', debit_amount: 0, credit_amount: 50000 },
          ],
        },
      ],
      chart_of_accounts: [
        {
          data: [
            { account_number: '1930', account_name: 'Företagskonto', account_class: 1 },
            { account_number: '2099', account_name: 'Årets resultat', account_class: 2 },
          ],
        },
      ],
    }

    const result = await validateBalanceContinuity(supabase, 'company-1', 'p2')

    expect(result.valid).toBe(false)
    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0].account_number).toBe('1930')
    expect(result.discrepancies[0].previous_ub_net).toBe(50000)
    expect(result.discrepancies[0].current_ib_net).toBe(49000)
    expect(result.discrepancies[0].difference).toBe(1000)
  })

  it('detects account present in UB but not IB', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { id: 'p2', name: 'FY2025', period_start: '2025-01-01', previous_period_id: 'p1', opening_balance_entry_id: 'ob-1' } },
        { data: { id: 'p1', name: 'FY2024' } },
        { data: { period_start: '2024-01-01', opening_balance_entry_id: null } },
      ],
      journal_entry_lines: [
        { data: [] },
        // Previous UB has 1510 and 2440
        {
          data: [
            { account_number: '1510', debit_amount: 10000, credit_amount: 0 },
            { account_number: '2440', debit_amount: 0, credit_amount: 10000 },
          ],
        },
        // Current IB only has 1510 (2440 missing)
        {
          data: [
            { account_number: '1510', debit_amount: 10000, credit_amount: 0 },
          ],
        },
      ],
      chart_of_accounts: [
        {
          data: [
            { account_number: '1510', account_name: 'Kundfordringar', account_class: 1 },
            { account_number: '2440', account_name: 'Leverantörsskulder', account_class: 2 },
          ],
        },
      ],
    }

    const result = await validateBalanceContinuity(supabase, 'company-1', 'p2')

    expect(result.valid).toBe(false)
    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0].account_number).toBe('2440')
    expect(result.discrepancies[0].previous_ub_net).toBe(-10000)
    expect(result.discrepancies[0].current_ib_net).toBe(0)
  })

  it('detects account present in IB but not UB', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { id: 'p2', name: 'FY2025', period_start: '2025-01-01', previous_period_id: 'p1', opening_balance_entry_id: 'ob-1' } },
        { data: { id: 'p1', name: 'FY2024' } },
        { data: { period_start: '2024-01-01', opening_balance_entry_id: null } },
      ],
      journal_entry_lines: [
        { data: [] },
        // Previous UB: only 1930
        {
          data: [
            { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
          ],
        },
        // Current IB: 1930 + 1510 (1510 shouldn't be here)
        {
          data: [
            { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
            { account_number: '1510', debit_amount: 5000, credit_amount: 0 },
          ],
        },
      ],
      chart_of_accounts: [
        {
          data: [
            { account_number: '1930', account_name: 'Företagskonto', account_class: 1 },
          ],
        },
      ],
    }

    const result = await validateBalanceContinuity(supabase, 'company-1', 'p2')

    expect(result.valid).toBe(false)
    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0].account_number).toBe('1510')
    expect(result.discrepancies[0].previous_ub_net).toBe(0)
    expect(result.discrepancies[0].current_ib_net).toBe(5000)
  })

  it('treats differences within 0.01 SEK tolerance as valid', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { id: 'p2', name: 'FY2025', period_start: '2025-01-01', previous_period_id: 'p1', opening_balance_entry_id: 'ob-1' } },
        { data: { id: 'p1', name: 'FY2024' } },
        { data: { period_start: '2024-01-01', opening_balance_entry_id: null } },
      ],
      journal_entry_lines: [
        { data: [] },
        {
          data: [
            { account_number: '1930', debit_amount: 50000.005, credit_amount: 0 },
          ],
        },
        {
          data: [
            { account_number: '1930', debit_amount: 50000, credit_amount: 0 },
          ],
        },
      ],
      chart_of_accounts: [
        {
          data: [
            { account_number: '1930', account_name: 'Företagskonto', account_class: 1 },
          ],
        },
      ],
    }

    const result = await validateBalanceContinuity(supabase, 'company-1', 'p2')

    expect(result.valid).toBe(true)
    expect(result.discrepancies).toEqual([])
  })

  it('throws when period not found', async () => {
    mockResults = {
      fiscal_periods: [
        { data: null, error: { message: 'not found' } },
      ],
    }

    await expect(
      validateBalanceContinuity(supabase, 'company-1', 'nonexistent')
    ).rejects.toThrow('Fiscal period not found')
  })

  it('throws when previous period not found', async () => {
    mockResults = {
      fiscal_periods: [
        { data: { id: 'p2', name: 'FY2025', period_start: '2025-01-01', previous_period_id: 'p1', opening_balance_entry_id: null } },
        { data: null, error: { message: 'not found' } },
      ],
    }

    await expect(
      validateBalanceContinuity(supabase, 'company-1', 'p2')
    ).rejects.toThrow('Previous fiscal period not found')
  })
})
