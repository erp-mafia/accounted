import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TrialBalanceRow } from '@/types'

// ============================================================
// Resultat per projekt/kostnadsställe (dimensions PR4).
//
// generateTrialBalance is mocked (post-processor pattern, like
// resultatrapport.test.ts); the registry + tagged-line queries use a
// table-keyed FIFO mock.
// ============================================================

vi.mock('../trial-balance', () => ({
  generateTrialBalance: vi.fn(),
}))

type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'lte', 'gte', 'neq', 'not', 'contains', 'order', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  const consume = (): MockResult => {
    const queue = mockResults[tableName]
    if (!queue || queue.length === 0) {
      // The two-step entry-lines fetch (lib/bookkeeping/entry-lines.ts) reads
      // journal_entries before journal_entry_lines. Tests queue line rows
      // directly, so default the entries step to one generic entry.
      if (tableName === 'journal_entries') {
        return { data: [{ id: 'entry-1' }], error: null }
      }
      return { data: null, error: null }
    }
    return queue.shift()!
  }
  b.single = vi.fn().mockImplementation(async () => consume())
  b.maybeSingle = vi.fn().mockImplementation(async () => consume())
  b.then = (resolve: (v: unknown) => void) => resolve(consume())
  return b
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { generateDimensionPnl } from '../dimension-pnl'
import { generateTrialBalance } from '../trial-balance'

const mockTrialBalance = vi.mocked(generateTrialBalance)

function tbRow(partial: Partial<TrialBalanceRow>): TrialBalanceRow {
  return {
    account_number: '3001',
    account_name: 'Försäljning',
    account_class: 3,
    opening_debit: 0,
    opening_credit: 0,
    period_debit: 0,
    period_credit: 0,
    closing_debit: 0,
    closing_credit: 0,
    ...partial,
  }
}

function tb(rows: TrialBalanceRow[]) {
  return { rows, totalDebit: 0, totalCredit: 0, isBalanced: true }
}

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  mockResults = {}
  supabase = makeClient()
})

const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

