import { describe, it, expect, vi, beforeEach } from 'vitest'
import { validateBalance, getSwedishLocalDate, createDraftEntry, reverseEntry } from '../engine'
import {
  AccountsNotInChartError,
  BookkeepingDatabaseError,
  CannotReverseStornoError,
  getUnusedVoucherAllocation,
} from '../errors'
import type { CreateJournalEntryLineInput, JournalEntryStatus } from '@/types'

// Mock Supabase client for createDraftEntry/reverseEntry tests
function createMockChain(overrides: Record<string, unknown> = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: overrides.singleData ?? null, error: overrides.singleError ?? null }),
    eq: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  }
  return chain
}

// Mock event bus
vi.mock('@/lib/events', () => ({
  eventBus: { emit: vi.fn().mockResolvedValue([]) },
}))

// Mock the on-demand BAS backfill, default: nothing seedable. Individual
// tests override per scenario.
const mockBackfill = vi.fn().mockResolvedValue([])
vi.mock('@/lib/bookkeeping/account-backfill', () => ({
  backfillStandardBASAccounts: (...args: unknown[]) => mockBackfill(...args),
}))

describe('validateBalance', () => {
  it('balanced entry (debit == credit) → valid: true', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(true)
    expect(result.totalDebit).toBe(1000)
    expect(result.totalCredit).toBe(1000)
  })

  it('unbalanced entry → valid: false', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 500 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(false)
    expect(result.totalDebit).toBe(1000)
    expect(result.totalCredit).toBe(500)
  })

  it('zero amounts → valid: false (roundedDebit must be > 0)', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 0, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 0 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(false)
    expect(result.totalDebit).toBe(0)
    expect(result.totalCredit).toBe(0)
  })

  it('floating point edge case (33.33 + 33.33 + 33.34) → valid: true', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 33.33, credit_amount: 0 },
      { account_number: '1930', debit_amount: 33.33, credit_amount: 0 },
      { account_number: '1930', debit_amount: 33.34, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 100 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(true)
    expect(result.totalDebit).toBe(100)
    expect(result.totalCredit).toBe(100)
  })

  it('single line (only debit, no credit) → valid: false', () => {
    const lines: CreateJournalEntryLineInput[] = [
      { account_number: '1930', debit_amount: 500, credit_amount: 0 },
    ]

    const result = validateBalance(lines)
    expect(result.valid).toBe(false)
  })
})

describe('getSwedishLocalDate', () => {
  it('returns a date string in YYYY-MM-DD format', () => {
    const date = getSwedishLocalDate()
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns a valid date', () => {
    const date = getSwedishLocalDate()
    const parsed = new Date(date)
    expect(parsed.toString()).not.toBe('Invalid Date')
  })
})

describe('createDraftEntry: cancelled status on line-insert failure', () => {
  it('sets status to cancelled (not delete) when line insert fails', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) })

    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { name: 'FY 2024', period_start: '2024-01-01', period_end: '2024-12-31' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', user_id: 'user-1', status: 'draft' as JournalEntryStatus },
                  error: null,
                }),
              }),
            }),
            update: updateMock,
            delete: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }),
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: { message: 'Line insert failed' } }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [{ account_number: '1930', id: 'acc-1' }, { account_number: '3001', id: 'acc-2' }],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        return createMockChain()
      }),
    }

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2024-01-01',
        description: 'Test',
        source_type: 'manual',
        lines: [
          { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
          { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
        ],
      })
    ).rejects.toThrow(BookkeepingDatabaseError)

    // Should call update with cancelled status, NOT delete
    expect(updateMock).toHaveBeenCalledWith({ status: 'cancelled' })
  })
})

