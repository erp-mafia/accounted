import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createTestLogger } from '@/lib/logger'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const mockCreateJournalEntry = vi.fn()
const mockReverseEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
  reverseEntry: (...args: unknown[]) => mockReverseEntry(...args),
}))

const mockFetchEntryLines = vi.fn()
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: (...args: unknown[]) => mockFetchEntryLines(...args),
}))

import {
  computeAccountDeltas,
  applyDeltasToLines,
  cascadeOpeningBalanceCorrection,
} from '../cascade'
import type { SupabaseClient } from '@supabase/supabase-js'

const D = (account_number: string, debit_amount: number) => ({
  account_number,
  debit_amount,
  credit_amount: 0,
})
const K = (account_number: string, credit_amount: number) => ({
  account_number,
  debit_amount: 0,
  credit_amount,
})

describe('computeAccountDeltas', () => {
  it('returns the per-account net change, omitting unchanged accounts', () => {
    const oldLines = [D('1930', 50000), K('2099', 50000)]
    const newLines = [D('1930', 40000), D('1630', 10000), K('2099', 50000)]

    const deltas = computeAccountDeltas(oldLines, newLines)

    expect(deltas.get('1930')).toBe(-10000)
    expect(deltas.get('1630')).toBe(10000)
    expect(deltas.has('2099')).toBe(false)
    expect(deltas.size).toBe(2)
  })

  it('handles accounts removed entirely from the corrected entry', () => {
    const oldLines = [D('1930', 30000), D('1630', 20000), K('2099', 50000)]
    const newLines = [D('1930', 50000), K('2099', 50000)]

    const deltas = computeAccountDeltas(oldLines, newLines)

    expect(deltas.get('1630')).toBe(-20000)
    expect(deltas.get('1930')).toBe(20000)
  })

  it('rounds öre correctly (no floating point drift)', () => {
    const oldLines = [D('1930', 100.1), K('2099', 100.1)]
    const newLines = [D('1930', 100.3), K('2099', 100.3)]

    const deltas = computeAccountDeltas(oldLines, newLines)

    expect(deltas.get('1930')).toBe(0.2)
    expect(deltas.get('2099')).toBe(-0.2)
  })
})

