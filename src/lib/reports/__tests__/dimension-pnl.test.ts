import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TrialBalanceRow } from '@/types'

// ============================================================
// Resultat per projekt/kostnadsställe (dimensions PR4).
//
// generateTrialBalance is mocked (post-processor pattern, like
// resultatrapport.test.ts). The tagged pass is one SQL call,
// get_dimension_pnl_buckets; both fakes below answer it the way the function
// does (tests/pg/ledger-account-days.pg.test.ts pins the function itself on
// real Postgres). The registry reads use a table-keyed FIFO mock, and the
// window/exclusion suite at the end a small ledger mock.
// ============================================================

vi.mock('../trial-balance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../trial-balance')>()),
  generateTrialBalance: vi.fn(),
}))

// The resultatrapport's header line; not what the reconciliation test is about.
vi.mock('../latest-vouchers', () => ({
  getLatestPostedVouchers: vi.fn().mockResolvedValue([]),
}))

type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'lte', 'gte', 'neq', 'not', 'or', 'contains', 'order', 'range']) {
    b[m] = vi.fn().mockReturnValue(b)
  }
  const consume = (): MockResult => consumeQueued(tableName)
  b.single = vi.fn().mockImplementation(async () => consume())
  b.maybeSingle = vi.fn().mockImplementation(async () => consume())
  b.then = (resolve: (v: unknown) => void) => resolve(consume())
  return b
}

function consumeQueued(tableName: string): MockResult {
  const queue = mockResults[tableName]
  if (!queue || queue.length === 0) return { data: null, error: null }
  return queue.shift()!
}

interface BucketLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions: Record<string, unknown>
}

/** What get_dimension_pnl_buckets returns for these lines: per account and
 *  stored value of the dimension (string values only), debit and credit. */