describe('createDraftEntry: date/period cross-validation', () => {
  function buildSupabase(periodData: { name: string; period_start: string; period_end: string } | null) {
    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: periodData,
                    error: periodData ? null : { message: 'Not found' },
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({
                    data: [{ account_number: '1930', id: 'acc-1' }, { account_number: '3001', id: 'acc-2' }],
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', status: 'draft' },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', status: 'draft', lines: [] },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entry_lines') {
          return {
            insert: vi.fn().mockResolvedValue({ error: null }),
          }
        }
        return createMockChain()
      }),
    }
  }

  const validLines = [
    { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
    { account_number: '3001', debit_amount: 0, credit_amount: 1000 },
  ]

  it('rejects entry date before period start', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2024-12-15',
        description: 'Test',
        source_type: 'manual',
        lines: validLines,
      })
    ).rejects.toThrow('Entry date 2024-12-15 is outside fiscal period "FY 2025"')
  })

  it('rejects entry date after period end', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2026-01-15',
        description: 'Test',
        source_type: 'manual',
        lines: validLines,
      })
    ).rejects.toThrow('Entry date 2026-01-15 is outside fiscal period "FY 2025"')
  })

  it('accepts entry date within period', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    const result = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2025-06-15',
      description: 'Test',
      source_type: 'manual',
      lines: validLines,
    })

    expect(result).toBeDefined()
    expect(result.id).toBe('entry-1')
  })

  it('accepts entry date on period start boundary', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    const result = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2025-01-01',
      description: 'Test',
      source_type: 'manual',
      lines: validLines,
    })

    expect(result).toBeDefined()
  })

  it('accepts entry date on period end boundary', async () => {
    const supabase = buildSupabase({
      name: 'FY 2025',
      period_start: '2025-01-01',
      period_end: '2025-12-31',
    })

    const result = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2025-12-31',
      description: 'Test',
      source_type: 'manual',
      lines: validLines,
    })

    expect(result).toBeDefined()
  })

  it('throws when fiscal period not found', async () => {
    const supabase = buildSupabase(null)

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'nonexistent',
        entry_date: '2025-06-15',
        description: 'Test',
        source_type: 'manual',
        lines: validLines,
      })
    ).rejects.toThrow('Fiscal period not found')
  })
})

describe('JournalEntryStatus type includes cancelled', () => {
  it('cancelled is a valid JournalEntryStatus value', () => {
    const status: JournalEntryStatus = 'cancelled'
    expect(['draft', 'posted', 'reversed', 'cancelled']).toContain(status)
  })
})

describe('createDraftEntry: on-demand BAS account backfill', () => {
  // Engine seeds standard BAS accounts missing from the chart instead of
  // failing (June 2026 incident: 3740 öresavrundning missing → payment
  // voucher dead end). Non-seedable numbers still throw.

  beforeEach(() => {
    mockBackfill.mockClear()
  })

  function buildSupabase(opts: { chartByCall: { account_number: string; id: string }[][] }) {
    let chartCall = 0
    return {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'fiscal_periods') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                  single: vi.fn().mockResolvedValue({
                    data: { name: 'FY 2026', period_start: '2026-01-01', period_end: '2026-12-31' },
                    error: null,
                  }),
                }),
              }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          const result = opts.chartByCall[Math.min(chartCall++, opts.chartByCall.length - 1)]
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                in: vi.fn().mockReturnValue({
                  eq: vi.fn().mockResolvedValue({ data: result, error: null }),
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entries') {
          return {
            insert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', status: 'draft' },
                  error: null,
                }),
              }),
            }),
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({
                  data: { id: 'entry-1', status: 'draft', lines: [] },
                  error: null,
                }),
              }),
            }),
          }
        }
        if (table === 'journal_entry_lines') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) }
        }
        return createMockChain()
      }),
    }
  }

  const LINES: CreateJournalEntryLineInput[] = [
    { account_number: '2440', debit_amount: 11231.25, credit_amount: 0 },
    { account_number: '1930', debit_amount: 0, credit_amount: 11231 },
    { account_number: '3740', debit_amount: 0, credit_amount: 0.25 },
  ]

  it('seeds a missing standard BAS account and proceeds', async () => {
    mockBackfill.mockResolvedValue(['3740'])
    const supabase = buildSupabase({
      chartByCall: [
        // First resolution: 3740 missing
        [{ account_number: '2440', id: 'acc-1' }, { account_number: '1930', id: 'acc-2' }],
        // Re-resolution after backfill: all present
        [
          { account_number: '2440', id: 'acc-1' },
          { account_number: '1930', id: 'acc-2' },
          { account_number: '3740', id: 'acc-3' },
        ],
      ],
    })

    const entry = await createDraftEntry(supabase as never, 'company-1', 'user-1', {
      fiscal_period_id: 'period-1',
      entry_date: '2026-06-08',
      description: 'Utbetalning leverantörsfaktura',
      source_type: 'supplier_invoice_paid',
      lines: LINES,
    })

    expect(entry.id).toBe('entry-1')
    expect(mockBackfill).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', ['3740'])
  })

  it('still throws AccountsNotInChartError when the account is not seedable', async () => {
    mockBackfill.mockResolvedValue([])
    const supabase = buildSupabase({
      chartByCall: [
        [{ account_number: '2440', id: 'acc-1' }, { account_number: '1930', id: 'acc-2' }],
      ],
    })

    await expect(
      createDraftEntry(supabase as never, 'company-1', 'user-1', {
        fiscal_period_id: 'period-1',
        entry_date: '2026-06-08',
        description: 'Utbetalning leverantörsfaktura',
        source_type: 'supplier_invoice_paid',
        lines: LINES,
      })
    ).rejects.toThrow(AccountsNotInChartError)

    expect(mockBackfill).toHaveBeenCalledTimes(1)
  })
})