describe('generateDimensionPnl', () => {
  it('builds the value-as-column matrix with an untagged residual that reconciles to the trial balance', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      dimensions: [
        { data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt' }, error: null },
      ],
      dimension_values: [
        {
          data: [
            { code: 'P001', name: 'Villa Almgren' },
            { code: 'P002', name: 'Kontorsbygget' },
          ],
          error: null,
        },
      ],
      journal_entry_lines: [
        {
          data: [
            { id: 'l1', account_number: '3001', debit_amount: 0, credit_amount: 600, dimensions: { '6': 'P001' } },
            { id: 'l2', account_number: '3001', debit_amount: 0, credit_amount: 300, dimensions: { '6': 'P002' } },
            { id: 'l3', account_number: '4010', debit_amount: 400, credit_amount: 0, dimensions: { '6': 'P001' } },
            // Balance-account line: outside the P&L scope, must be ignored.
            { id: 'l4', account_number: '1930', debit_amount: 0, credit_amount: 900, dimensions: { '6': 'P001' } },
          ],
          error: null,
        },
      ],
    }
    mockTrialBalance.mockResolvedValue(
      tb([
        // 3001: 1000 total credit: only 900 of it is tagged → 100 untagged.
        tbRow({ account_number: '3001', account_class: 3, closing_credit: 1000 }),
        tbRow({ account_number: '4010', account_name: 'Inköp', account_class: 4, closing_debit: 400 }),
        tbRow({ account_number: '1930', account_name: 'Bank', account_class: 1, closing_debit: 900 }),
        tbRow({ account_number: '8999', account_name: 'Årets resultat', account_class: 8, closing_debit: 600 }),
      ]),
    )

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '6')

    expect(report.dimension).toEqual({ sie_dim_no: '6', name: 'Projekt' })
    expect(report.columns).toEqual([
      { code: 'P001', name: 'Villa Almgren' },
      { code: 'P002', name: 'Kontorsbygget' },
      { code: null, name: null }, // (Utan dimension)
    ])

    const revenue = report.groups.find((g) => g.class === 3)!
    expect(revenue.rows).toEqual([
      { account_number: '3001', account_name: 'Försäljning', values: [600, 300, 100], total: 1000 },
    ])
    const costs = report.groups.find((g) => g.class === 4)!
    expect(costs.rows).toEqual([
      { account_number: '4010', account_name: 'Inköp', values: [-400, 0, 0], total: -400 },
    ])

    // Every row sums exactly to its Totalt (reconciliation by construction).
    for (const g of report.groups) {
      for (const r of g.rows) {
        expect(r.values.reduce((s, v) => s + v, 0)).toBeCloseTo(r.total, 10)
      }
    }

    expect(report.net_per_column).toEqual([200, 300, 100])
    // net_total = resultatrapport semantics over classes 3-8 excl 8999:
    // +1000 (3001) − 400 (4010) = 600. 1930 (class 1) and 8999 excluded.
    expect(report.net_total).toBe(600)
    expect(report.period).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('drops the untagged column when every krona is tagged', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      dimensions: [{ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt' }, error: null }],
      dimension_values: [{ data: [{ code: 'P001', name: 'Villa Almgren' }], error: null }],
      journal_entry_lines: [
        {
          data: [
            { id: 'l1', account_number: '3001', debit_amount: 0, credit_amount: 1000, dimensions: { '6': 'P001' } },
          ],
          error: null,
        },
      ],
    }
    mockTrialBalance.mockResolvedValue(
      tb([tbRow({ account_number: '3001', account_class: 3, closing_credit: 1000 })]),
    )

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '6')

    expect(report.columns).toEqual([{ code: 'P001', name: 'Villa Almgren' }])
    expect(report.groups[0].rows[0].values).toEqual([1000])
    expect(report.net_per_column).toEqual([1000])
    expect(report.net_total).toBe(1000)
  })

  it('falls back to seeded dimension names when the registry has no row', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      dimensions: [{ data: null, error: null }],
      journal_entry_lines: [
        {
          data: [
            { id: 'l1', account_number: '3001', debit_amount: 0, credit_amount: 100, dimensions: { '1': 'KS01' } },
          ],
          error: null,
        },
      ],
    }
    mockTrialBalance.mockResolvedValue(
      tb([tbRow({ account_number: '3001', account_class: 3, closing_credit: 100 })]),
    )

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '1')

    expect(report.dimension.name).toBe('Kostnadsställe')
    // Code column without a registry name.
    expect(report.columns[0]).toEqual({ code: 'KS01', name: null })
  })

  it('passes the caller date range to the trial balance (Totalt parity with resultatrapport)', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      dimensions: [{ data: null, error: null }],
      journal_entry_lines: [{ data: [], error: null }],
    }
    mockTrialBalance.mockResolvedValue(tb([]))

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '6', {
      toDate: '2026-06-30',
    })

    expect(mockTrialBalance).toHaveBeenCalledWith(supabase, 'company-1', 'period-1', {
      toDate: '2026-06-30',
    })
    // The label reflects actual coverage: cumulative from period_start.
    expect(report.period).toEqual({ start: '2026-01-01', end: '2026-06-30' })
  })

  it('handles fully untagged periods: one residual column carrying the whole result', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      dimensions: [{ data: { id: 'dim-6', sie_dim_no: 6, name: 'Projekt' }, error: null }],
      dimension_values: [{ data: [], error: null }],
      journal_entry_lines: [{ data: [], error: null }],
    }
    mockTrialBalance.mockResolvedValue(
      tb([
        tbRow({ account_number: '3001', account_class: 3, closing_credit: 1000 }),
        tbRow({ account_number: '4010', account_name: 'Inköp', account_class: 4, closing_debit: 250 }),
      ]),
    )

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '6')

    expect(report.columns).toEqual([{ code: null, name: null }])
    expect(report.groups.find((g) => g.class === 3)?.rows[0].values).toEqual([1000])
    expect(report.groups.find((g) => g.class === 4)?.rows[0].values).toEqual([-250])
    expect(report.net_per_column).toEqual([750])
    expect(report.net_total).toBe(750)
  })

  it('rejects a non-numeric dimension number (PostgREST path guard)', async () => {
    await expect(
      generateDimensionPnl(supabase, 'company-1', 'period-1', '6,is.null'),
    ).rejects.toThrow('positive SIE dimension number')
  })

  it('throws when the fiscal period does not exist', async () => {
    mockResults = { fiscal_periods: [{ data: null, error: null }] }
    await expect(generateDimensionPnl(supabase, 'company-1', 'missing', '6')).rejects.toThrow(
      'Fiscal period not found',
    )
  })
})