describe('applyDeltasToLines', () => {
  it('shifts nets, keeps balance, and sorts by account number', () => {
    const existing = [D('1930', 80000), K('2099', 80000)]
    const deltas = new Map([
      ['1930', -10000],
      ['1630', 10000],
    ])

    const result = applyDeltasToLines(existing, deltas)

    expect(result).toEqual([
      D('1630', 10000),
      D('1930', 70000),
      K('2099', 80000),
    ])
    const totalDebit = result.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = result.reduce((s, l) => s + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })

  it('flips a debit balance to credit when the delta crosses zero', () => {
    const existing = [D('1930', 5000), K('2099', 5000)]
    const deltas = new Map([
      ['1930', -8000],
      ['2099', 8000],
    ])

    const result = applyDeltasToLines(existing, deltas)

    expect(result).toEqual([K('1930', 3000), D('2099', 3000)])
  })

  it('drops accounts whose net becomes zero and adds accounts new to the period', () => {
    const existing = [D('1630', 10000), D('1930', 40000), K('2099', 50000)]
    const deltas = new Map([
      ['1630', -10000],
      ['1510', 10000],
    ])

    const result = applyDeltasToLines(existing, deltas)

    expect(result.find((l) => l.account_number === '1630')).toBeUndefined()
    expect(result.find((l) => l.account_number === '1510')).toEqual(D('1510', 10000))
  })
})

describe('cascadeOpeningBalanceCorrection', () => {
  const sink: Parameters<typeof createTestLogger>[1] = []
  const log = createTestLogger('cascade-test', sink)
  const supabase = mockSupabase as unknown as SupabaseClient
  const DELTAS = new Map([
    ['1930', -10000],
    ['1630', 10000],
  ])

  const periodRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'period-2020',
    name: '2020',
    period_start: '2020-01-01',
    is_closed: false,
    locked_at: null,
    opening_balance_entry_id: 'ib-2020',
    opening_balance_entry: { voucher_series: 'A', voucher_number: 4 },
    ...overrides,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    sink.length = 0
    mockFetchEntryLines.mockResolvedValue([
      { id: 'l1', account_number: '1930', debit_amount: 80000, credit_amount: 0 },
      { id: 'l2', account_number: '2099', debit_amount: 0, credit_amount: 80000 },
    ])
  })

  it('returns immediately without queries when there are no deltas', async () => {
    const result = await cascadeOpeningBalanceCorrection(supabase, 'company-1', 'user-1', {
      basePeriodStart: '2019-01-01',
      deltas: new Map(),
      lockDate: null,
      log,
    })

    expect(result).toEqual({ corrected: [], skipped: [] })
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('corrects an open later period and skips a closed one', async () => {
    enqueue({
      data: [
        periodRow(),
        periodRow({ id: 'period-2021', name: '2021', period_start: '2021-01-01', is_closed: true, opening_balance_entry_id: 'ib-2021' }),
      ],
    }) // subsequent periods
    enqueue({ count: 0 }) // year-end check for period-2020
    enqueue({ error: null }) // relink RPC for period-2020

    mockCreateJournalEntry.mockResolvedValue({ id: 'ib-2020-new' })
    mockReverseEntry.mockResolvedValue({ id: 'ib-2020-storno' })

    const result = await cascadeOpeningBalanceCorrection(supabase, 'company-1', 'user-1', {
      basePeriodStart: '2019-01-01',
      deltas: DELTAS,
      lockDate: null,
      log,
    })

    expect(result.corrected).toEqual([
      {
        fiscal_period_id: 'period-2020',
        period_name: '2020',
        journal_entry_id: 'ib-2020-new',
        reversed_entry_id: 'ib-2020',
      },
    ])
    expect(result.skipped).toEqual([
      { fiscal_period_id: 'period-2021', period_name: '2021', reason: 'closed' },
    ])

    // The corrected entry carries the shifted lines and the BFL reference to
    // the verifikat being rättat.
    expect(mockCreateJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({
        fiscal_period_id: 'period-2020',
        entry_date: '2020-01-01',
        source_type: 'opening_balance',
        description: 'Ingående balanser (korrigerade, rättelse av A4)',
        lines: [
          expect.objectContaining({ account_number: '1630', debit_amount: 10000 }),
          expect.objectContaining({ account_number: '1930', debit_amount: 70000 }),
          expect.objectContaining({ account_number: '2099', credit_amount: 80000 }),
        ],
      }),
    )
    expect(mockReverseEntry).toHaveBeenCalledTimes(1)
    expect(mockReverseEntry).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'ib-2020')
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'replace_period_opening_balance_link',
      expect.objectContaining({ p_period_id: 'period-2020', p_new_entry_id: 'ib-2020-new' }),
    )
  })

  it('skips locked, lock-dated, and bokslut periods without touching them', async () => {
    enqueue({
      data: [
        periodRow({ id: 'p-locked', name: '2020', locked_at: '2021-05-01T00:00:00Z' }),
        periodRow({ id: 'p-lockdate', name: '2021', period_start: '2021-01-01' }),
        periodRow({ id: 'p-yearend', name: '2022', period_start: '2022-01-01' }),
      ],
    })
    // p-lockdate: period_start 2021-01-01 <= lockDate 2021-12-31 → skipped
    // before any further query. p-yearend reaches the year-end check:
    enqueue({ count: 2 }) // year-end check for p-yearend

    const result = await cascadeOpeningBalanceCorrection(supabase, 'company-1', 'user-1', {
      basePeriodStart: '2019-01-01',
      deltas: DELTAS,
      lockDate: '2021-12-31',
      log,
    })

    expect(result.corrected).toEqual([])
    expect(result.skipped).toEqual([
      { fiscal_period_id: 'p-locked', period_name: '2020', reason: 'locked' },
      { fiscal_period_id: 'p-lockdate', period_name: '2021', reason: 'lock_date' },
      { fiscal_period_id: 'p-yearend', period_name: '2022', reason: 'year_end' },
    ])
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockReverseEntry).not.toHaveBeenCalled()
  })

  it('reports a period without a linked IB verifikat as skipped', async () => {
    enqueue({ data: [periodRow({ opening_balance_entry_id: null, opening_balance_entry: null })] })

    const result = await cascadeOpeningBalanceCorrection(supabase, 'company-1', 'user-1', {
      basePeriodStart: '2019-01-01',
      deltas: DELTAS,
      lockDate: null,
      log,
    })

    expect(result.skipped).toEqual([
      { fiscal_period_id: 'period-2020', period_name: '2020', reason: 'no_opening_balance' },
    ])
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('compensates (stornoes the new entry) and continues when the relink fails', async () => {
    enqueue({
      data: [
        periodRow(),
        periodRow({ id: 'period-2021', name: '2021', period_start: '2021-01-01', opening_balance_entry_id: 'ib-2021' }),
      ],
    })
    enqueue({ count: 0 }) // year-end check period-2020
    enqueue({ error: { message: 'relink boom' } }) // relink RPC fails for period-2020
    enqueue({ count: 0 }) // year-end check period-2021
    enqueue({ error: null }) // relink RPC succeeds for period-2021

    mockCreateJournalEntry
      .mockResolvedValueOnce({ id: 'ib-2020-new' })
      .mockResolvedValueOnce({ id: 'ib-2021-new' })
    mockReverseEntry.mockResolvedValue({ id: 'storno' })

    const result = await cascadeOpeningBalanceCorrection(supabase, 'company-1', 'user-1', {
      basePeriodStart: '2019-01-01',
      deltas: DELTAS,
      lockDate: null,
      log,
    })

    expect(result.skipped).toEqual([
      { fiscal_period_id: 'period-2020', period_name: '2020', reason: 'correction_failed' },
    ])
    expect(result.corrected).toEqual([
      expect.objectContaining({ fiscal_period_id: 'period-2021', journal_entry_id: 'ib-2021-new' }),
    ])

    // period-2020: storno of old (ib-2020) then compensating storno of the new
    // entry; period-2021: storno of old (ib-2021).
    expect(mockReverseEntry).toHaveBeenNthCalledWith(1, expect.anything(), 'company-1', 'user-1', 'ib-2020')
    expect(mockReverseEntry).toHaveBeenNthCalledWith(2, expect.anything(), 'company-1', 'user-1', 'ib-2020-new')
    expect(mockReverseEntry).toHaveBeenNthCalledWith(3, expect.anything(), 'company-1', 'user-1', 'ib-2021')

    // Durable audit trail for the failed year.
    const audit = sink.filter((r) => String(r.msg).includes('cascade correction failed'))
    expect(audit.length).toBeGreaterThan(0)
  })

  it('skips a period whose shifted lines no longer validate', async () => {
    // The period's entire IB nets to zero after the delta: fewer than two
    // remaining lines → validation refuses, period reported, nothing booked.
    mockFetchEntryLines.mockResolvedValue([
      { id: 'l1', account_number: '1930', debit_amount: 10000, credit_amount: 0 },
      { id: 'l2', account_number: '1630', debit_amount: 0, credit_amount: 10000 },
    ])
    enqueue({ data: [periodRow()] })
    enqueue({ count: 0 }) // year-end check

    const result = await cascadeOpeningBalanceCorrection(supabase, 'company-1', 'user-1', {
      basePeriodStart: '2019-01-01',
      deltas: new Map([
        ['1930', -10000],
        ['1630', 10000],
      ]),
      lockDate: null,
      log,
    })

    expect(result.skipped).toEqual([
      { fiscal_period_id: 'period-2020', period_name: '2020', reason: 'validation_failed' },
    ])
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })
})