describe('reverseEntry: entry_date defaults to original entry date', () => {
  it('uses original entry_date when no reversalDate is provided', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: null, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]

    let insertedEntryDate: string | undefined
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update']) b[m] = vi.fn().mockReturnValue(b)
      b.insert = vi.fn().mockImplementation((payload: unknown) => {
        const p = payload as Record<string, unknown>
        if (p.entry_date !== undefined) insertedEntryDate = p.entry_date as string
        return b
      })
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [{ id: 'acc-5010', account_number: '5010' }, { id: 'acc-1930', account_number: '1930' }], error: null })
          return b
        }
        if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
        return createMockChain()
      }),
    }

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(insertedEntryDate).toBe('2024-11-15')
  })

  it('uses explicit reversalDate when provided', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: null, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]

    let insertedEntryDate: string | undefined
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update']) b[m] = vi.fn().mockReturnValue(b)
      b.insert = vi.fn().mockImplementation((payload: unknown) => {
        const p = payload as Record<string, unknown>
        if (p.entry_date !== undefined) insertedEntryDate = p.entry_date as string
        return b
      })
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [{ id: 'acc-5010', account_number: '5010' }, { id: 'acc-1930', account_number: '1930' }], error: null })
          return b
        }
        if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
        return createMockChain()
      }),
    }

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1', '2025-01-01')

    expect(insertedEntryDate).toBe('2025-01-01')
  })
})

describe('reverseEntry: unused voucher allocation', () => {
  it('exposes the exact allocated number when account resolution fails before the reversal insert', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'B',
      voucher_number: 41,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 42, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') {
          const chain = createMockChain({ singleData: original })
          return chain
        }
        if (table === 'chart_of_accounts') {
          const chain: Record<string, unknown> = {}
          for (const method of ['select', 'eq', 'in']) {
            chain[method] = vi.fn().mockReturnValue(chain)
          }
          chain.then = (resolve: (value: unknown) => void) =>
            resolve({ data: null, error: { message: 'account lookup failed' } })
          return chain
        }
        return createMockChain()
      }),
    }

    let caught: unknown
    try {
      await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(BookkeepingDatabaseError)
    expect(getUnusedVoucherAllocation(caught)).toEqual({
      fiscalPeriodId: 'period-1',
      voucherSeries: 'B',
      voucherNumber: 42,
    })
  })

  it('does not label a preserved cancelled reversal header as an unused voucher', async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'B',
      voucher_number: 41,
      entry_date: '2024-11-15',
      description: 'Hyra november',
      source_type: 'manual',
      source_id: null,
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }
    const cancelUpdate = vi.fn()
    const deleteLines = vi.fn()
    let journalEntryCall = 0
    let journalLineCall = 0

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 42, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') {
          journalEntryCall += 1
          if (journalEntryCall === 1) return createMockChain({ singleData: original })
          if (journalEntryCall === 2) return createMockChain({ singleData: reversal })
          return {
            update: cancelUpdate.mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }
        }
        if (table === 'chart_of_accounts') {
          const chain: Record<string, unknown> = {}
          for (const method of ['select', 'eq', 'in']) {
            chain[method] = vi.fn().mockReturnValue(chain)
          }
          chain.then = (resolve: (value: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-5010', account_number: '5010' },
                { id: 'acc-1930', account_number: '1930' },
              ],
              error: null,
            })
          return chain
        }
        if (table === 'journal_entry_lines') {
          journalLineCall += 1
          if (journalLineCall === 1) {
            return {
              insert: vi.fn().mockResolvedValue({ error: { message: 'line insert failed' } }),
            }
          }
          return {
            delete: deleteLines.mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: null, error: null }),
            }),
          }
        }
        return createMockChain()
      }),
    }

    let caught: unknown
    try {
      await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(BookkeepingDatabaseError)
    expect(getUnusedVoucherAllocation(caught)).toBeNull()
    expect(cancelUpdate).toHaveBeenCalledWith({ status: 'cancelled' })
    expect(deleteLines).toHaveBeenCalled()
  })
})