function bucketsFromLines(lines: BucketLine[], dimNo: string) {
  const sums = new Map<string, { account_number: string; code: string; debit: number; credit: number }>()
  for (const line of lines) {
    const code = line.dimensions?.[dimNo]
    if (typeof code !== 'string') continue
    const key = `${line.account_number}\u0000${code}`
    const agg = sums.get(key) ?? { account_number: line.account_number, code, debit: 0, credit: 0 }
    agg.debit += line.debit_amount
    agg.credit += line.credit_amount
    sums.set(key, agg)
  }
  return [...sums.values()]
}

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    // The tagged lines a test queues under journal_entry_lines are the lines
    // the function sums.
    rpc: vi.fn().mockImplementation(async (fn: string, args: { p_dim_no: string }) => {
      if (fn !== 'get_dimension_pnl_buckets') return { data: null, error: null }
      const queued = consumeQueued('journal_entry_lines')
      if (queued.error) return queued
      return { data: bucketsFromLines((queued.data as BucketLine[] | null) ?? [], args.p_dim_no), error: null }
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

import { generateDimensionPnl } from '../dimension-pnl'
import { generateResultatrapport } from '../resultatrapport'
import { generateTrialBalance } from '../trial-balance'

const mockTrialBalance = vi.mocked(generateTrialBalance)

function tbRow(partial: Partial<TrialBalanceRow>): TrialBalanceRow {
  const row: TrialBalanceRow = {
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
  // Full-period P&L reality: no opening balance, so window activity equals
  // closing. Tests specify closing_*; mirror it into period_* unless the test
  // sets window activity (or an opening) explicitly.
  if (
    row.period_debit === 0 && row.period_credit === 0 &&
    row.opening_debit === 0 && row.opening_credit === 0
  ) {
    row.period_debit = row.closing_debit
    row.period_credit = row.closing_credit
  }
  return row
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
    // net_total = resultatrapport semantics over classes 3-8:
    // +1000 (3001) − 400 (4010) = 600. 1930 (class 1) excluded.
    expect(report.net_total).toBe(600)
    expect(report.period).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })

  it('lists a booked 8999 in the untagged bucket and nets it into net_total (#2455)', async () => {
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
      tb([
        tbRow({ account_number: '3001', account_class: 3, closing_credit: 1000 }),
        // Manual omföring of årets resultat: 8999 debit, never dimension-tagged.
        tbRow({ account_number: '8999', account_name: 'Årets resultat', account_class: 8, closing_debit: 1000 }),
      ]),
    )

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '6')

    const row8999 = report.groups.flatMap((g) => g.rows).find((r) => r.account_number === '8999')
    expect(row8999?.total).toBe(-1000)
    // Same scope as resultatrapport: the omföring zeroes the result.
    expect(report.net_total).toBe(0)
    expect(report.net_per_column).toEqual([1000, -1000])
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

  it('passes the caller window to the trial balance exactly as resultatrapport does', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      dimensions: [{ data: null, error: null }],
      journal_entry_lines: [{ data: [], error: null }],
    }
    mockTrialBalance.mockResolvedValue(tb([]))

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '6', {
      fromDate: '2026-04-01',
      toDate: '2026-06-30',
    })

    expect(mockTrialBalance).toHaveBeenCalledTimes(1)
    expect(mockTrialBalance.mock.calls[0][3]).toStrictEqual({
      closingEntry: 'exclude-all-year-end',
      fromDate: '2026-04-01',
      toDate: '2026-06-30',
      dimensions: undefined,
    })
    // The label is the window the amounts cover.
    expect(report.period).toEqual({ start: '2026-04-01', end: '2026-06-30' })
  })

  it('labels a to-date-only window from the period start', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      dimensions: [{ data: null, error: null }],
      journal_entry_lines: [{ data: [], error: null }],
    }
    mockTrialBalance.mockResolvedValue(tb([]))

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '6', {
      toDate: '2026-06-30',
    })

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

  it('reads the value from each line\'s own bag: a line tagged on another dimension stays untagged', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      journal_entry_lines: [
        {
          // What the non-empty-bag filter returns: every tagged line, also
          // the ones that carry only a kostnadsställe.
          data: [
            { id: 'l1', account_number: '3001', debit_amount: 0, credit_amount: 600, dimensions: { '6': 'P1' } },
            { id: 'l2', account_number: '3001', debit_amount: 0, credit_amount: 300, dimensions: { '1': 'KS01' } },
            { id: 'l3', account_number: '5010', debit_amount: 200, credit_amount: 0, dimensions: { '1': 'KS01', '6': 'P1' } },
          ],
          error: null,
        },
      ],
    }
    mockTrialBalance.mockResolvedValue(
      tb([
        tbRow({ account_number: '3001', account_class: 3, closing_credit: 900 }),
        tbRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, closing_debit: 200 }),
      ]),
    )

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '6')

    expect(report.columns.map((c) => c.code)).toEqual(['P1', null])
    expect(report.groups.flatMap((g) => g.rows)).toEqual([
      { account_number: '3001', account_name: 'Försäljning', values: [600, 300], total: 900 },
      { account_number: '5010', account_name: 'Lokalhyra', values: [-200, 0], total: -200 },
    ])
    expect(report.net_per_column).toEqual([400, 300])
  })

  it('reads the tagged pass as one SQL call, never line by line through PostgREST', async () => {
    mockResults = { fiscal_periods: [{ data: PERIOD, error: null }] }
    mockTrialBalance.mockResolvedValue(tb([tbRow({ account_number: '3001', account_class: 3, closing_credit: 100 })]))

    await generateDimensionPnl(supabase, 'company-1', 'period-1', '6', { fromDate: '2026-02-01', toDate: '2026-02-28' })

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith('get_dimension_pnl_buckets', {
      p_company_id: 'company-1',
      p_fiscal_period_id: 'period-1',
      p_dim_no: '6',
      p_from_date: '2026-02-01',
      p_to_date: '2026-02-28',
    })
    const tables = supabase.from.mock.calls.map(([table]: [string]) => table)
    expect(tables).not.toContain('journal_entry_lines')
    expect(tables).not.toContain('journal_entries')
  })

  it('trims and merges stored values the way normalizeLineDimensions does', async () => {
    mockResults = {
      fiscal_periods: [{ data: PERIOD, error: null }],
      journal_entry_lines: [
        {
          data: [
            { account_number: '3001', debit_amount: 0, credit_amount: 600, dimensions: { '6': 'P1' } },
            { account_number: '3001', debit_amount: 0, credit_amount: 300, dimensions: { '6': ' P1\t' } },
            { account_number: '3001', debit_amount: 0, credit_amount: 100, dimensions: { '6': '  ' } },
          ],
          error: null,
        },
      ],
    }
    mockTrialBalance.mockResolvedValue(tb([tbRow({ account_number: '3001', account_class: 3, closing_credit: 1000 })]))

    const report = await generateDimensionPnl(supabase, 'company-1', 'period-1', '6')

    expect(report.columns.map((c) => c.code)).toEqual(['P1', null])
    expect(report.groups[0].rows[0].values).toEqual([900, 100])
  })

  it('rejects a non-numeric dimension number', async () => {
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

// ============================================================
// Window and exclusions, against a small ledger mock.
//
// The FIFO mock above has no entries, so it cannot show WHICH lines the
// tagged pass sums. This one answers get_dimension_pnl_buckets from a ledger
// with an IB entry, a retagged year-end entry and the storno of last year's
// reversed one, so a matrix built from the wrong set shows up as a wrong
// cell. generateTrialBalance stays mocked: its rows are what
// get_trial_balance_aggregates returns for the same ledger.
// ============================================================

type Row = Record<string, unknown>

interface LedgerEntry {
  id: string
  fiscal_period_id: string
  entry_date: string
  status: 'posted' | 'reversed'
  source_type: string
  reverses_id?: string | null
  correction_of_id?: string | null
}

interface LedgerLine {
  id: string
  journal_entry_id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions: Record<string, string>
}

function ledgerClient(ledger: { period: Row; entries: LedgerEntry[]; lines: LedgerLine[] }) {
  function builder(table: string) {
    const filters: Array<(row: Row) => boolean> = []
    let page: [number, number] | null = null
    const source = (): Row[] =>
      table === 'journal_entries'
        ? (ledger.entries as unknown as Row[])
        : table === 'journal_entry_lines'
          ? (ledger.lines as unknown as Row[])
          : []
    // A filter on a column the fixture rows do not carry (company_id) passes.
    const has = (row: Row, col: string) => Object.prototype.hasOwnProperty.call(row, col)
    const b: Row = {}
    const add = (f: (row: Row) => boolean) => {
      filters.push(f)
      return b
    }
    b.select = () => b
    b.order = () => b
    b.range = (from: number, to: number) => {
      page = [from, to]
      return b
    }
    b.eq = (col: string, val: unknown) => add((r) => !has(r, col) || r[col] === val)
    // The tagged pass narrows to lines with a non-empty bag: neq('dimensions',
    // '{}'). Which value a line has on the requested dimension is the
    // generator's own read of the bag, so this fake never interprets a
    // dimension number. (It used to answer `dimensions->>N` as a key lookup,
    // which real PostgREST reads as an array index: the fake agreed with the
    // author instead of the server. tests/tool-pg/dimension-pnl.tool.test.ts
    // runs the generator against a real one.)
    b.neq = (col: string, val: unknown) =>
      col === 'dimensions' && val === '{}'
        ? add((r) => Object.keys((r.dimensions as Record<string, string> | undefined) ?? {}).length > 0)
        : add((r) => !has(r, col) || r[col] !== val)
    b.in = (col: string, vals: unknown[]) => add((r) => !has(r, col) || vals.includes(r[col]))
    b.gte = (col: string, val: string) => add((r) => !has(r, col) || String(r[col]) >= val)
    b.lte = (col: string, val: string) => add((r) => !has(r, col) || String(r[col]) <= val)
    // excludeYearEndChain's shape: "<col>.is.null,<col>.not.in.(a,b)".
    b.or = (expr: string) => {
      const m = /^(\w+)\.is\.null,\1\.not\.in\.\((.*)\)$/.exec(expr)
      if (!m) throw new Error(`unsupported or(): ${expr}`)
      const ids = m[2].split(',')
      return add((r) => r[m[1]] == null || !ids.includes(String(r[m[1]])))
    }
    b.single = async () => ({ data: table === 'fiscal_periods' ? ledger.period : null, error: null })
    b.maybeSingle = async () => ({ data: null, error: null }) // no registry row: default names
    b.then = (resolve: (v: unknown) => void) => {
      const rows = source().filter((r) => filters.every((f) => f(r)))
      resolve({ data: page ? rows.slice(page[0], page[1] + 1) : rows, error: null })
    }
    return b
  }
  // get_dimension_pnl_buckets on this ledger: the period's posted/reversed
  // entries inside the window, without the opening-balance entry, year_end
  // entries and the storno/rättelse of a reversed year_end entry.
  const rpc = vi.fn(async (fn: string, args: Record<string, string | null>) => {
    if (fn !== 'get_dimension_pnl_buckets') return { data: null, error: null }
    const reversedYearEnd = new Set(
      ledger.entries.filter((e) => e.source_type === 'year_end' && e.status === 'reversed').map((e) => e.id),
    )
    const included = new Set(
      ledger.entries
        .filter((e) => e.fiscal_period_id === args.p_fiscal_period_id)
        .filter((e) => !args.p_from_date || e.entry_date >= args.p_from_date)
        .filter((e) => !args.p_to_date || e.entry_date <= args.p_to_date)
        .filter((e) => e.id !== ledger.period.opening_balance_entry_id)
        .filter((e) => e.source_type !== 'year_end')
        .filter((e) => !reversedYearEnd.has(String(e.reverses_id)) && !reversedYearEnd.has(String(e.correction_of_id)))
        .map((e) => e.id),
    )
    const lines = ledger.lines.filter((l) => included.has(l.journal_entry_id))
    return { data: bucketsFromLines(lines, String(args.p_dim_no)), error: null }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: vi.fn((table: string) => builder(table)), rpc } as any
}

// One räkenskapsår tagged on dimension 1 (kostnadsställe KS01):
//   sale-q2 / sale-q3  ordinary sales, KS01 partly tagged, in Q2 and Q3;
//   dep-jun            an untagged depreciation on 7832 in June;
//   ye-2026            the bokslut depreciation, retagged to KS01 after posting;
//   storno-ye-2025     this year's storno of LAST year's reversed year-end
//                      entry: its root sits in another period;
//   ob-2026            the opening-balance entry (IB, never activity).
function ledger() {
  const entries: LedgerEntry[] = [
    { id: 'ob-2026', fiscal_period_id: 'period-1', entry_date: '2026-01-01', status: 'posted', source_type: 'opening_balance' },
    { id: 'storno-ye-2025', fiscal_period_id: 'period-1', entry_date: '2026-01-15', status: 'posted', source_type: 'storno', reverses_id: 'ye-2025' },
    { id: 'sale-q2', fiscal_period_id: 'period-1', entry_date: '2026-05-10', status: 'posted', source_type: 'manual' },
    { id: 'dep-jun', fiscal_period_id: 'period-1', entry_date: '2026-06-30', status: 'posted', source_type: 'manual' },
    { id: 'sale-q3', fiscal_period_id: 'period-1', entry_date: '2026-08-15', status: 'posted', source_type: 'manual' },
    { id: 'ye-2026', fiscal_period_id: 'period-1', entry_date: '2026-12-31', status: 'posted', source_type: 'year_end' },
    { id: 'ye-2025', fiscal_period_id: 'period-0', entry_date: '2025-12-31', status: 'reversed', source_type: 'year_end' },
  ]
  const lines: LedgerLine[] = [
    { id: 'l-ob', journal_entry_id: 'ob-2026', account_number: '3001', debit_amount: 0, credit_amount: 999, dimensions: { '1': 'KS01' } },
    { id: 'l-st', journal_entry_id: 'storno-ye-2025', account_number: '7832', debit_amount: 0, credit_amount: 20000, dimensions: { '1': 'KS01' } },
    { id: 'l-q2', journal_entry_id: 'sale-q2', account_number: '3001', debit_amount: 0, credit_amount: 1000, dimensions: { '1': 'KS01' } },
    { id: 'l-dep', journal_entry_id: 'dep-jun', account_number: '7832', debit_amount: 1000, credit_amount: 0, dimensions: {} },
    { id: 'l-q3a', journal_entry_id: 'sale-q3', account_number: '3001', debit_amount: 0, credit_amount: 400, dimensions: { '1': 'KS01' } },
    { id: 'l-q3b', journal_entry_id: 'sale-q3', account_number: '3001', debit_amount: 0, credit_amount: 100, dimensions: {} },
    { id: 'l-ye', journal_entry_id: 'ye-2026', account_number: '7832', debit_amount: 50000, credit_amount: 0, dimensions: { '1': 'KS01' } },
  ]
  const period = {
    id: 'period-1',
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    previous_period_id: null,
    opening_balance_entry_id: 'ob-2026',
  }
  return { period, entries, lines }
}

function rowsOf(report: Awaited<ReturnType<typeof generateDimensionPnl>>) {
  return Object.fromEntries(
    report.groups.flatMap((g) => g.rows).map((r) => [r.account_number, { values: r.values, total: r.total }]),
  )
}

describe('generateDimensionPnl: window and exclusions', () => {
  it('leaves year-end entries, their storno chain and the opening-balance entry out of the tagged pass', async () => {
    // What the RPC returns for the whole year under 'exclude-all-year-end':
    // the OB entry is IB (3001 opening 999), ye-2026 and the storno of
    // ye-2025 are not activity at all.
    mockTrialBalance.mockResolvedValue(
      tb([
        tbRow({ account_number: '3001', account_class: 3, opening_credit: 999, period_credit: 1500, closing_credit: 2499 }),
        tbRow({ account_number: '7832', account_name: 'Avskrivningar', account_class: 7, period_debit: 1000, closing_debit: 1000 }),
      ]),
    )

    const report = await generateDimensionPnl(ledgerClient(ledger()), 'company-1', 'period-1', '1')

    expect(report.columns).toEqual([
      { code: 'KS01', name: null },
      { code: null, name: null },
    ])
    expect(rowsOf(report)).toEqual({
      // sale-q2 1000 + sale-q3 400 tagged; the OB line's 999 is IB, not activity.
      '3001': { values: [1400, 100], total: 1500 },
      // Neither the retagged bokslut depreciation (−50 000) nor the storno of
      // last year's year-end entry (+20 000) is in Totalt, so neither is in KS01.
      '7832': { values: [0, -1000], total: -1000 },
    })
    expect(report.net_per_column).toEqual([1400, -900])
    expect(report.net_total).toBe(500)
  })

  it('reads one quarter: Totalt is the window activity and the tagged pass stays inside the window', async () => {
    // Q3 under the RPC: everything before 2026-07-01 rolls into the opening
    // columns; only sale-q3 is window activity.
    mockTrialBalance.mockResolvedValue(
      tb([
        tbRow({ account_number: '3001', account_class: 3, opening_credit: 1999, period_credit: 500, closing_credit: 2499 }),
        tbRow({ account_number: '7832', account_name: 'Avskrivningar', account_class: 7, opening_debit: 1000, closing_debit: 1000 }),
      ]),
    )

    const report = await generateDimensionPnl(ledgerClient(ledger()), 'company-1', 'period-1', '1', {
      fromDate: '2026-07-01',
      toDate: '2026-09-30',
    })

    expect(rowsOf(report)).toEqual({ '3001': { values: [400, 100], total: 500 } })
    expect(report.net_total).toBe(500)
    expect(report.period).toEqual({ start: '2026-07-01', end: '2026-09-30' })
  })

  it('Totalt equals the resultatrapport for the same window, account by account', async () => {
    const q3 = { fromDate: '2026-07-01', toDate: '2026-09-30' }
    // Rows whose closing differs from their window activity, so a report
    // that read closing (year to date) would disagree here.
    mockTrialBalance.mockResolvedValue(
      tb([
        tbRow({ account_number: '1930', account_name: 'Bank', account_class: 1, opening_debit: 5000, period_debit: 500, closing_debit: 5500 }),
        tbRow({ account_number: '3001', account_class: 3, opening_credit: 1999, period_credit: 500, closing_credit: 2499 }),
        tbRow({ account_number: '4010', account_name: 'Inköp', account_class: 4, opening_debit: 300, period_debit: 120.5, closing_debit: 420.5 }),
        tbRow({ account_number: '7832', account_name: 'Avskrivningar', account_class: 7, opening_debit: 1000, closing_debit: 1000 }),
        tbRow({ account_number: '8999', account_name: 'Årets resultat', account_class: 8, period_debit: 200, closing_debit: 200 }),
      ]),
    )

    const pnl = await generateDimensionPnl(ledgerClient(ledger()), 'company-1', 'period-1', '1', q3)
    const rapport = await generateResultatrapport(ledgerClient(ledger()), 'company-1', 'period-1', q3)

    const rapportRows = Object.fromEntries(
      rapport.groups.flatMap((g) => g.rows).map((r) => [r.account_number, r.current_period]),
    )
    const pnlTotals = Object.fromEntries(
      pnl.groups.flatMap((g) => g.rows).map((r) => [r.account_number, r.total]),
    )
    expect(pnlTotals).toEqual(rapportRows)
    expect(pnlTotals).toEqual({ '3001': 500, '4010': -120.5, '8999': -200 })
    expect(pnl.net_total).toBe(rapport.net_result_current)
    expect(pnl.period).toEqual(rapport.period)
    // Both read the same trial balance: one call each, same window.
    expect(mockTrialBalance.mock.calls.map((c) => c[3])).toStrictEqual([
      { closingEntry: 'exclude-all-year-end', ...q3, dimensions: undefined },
      { closingEntry: 'exclude-all-year-end', ...q3, dimensions: undefined },
    ])
  })
})
