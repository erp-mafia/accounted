import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createTestLogger } from '@/lib/logger'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()

const mockReplaceOpeningBalanceEntry = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({
  replaceOpeningBalanceEntry: (...args: unknown[]) => mockReplaceOpeningBalanceEntry(...args),
}))

const mockFetchEntryLines = vi.fn()
vi.mock('@/lib/bookkeeping/entry-lines', () => ({
  fetchEntryLines: (...args: unknown[]) => mockFetchEntryLines(...args),
}))

import {
  computeAccountDeltas,
  buildCascadedLines,
  cascadeOpeningBalanceCorrection,
  type CascadeSourceLine,
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
const src = (
  line: { account_number: string; debit_amount: number; credit_amount: number },
  extra: Partial<CascadeSourceLine> = {},
): CascadeSourceLine => ({
  line_description: null,
  dimensions: null,
  ...line,
  ...extra,
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

describe('buildCascadedLines', () => {
  it('keeps original lines verbatim (descriptions and dimensions) and appends sorted adjustment lines', () => {
    const existing = [
      src(D('1930', 80000), { line_description: 'IB 1930', dimensions: { '1': 'STHLM' } }),
      src(K('2099', 80000), { line_description: 'IB 2099' }),
    ]
    const deltas = new Map([
      ['1930', -10000],
      ['1630', 10000],
    ])

    const result = buildCascadedLines(existing, deltas)

    expect(result).toEqual([
      {
        account_number: '1930',
        debit_amount: 80000,
        credit_amount: 0,
        line_description: 'IB 1930',
        dimensions: { '1': 'STHLM' },
      },
      {
        account_number: '2099',
        debit_amount: 0,
        credit_amount: 80000,
        line_description: 'IB 2099',
        dimensions: undefined,
      },
      {
        account_number: '1630',
        debit_amount: 10000,
        credit_amount: 0,
        line_description: 'IB-rättelse 1630',
      },
      {
        account_number: '1930',
        debit_amount: 0,
        credit_amount: 10000,
        line_description: 'IB-rättelse 1930',
      },
    ])

    const totalDebit = result.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = result.reduce((s, l) => s + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })

  it('emits a credit adjustment line for a negative delta and drops zero-amount source rows', () => {
    const existing = [
      src(D('1930', 5000)),
      src(K('2099', 5000)),
      src({ account_number: '1510', debit_amount: 0, credit_amount: 0 }),
    ]
    const deltas = new Map([
      ['1930', -8000],
      ['2099', 8000],
    ])

    const result = buildCascadedLines(existing, deltas)

    expect(result.map((l) => l.account_number)).toEqual(['1930', '2099', '1930', '2099'])
    expect(result[2]).toEqual({
      account_number: '1930',
      debit_amount: 0,
      credit_amount: 8000,
      line_description: 'IB-rättelse 1930',
    })
    expect(result[3]).toEqual({
      account_number: '2099',
      debit_amount: 8000,
      credit_amount: 0,
      line_description: 'IB-rättelse 2099',
    })
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
      { id: 'l1', account_number: '1930', debit_amount: 80000, credit_amount: 0, line_description: 'IB 1930', dimensions: null },
      { id: 'l2', account_number: '2099', debit_amount: 0, credit_amount: 80000, line_description: 'IB 2099', dimensions: null },
    ])
    mockReplaceOpeningBalanceEntry.mockResolvedValue({
      newEntryId: 'ib-new',
      stornoEntryId: 'ib-storno',
      newVoucherNumber: 9,
      stornoVoucherNumber: 10,
    })
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

  it('replaces an open later period atomically and skips a closed one', async () => {
    enqueue({
      data: [
        periodRow(),
        periodRow({ id: 'period-2021', name: '2021', period_start: '2021-01-01', is_closed: true, opening_balance_entry_id: 'ib-2021' }),
      ],
    }) // subsequent periods
    enqueue({ count: 0 }) // year-end check for period-2020

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
        journal_entry_id: 'ib-new',
        reversed_entry_id: 'ib-2020',
      },
    ])
    expect(result.skipped).toEqual([
      { fiscal_period_id: 'period-2021', period_name: '2021', reason: 'closed' },
    ])

    // One atomic engine replacement, CAS-guarded on the old entry, carrying
    // the original lines verbatim plus labelled adjustment lines and the BFL
    // reference to the verifikat being rättat.
    expect(mockReplaceOpeningBalanceEntry).toHaveBeenCalledTimes(1)
    expect(mockReplaceOpeningBalanceEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'ib-2020',
      expect.objectContaining({
        fiscal_period_id: 'period-2020',
        entry_date: '2020-01-01',
        source_type: 'opening_balance',
        voucher_series: 'A',
        description: 'Ingående balanser (korrigerade, rättelse av A4)',
        lines: [
          expect.objectContaining({ account_number: '1930', debit_amount: 80000, line_description: 'IB 1930' }),
          expect.objectContaining({ account_number: '2099', credit_amount: 80000 }),
          expect.objectContaining({ account_number: '1630', debit_amount: 10000, line_description: 'IB-rättelse 1630' }),
          expect.objectContaining({ account_number: '1930', credit_amount: 10000, line_description: 'IB-rättelse 1930' }),
        ],
      }),
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
    expect(mockReplaceOpeningBalanceEntry).not.toHaveBeenCalled()
  })

  it('fails CLOSED when the year-end lookup errors: the period is skipped, not rewritten', async () => {
    enqueue({ data: [periodRow()] })
    enqueue({ count: null, error: { message: 'transient boom' } }) // year-end check fails

    const result = await cascadeOpeningBalanceCorrection(supabase, 'company-1', 'user-1', {
      basePeriodStart: '2019-01-01',
      deltas: DELTAS,
      lockDate: null,
      log,
    })

    expect(result.corrected).toEqual([])
    expect(result.skipped).toEqual([
      { fiscal_period_id: 'period-2020', period_name: '2020', reason: 'correction_failed' },
    ])
    expect(mockReplaceOpeningBalanceEntry).not.toHaveBeenCalled()

    const audit = sink.filter((r) => String(r.msg).includes('cascade correction failed'))
    expect(audit.length).toBeGreaterThan(0)
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
    expect(mockReplaceOpeningBalanceEntry).not.toHaveBeenCalled()
  })

  it('reports a failed replacement as skipped and continues with the next year', async () => {
    enqueue({
      data: [
        periodRow(),
        periodRow({ id: 'period-2021', name: '2021', period_start: '2021-01-01', opening_balance_entry_id: 'ib-2021' }),
      ],
    })
    enqueue({ count: 0 }) // year-end check period-2020
    enqueue({ count: 0 }) // year-end check period-2021

    mockReplaceOpeningBalanceEntry
      .mockRejectedValueOnce(new Error('replacement boom')) // period-2020
      .mockResolvedValueOnce({
        newEntryId: 'ib-2021-new',
        stornoEntryId: 'ib-2021-storno',
        newVoucherNumber: 12,
        stornoVoucherNumber: 13,
      })

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

    // The failed period got exactly one atomic attempt (RPC rolls back all of
    // it); no compensation writes exist in this design.
    expect(mockReplaceOpeningBalanceEntry).toHaveBeenCalledTimes(2)
    expect(mockReplaceOpeningBalanceEntry).toHaveBeenNthCalledWith(
      1, expect.anything(), 'company-1', 'user-1', 'ib-2020', expect.anything(),
    )
    expect(mockReplaceOpeningBalanceEntry).toHaveBeenNthCalledWith(
      2, expect.anything(), 'company-1', 'user-1', 'ib-2021', expect.anything(),
    )

    const audit = sink.filter((r) => String(r.msg).includes('cascade correction failed'))
    expect(audit.length).toBeGreaterThan(0)
  })

  it('skips a period whose shifted lines no longer validate', async () => {
    // The period's IB is a single line pair that the delta exactly cancels,
    // leaving zero-amount adjustments only... construct instead the <2 lines
    // case: the source entry is empty (all rows zero), so kept+adjustment
    // lines fail the P&L/two-line validation via a P&L delta account.
    mockFetchEntryLines.mockResolvedValue([
      { id: 'l1', account_number: '1930', debit_amount: 10000, credit_amount: 0, line_description: null, dimensions: null },
      { id: 'l2', account_number: '1630', debit_amount: 0, credit_amount: 10000, line_description: null, dimensions: null },
    ])
    enqueue({ data: [periodRow()] })
    enqueue({ count: 0 }) // year-end check

    const result = await cascadeOpeningBalanceCorrection(supabase, 'company-1', 'user-1', {
      basePeriodStart: '2019-01-01',
      deltas: new Map([
        ['3001', 10000],
        ['1930', -10000],
      ]),
      lockDate: null,
      log,
    })

    expect(result.skipped).toEqual([
      { fiscal_period_id: 'period-2020', period_name: '2020', reason: 'validation_failed' },
    ])
    expect(mockReplaceOpeningBalanceEntry).not.toHaveBeenCalled()
  })
})