describe('reverseEntry: storno guard', () => {
  // BFL 5 kap 5§: a storno-of-a-storno makes the original verifikat's
  // cancellation chain ambiguous, so stornos are never reversible. A
  // correction entry, by contrast, is a regular live verifikation (it can be
  // a duplicate of an affärshändelse booked by another verifikat) and must
  // stay reversible: the guard covers 'storno' only.
  function supabaseReturningOriginal(original: Record<string, unknown>) {
    return {
      rpc: vi.fn(),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in', 'update', 'insert']) b[m] = vi.fn().mockReturnValue(b)
          b.single = vi.fn().mockResolvedValue({ data: original, error: null })
          return b
        }
        return createMockChain()
      }),
    }
  }

  it(`throws CannotReverseStornoError for source_type 'storno'`, async () => {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Makulering: Hyra november',
      source_type: 'storno',
      source_id: null,
      lines: [
        { account_number: '1930', debit_amount: 10000, credit_amount: 0 },
        { account_number: '5010', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const supabase = supabaseReturningOriginal(original)

    await expect(
      reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1'),
    ).rejects.toBeInstanceOf(CannotReverseStornoError)

    // No reversal was written: the guard fires before any voucher number is drawn.
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it(`reverses a correction entry like any regular verifikat`, async () => {
    // A rättelseverifikation that turned out to duplicate another booking
    // (support case 2026-07-26) is nullified with a normal storno; the
    // correction_of_id link keeps the chain traceable.
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 3,
      entry_date: '2024-11-15',
      description: 'Rättelse: Hyra november',
      source_type: 'correction',
      source_id: null,
      correction_of_id: 'entry-0',
      lines: [
        { account_number: '5010', debit_amount: 10000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 0, credit_amount: 10000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      // Chain-depth walker: follows correction_of_id to the chain root
      // (depth 1, well under the guard threshold).
      { data: { id: 'entry-0', correction_of_id: null, reverses_id: null, voucher_series: 'A', voucher_number: 1 }, error: null },
      { data: reversal, error: null },
      { data: null, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]

    let insertedEntry: Record<string, unknown> | undefined
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update']) b[m] = vi.fn().mockReturnValue(b)
      b.insert = vi.fn().mockImplementation((payload: unknown) => {
        insertedEntry = payload as Record<string, unknown>
        return b
      })
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 4, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({ data: [{ id: 'acc-5010', account_number: '5010' }, { id: 'acc-1930', account_number: '1930' }], error: null })
          return b
        }
        if (table === 'journal_entry_lines') return { insert: vi.fn().mockResolvedValue({ error: null }) }
        return createMockChain()
      }),
    }

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(insertedEntry).toBeDefined()
    expect(insertedEntry!.source_type).toBe('storno')
    expect(insertedEntry!.reverses_id).toBe('entry-1')
    expect(insertedEntry!.description).toBe('Makulering: Rättelse: Hyra november')
  })
})

describe('reverseEntry: bank transaction unlink', () => {
  // After a reversal the booked bank transaction must return to "Att bokföra"
  // so the user can book it again. The agent paths in
  // lib/pending-operations/commit.ts did this manually; the engine now owns
  // it so the dashboard reverse route behaves the same.
  //
  // "Att bokföra" is is_business IS NULL AND is_ignored = false
  // (lib/worklist/types.ts), not journal_entry_id IS NULL: bulk-booked and
  // multi-allocated rows keep journal_entry_id NULL while booked. Clearing
  // only the link therefore left the stornoed row out of the list and the nav
  // badge (#1950), so the engine resets the same triple the uncategorize
  // paths write, plus reconciliation_method since the link it described is gone.
  //
  // Second anchor: bulk-booked rows (bulk_book_transactions RPC) point at the
  // verifikat through transaction_voucher_links, and for N>1 that junction is
  // the only anchor. The engine deletes those link rows and releases the rows
  // that have no anchor left; a row still anchored elsewhere (residual booking:
  // main verifikat in journal_entry_id, junction row to the residual verifikat)
  // stays booked.
  const original = {
    id: 'entry-1',
    company_id: 'company-1',
    status: 'posted',
    fiscal_period_id: 'period-1',
    voucher_series: 'A',
    voucher_number: 7,
    entry_date: '2026-02-02',
    description: 'ALMI AB - Innovationslån',
    source_type: 'manual',
    source_id: null,
    lines: [
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '2350', debit_amount: 0, credit_amount: 1000 },
    ],
  }
  const reversal = { id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }

  type Filter = [op: string, column: string, value: unknown]
  interface RecordedWrite { payload?: unknown; op?: string; filters: Filter[] }

  type RemainingRow = { transaction_id: string; role?: string; allocated_amount?: number }
  type TxRow = { id: string; amount: number; journal_entry_id: string | null }

  /**
   * Mock for reverseEntry. `voucherLinks` are the transaction ids the junction
   * holds for entry-1; `remainingLinks` what it still holds for those ids after
   * the delete (a row anchored to some other verifikat too), as ids (one
   * bank_line row each, no amount) or as full rows. `txRows` is what the
   * partial-split read returns for the rows that still have anchors.
   * `pointerRows` are the ids whose journal_entry_id column points at entry-1
   * (the read that precedes the pointer reset).
   */
  function setup(
    opts: {
      voucherLinks?: string[]
      remainingLinks?: Array<string | RemainingRow>
      txRows?: TxRow[]
      pointerRows?: string[]
    } = {},
  ) {
    let jeCall = 0
    const jeResults = [
      { data: original, error: null },                   // fetch original (.single)
      { data: reversal, error: null },                   // insert reversal (.single)
      { data: null, error: null },                       // post reversal (await)
      { data: [{ id: 'entry-1' }], error: null },        // CAS original → reversed (await)
      { data: { ...reversal, lines: [] }, error: null }, // fetch complete (.single)
    ]
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update', 'insert']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const txWrites: RecordedWrite[] = []
    const linkOps: RecordedWrite[] = []
    let linkSelectCall = 0

    function recorder(list: RecordedWrite[], resolveWith: (current: RecordedWrite) => unknown) {
      const b: Record<string, unknown> = {}
      let current: RecordedWrite = { filters: [] }
      const start = (op: string) =>
        vi.fn().mockImplementation((payload?: unknown) => {
          current = { op, payload, filters: [] }
          list.push(current)
          return b
        })
      const filter = (op: string) =>
        vi.fn().mockImplementation((column: string, value: unknown) => {
          current.filters.push([op, column, value])
          return b
        })
      b.update = start('update')
      b.select = start('select')
      b.delete = start('delete')
      b.eq = filter('eq')
      b.in = filter('in')
      b.is = filter('is')
      b.neq = filter('neq')
      b.then = (resolve: (v: unknown) => void) => resolve(resolveWith(current))
      return b
    }

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 8, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-1930', account_number: '1930' },
                { id: 'acc-2350', account_number: '2350' },
              ],
              error: null,
            })
          return b
        }
        if (table === 'journal_entry_lines') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) }
        }
        if (table === 'transactions') {
          return recorder(txWrites, (current) => {
            if (current.op !== 'select') return { error: null }
            if (current.payload === 'id') {
              return { data: (opts.pointerRows ?? []).map((id) => ({ id })), error: null }
            }
            return { data: opts.txRows ?? [], error: null }
          })
        }
        if (table === 'transaction_voucher_links') {
          return recorder(linkOps, (current) => {
            if (current.op !== 'select') return { error: null }
            if (linkSelectCall++ === 0) {
              return { data: (opts.voucherLinks ?? []).map((transaction_id) => ({ transaction_id })), error: null }
            }
            const rows = (opts.remainingLinks ?? []).map((r) =>
              typeof r === 'string' ? { transaction_id: r, role: 'bank_line', allocated_amount: 0 } : r,
            )
            return { data: rows, error: null }
          })
        }
        return createMockChain()
      }),
    }

    return { supabase, txWrites, linkOps }
  }

  it('resets journal_entry_id, is_business and category so the row returns to Att bokföra (#1950)', async () => {
    const { supabase, txWrites, linkOps } = setup()

    const result = await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(result.id).toBe('reversal-1')
    // [0] the read of the rows the reset is about to release, [1] the reset.
    expect(txWrites).toHaveLength(2)
    expect(txWrites[0]).toEqual({
      op: 'select',
      payload: 'id',
      filters: [
        ['eq', 'company_id', 'company-1'],
        ['eq', 'journal_entry_id', 'entry-1'],
      ],
    })
    expect(txWrites[1].payload).toEqual({
      journal_entry_id: null,
      is_business: null,
      category: null,
      reconciliation_method: null,
    })
    // Scoped to rows linked to the reversed entry only: never a company-wide reset.
    expect(txWrites[1].filters).toEqual([
      ['eq', 'company_id', 'company-1'],
      ['eq', 'journal_entry_id', 'entry-1'],
    ])
    // The junction is consulted for this entry only; nothing to delete or
    // release when it holds no rows.
    expect(linkOps).toEqual([
      {
        op: 'select',
        payload: 'transaction_id',
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['eq', 'journal_entry_id', 'entry-1'],
        ],
      },
    ])
  })

  it('deletes transaction_voucher_links rows and releases bulk-booked rows with no anchor left', async () => {
    // Samlingsverifikat over three bank rows (journal_entry_id NULL on all
    // three, one junction row each). tx-c is also anchored to another
    // verifikat through the junction and must stay booked.
    const { supabase, txWrites, linkOps } = setup({
      voucherLinks: ['tx-a', 'tx-b', 'tx-c'],
      remainingLinks: ['tx-c'],
    })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(linkOps).toEqual([
      {
        op: 'select',
        payload: 'transaction_id',
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['eq', 'journal_entry_id', 'entry-1'],
        ],
      },
      {
        op: 'delete',
        payload: undefined,
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['eq', 'journal_entry_id', 'entry-1'],
        ],
      },
      {
        op: 'select',
        payload: 'transaction_id, role, allocated_amount',
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['in', 'transaction_id', ['tx-a', 'tx-b', 'tx-c']],
        ],
      },
    ])

    // [0] pointer read, [1] unlink, [2] the partial-split read for the row
    // still anchored (tx-c), [3] the release of the rows with no anchor left.
    expect(txWrites).toHaveLength(4)
    expect(txWrites[2]).toEqual({
      op: 'select',
      payload: 'id, amount, journal_entry_id',
      filters: [
        ['eq', 'company_id', 'company-1'],
        ['in', 'id', ['tx-c']],
      ],
    })
    expect(txWrites[3].payload).toEqual({ is_business: null, category: null, reconciliation_method: null })
    // Only rows with no anchor left, and never a row whose journal_entry_id
    // still points at another verifikat (residual booking).
    expect(txWrites[3].filters).toEqual([
      ['eq', 'company_id', 'company-1'],
      ['in', 'id', ['tx-a', 'tx-b']],
      ['is', 'journal_entry_id', null],
    ])
  })

  it('leaves the rows alone when every junction-linked row is still anchored elsewhere', async () => {
    const { supabase, txWrites, linkOps } = setup({
      voucherLinks: ['tx-a'],
      remainingLinks: ['tx-a'],
    })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(linkOps.map((o) => o.op)).toEqual(['select', 'delete', 'select'])
    // The pointer read, the unlink, the partial-split read; no release.
    expect(txWrites.map((w) => w.op)).toEqual(['select', 'update', 'select'])
  })

  it('releases a 1:N split whole when one of its verifikat is reversed (#1553): surviving slices dropped', async () => {
    // tx-s (amount -800) was split over entry-1 (-500) and entry-2 (-300).
    // Reversing entry-1 leaves a -300 bank_line slice that no longer explains
    // the row: the slice goes, and the row returns to Att bokföra.
    const { supabase, txWrites, linkOps } = setup({
      voucherLinks: ['tx-s'],
      remainingLinks: [{ transaction_id: 'tx-s', role: 'bank_line', allocated_amount: -300 }],
      txRows: [{ id: 'tx-s', amount: -800, journal_entry_id: null }],
    })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(linkOps.map((o) => o.op)).toEqual(['select', 'delete', 'select', 'delete'])
    expect(linkOps[3].filters).toEqual([
      ['eq', 'company_id', 'company-1'],
      ['in', 'transaction_id', ['tx-s']],
    ])
    const release = txWrites[txWrites.length - 1]
    expect(release.op).toBe('update')
    expect(release.payload).toEqual({ is_business: null, category: null, reconciliation_method: null })
    expect(release.filters).toEqual([
      ['eq', 'company_id', 'company-1'],
      ['in', 'id', ['tx-s']],
      ['is', 'journal_entry_id', null],
    ])
  })

  it('keeps a row whose surviving slices still sum to its amount, or that carries a non-bank_line anchor', async () => {
    // tx-full: a bulk-booked-style anchor on another verifikat covering the
    // whole amount. tx-res: a residual booking's 'other' row whose main
    // verifikat pointer is already null (a row left behind before the main
    // storno started dropping such links, #2061); the residual row is not a
    // slice and the partial-split judgement never touches it.
    const { supabase, txWrites, linkOps } = setup({
      voucherLinks: ['tx-full', 'tx-res'],
      remainingLinks: [
        { transaction_id: 'tx-full', role: 'bank_line', allocated_amount: -800 },
        { transaction_id: 'tx-res', role: 'other', allocated_amount: -10 },
      ],
      txRows: [
        { id: 'tx-full', amount: -800, journal_entry_id: null },
        { id: 'tx-res', amount: -1010, journal_entry_id: null },
      ],
    })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(linkOps.map((o) => o.op)).toEqual(['select', 'delete', 'select'])
    expect(txWrites.map((w) => w.op)).toEqual(['select', 'update', 'select'])
  })

  it('drops the supplementary junction links of a row whose main verifikat is reversed (#2061)', async () => {
    // Residual booking: tx-r points at entry-1 (the main verifikat) and one
    // junction row of role 'other' anchors the small residual verifikat.
    // Reversing entry-1 releases tx-r whole: the pointer reset takes the
    // 'other' row with it, so no reader (unmatched list, bulk_book RPC,
    // is_transaction_booked) keeps calling the row booked.
    const { supabase, txWrites, linkOps } = setup({ pointerRows: ['tx-r'] })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(txWrites.map((w) => w.op)).toEqual(['select', 'update'])
    expect(linkOps).toEqual([
      {
        op: 'delete',
        payload: undefined,
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['in', 'transaction_id', ['tx-r']],
          // Links to the reversed entry itself belong to the junction cleanup.
          ['neq', 'journal_entry_id', 'entry-1'],
        ],
      },
      {
        op: 'select',
        payload: 'transaction_id',
        filters: [
          ['eq', 'company_id', 'company-1'],
          ['eq', 'journal_entry_id', 'entry-1'],
        ],
      },
    ])
  })

  it('does not touch the junction when no row pointed at the reversed entry', async () => {
    const { supabase, linkOps } = setup({ pointerRows: [] })

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(linkOps.map((o) => o.op)).toEqual(['select'])
  })
})

describe('reverseEntry: opening balance unlink', () => {
  // Reversing a period's IB verifikat must also drop the period's pointer to
  // it. getOpeningBalances() reads the linked entry's lines with no status
  // filter, so a still-linked cancelled IB keeps showing in the Balansrapport,
  // and year-end refuses to run while the pointer is non-null: the storno its
  // own error message asks for could never satisfy it. See engine.pg.test.ts
  // for why the flag must fall before the pointer.
  function buildSupabase(sourceType: string) {
    const original = {
      id: 'entry-1',
      company_id: 'company-1',
      status: 'posted',
      fiscal_period_id: 'period-1',
      voucher_series: 'A',
      voucher_number: 1,
      entry_date: '2026-01-01',
      description: 'Ingående balanser från SIE-import',
      source_type: sourceType,
      source_id: null,
      lines: [
        { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
        { account_number: '2350', debit_amount: 0, credit_amount: 1000 },
      ],
    }
    const reversal = { id: 'reversal-1', reverses_id: 'entry-1', source_type: 'storno' }

    let jeCall = 0
    const jeResults = [
      { data: original, error: null },
      { data: reversal, error: null },
      { data: null, error: null },
      { data: [{ id: 'entry-1' }], error: null },
      { data: { ...reversal, lines: [] }, error: null },
    ]
    function jeBuilder() {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'update', 'insert']) {
        b[m] = vi.fn().mockReturnValue(b)
      }
      b.single = vi.fn().mockImplementation(async () => jeResults[jeCall++])
      b.then = (resolve: (v: unknown) => void) => resolve(jeResults[jeCall++])
      return b
    }

    const fpUpdates: unknown[] = []
    const fpFilters: Record<string, unknown>[] = []

    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: 2, error: null }),
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'journal_entries') return jeBuilder()
        if (table === 'chart_of_accounts') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) =>
            resolve({
              data: [
                { id: 'acc-1930', account_number: '1930' },
                { id: 'acc-2350', account_number: '2350' },
              ],
              error: null,
            })
          return b
        }
        if (table === 'journal_entry_lines') {
          return { insert: vi.fn().mockResolvedValue({ error: null }) }
        }
        if (table === 'fiscal_periods') {
          const b: Record<string, unknown> = {}
          const filters: Record<string, unknown> = {}
          b.update = vi.fn().mockImplementation((payload: unknown) => {
            fpUpdates.push(payload)
            fpFilters.push(filters)
            return b
          })
          b.eq = vi.fn().mockImplementation((col: string, val: unknown) => {
            filters[col] = val
            return b
          })
          b.then = (resolve: (v: unknown) => void) => resolve({ error: null })
          return b
        }
        if (table === 'transactions') {
          const b: Record<string, unknown> = {}
          for (const m of ['select', 'update', 'eq']) b[m] = vi.fn().mockReturnValue(b)
          b.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
          return b
        }
        return createMockChain()
      }),
    }

    return { supabase, fpUpdates, fpFilters }
  }

  it('clears the period IB link, flag before pointer, for an opening_balance entry', async () => {
    const { supabase, fpUpdates, fpFilters } = buildSupabase('opening_balance')

    const result = await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(result.id).toBe('reversal-1')
    // Order matters: enforce_opening_balance_immutability rejects the pointer
    // write while opening_balances_set is still true.
    expect(fpUpdates).toEqual([{ opening_balances_set: false }, { opening_balance_entry_id: null }])
    // Scoped to this entry, so a period pointing elsewhere is untouched.
    for (const f of fpFilters) {
      expect(f).toMatchObject({ company_id: 'company-1', opening_balance_entry_id: 'entry-1' })
    }
  })

  it('leaves fiscal_periods untouched for a non-opening_balance entry', async () => {
    const { supabase, fpUpdates } = buildSupabase('manual')

    await reverseEntry(supabase as never, 'company-1', 'user-1', 'entry-1')

    expect(fpUpdates).toEqual([])
  })
})
