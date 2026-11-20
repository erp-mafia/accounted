import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { TrialBalanceRow } from '@/types'

// ============================================================
// Resultat across two dimensions (accounted#133).
//
// generateTrialBalance is mocked, as in dimension-pnl.test.ts, so the
// total can be checked against generateResultatrapport itself. The tagged
// pass is one SQL call, get_dimension_cross_buckets; the fake below answers
// it the way the function does (tests/pg/dimension-cross.pg.test.ts pins
// the function on real Postgres).
// ============================================================

vi.mock('../trial-balance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../trial-balance')>()),
  generateTrialBalance: vi.fn(),
}))

vi.mock('../latest-vouchers', () => ({
  getLatestPostedVouchers: vi.fn().mockResolvedValue([]),
}))

type MockResult = { data?: unknown; error?: unknown }
let mockResults: Record<string, MockResult[]>

function makeBuilder(tableName: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lt', 'lte', 'gte', 'neq', 'not', 'or', 'contains', 'order', 'range', 'limit']) {
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

interface Line {
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions: Record<string, unknown>
}

/** What get_dimension_cross_buckets returns for these lines: result accounts, at least one of the two tags. */
function crossBuckets(lines: Line[], dimA: string, dimB: string) {
  const sums = new Map<string, { account_number: string; code_a: string | null; code_b: string | null; debit: number; credit: number }>()
  for (const line of lines) {
    if (line.account_number < '3000' || line.account_number >= '9000') continue
    const a = typeof line.dimensions[dimA] === 'string' ? (line.dimensions[dimA] as string) : null
    const b = typeof line.dimensions[dimB] === 'string' ? (line.dimensions[dimB] as string) : null
    if (a === null && b === null) continue
    const key = JSON.stringify([line.account_number, a, b])
    const agg = sums.get(key) ?? { account_number: line.account_number, code_a: a, code_b: b, debit: 0, credit: 0 }
    agg.debit += line.debit_amount
    agg.credit += line.credit_amount
    sums.set(key, agg)
  }
  return [...sums.values()]
}

let lines: Line[] = []
let rpcError: { code: string; message: string } | null = null

function makeClient() {
  return {
    from: vi.fn().mockImplementation((table: string) => makeBuilder(table)),
    rpc: vi.fn().mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      if (rpcError) return { data: null, error: rpcError }
      if (fn === 'get_dimension_cross_buckets') {
        return { data: crossBuckets(lines, args.p_dim_a as string, args.p_dim_b as string), error: null }
      }
      if (fn === 'get_dimension_cross_lines') return { data: pageAnswer, error: null }
      return { data: null, error: null }
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

let pageAnswer: unknown = null

import {
  DimensionCrossNotReadyError,
  dimensionCrossAxesError,
  dimensionCrossMeasureNote,
  fetchDimensionCrossLines,
  generateDimensionCross,
} from '../dimension-cross'
import { generateResultatrapport } from '../resultatrapport'
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

const tb = (rows: TrialBalanceRow[]) => ({ rows, totalDebit: 0, totalCredit: 0, isBalanced: true })
const PERIOD = { period_start: '2026-01-01', period_end: '2026-12-31' }

function registry() {
  return {
    fiscal_periods: [{ data: PERIOD, error: null }],
    dimensions: [
      {
        data: [
          { id: 'dim-1', sie_dim_no: 1, name: 'Region' },
          { id: 'dim-6', sie_dim_no: 6, name: 'Kanal' },
        ],
        error: null,
      },
    ],
    dimension_values: [
      {
        data: [
          { dimension_id: 'dim-1', code: 'NORR', name: 'Region Norr' },
          { dimension_id: 'dim-1', code: 'SYD', name: 'Region Syd' },
          // Archived values keep their name: the registry read does not filter them.
          { dimension_id: 'dim-6', code: 'WEB', name: 'Webb' },
          { dimension_id: 'dim-6', code: 'TEL', name: 'Telefon' },
        ],
        error: null,
      },
    ],
  } as Record<string, MockResult[]>
}

let supabase: ReturnType<typeof makeClient>

beforeEach(() => {
  vi.clearAllMocks()
  mockResults = registry()
  rpcError = null
  pageAnswer = null
  supabase = makeClient()
  lines = [
    { account_number: '3001', debit_amount: 0, credit_amount: 1000, dimensions: { '1': 'NORR', '6': 'WEB' } },
    { account_number: '3001', debit_amount: 0, credit_amount: 250.5, dimensions: { '1': ' NORR ', '6': 'TEL' } },
    { account_number: '3001', debit_amount: 0, credit_amount: 400, dimensions: { '1': 'SYD' } },
    { account_number: '5010', debit_amount: 300, credit_amount: 0, dimensions: { '6': 'WEB' } },
    { account_number: '5010', debit_amount: 120, credit_amount: 0, dimensions: { '1': 'SYD', '6': 'WEB' } },
    // A number is not a tag; a balance line is out of the result.
    { account_number: '5420', debit_amount: 80, credit_amount: 0, dimensions: { '1': 5 } },
    { account_number: '1930', debit_amount: 1650.5, credit_amount: 0, dimensions: { '1': 'NORR', '6': 'WEB' } },
  ]
  mockTrialBalance.mockResolvedValue(
    tb([
      // 3001: 1650.5 tagged + 100 untagged.
      tbRow({ account_number: '3001', period_credit: 1750.5, closing_credit: 1750.5 }),
      // 5010: 420 tagged + 60 untagged.
      tbRow({ account_number: '5010', account_name: 'Lokalhyra', account_class: 5, period_debit: 480, closing_debit: 480 }),
      tbRow({ account_number: '5420', account_name: 'Programvara', account_class: 5, period_debit: 80, closing_debit: 80 }),
      tbRow({ account_number: '1930', account_name: 'Bank', account_class: 1, period_debit: 1650.5, closing_debit: 1650.5 }),
    ]),
  )
})

describe('generateDimensionCross', () => {
  it('puts A down and B across, trims codes, and sums every cell to the resultatrapport', async () => {
    const report = await generateDimensionCross(supabase, 'company-1', 'period-1', { dimA: '1', dimB: '6' })

    expect(report.dim_a).toEqual({ sie_dim_no: '1', name: 'Region' })
    expect(report.dim_b).toEqual({ sie_dim_no: '6', name: 'Kanal' })
    expect(report.accounts).toEqual({ from: '3000', to: '8999' })
    expect(report.rows).toEqual([
      { code: 'NORR', name: 'Region Norr' },
      { code: 'SYD', name: 'Region Syd' },
      { code: null, name: null },
    ])
    expect(report.columns).toEqual([
      { code: 'TEL', name: 'Telefon' },
      { code: 'WEB', name: 'Webb' },
      { code: null, name: null },
    ])
    expect(report.cells).toEqual([
      [250.5, 1000, 0],
      [0, -120, 400],
      // The untagged x untagged cell: 3001 100 untagged, 5010 -60, 5420 -80 (a number is no tag).
      [0, -300, -40],
    ])
    expect(report.row_totals).toEqual([1250.5, 280, -340])
    expect(report.column_totals).toEqual([250.5, 580, 360])
    // +1750.5 - 480 - 80 = 1190.5; 1930 is no result account.
    expect(report.total).toBe(1190.5)

    mockResults = { fiscal_periods: [{ data: { id: 'period-1', ...PERIOD }, error: null }] }
    const rapport = await generateResultatrapport(supabase, 'company-1', 'period-1')
    expect(report.total).toBe(rapport.net_result_current)
    expect(report.period).toEqual(rapport.period)
  })

  it('swapping the axes transposes the matrix', async () => {
    const ab = await generateDimensionCross(supabase, 'company-1', 'period-1', { dimA: '1', dimB: '6' })
    mockResults = registry()
    const ba = await generateDimensionCross(supabase, 'company-1', 'period-1', { dimA: '6', dimB: '1' })
    expect(ba.rows).toEqual(ab.columns)
    expect(ba.columns).toEqual(ab.rows)
    expect(ba.cells).toEqual(ab.columns.map((_, j) => ab.rows.map((_, i) => ab.cells[i][j])))
    expect(ba.row_totals).toEqual(ab.column_totals)
    expect(ba.total).toBe(ab.total)
  })

  it('narrows to an account range, total and cells alike', async () => {
    const report = await generateDimensionCross(supabase, 'company-1', 'period-1', {
      dimA: '1', dimB: '6', accountFrom: '3000', accountTo: '3999',
    })
    expect(report.accounts).toEqual({ from: '3000', to: '3999' })
    expect(report.total).toBe(1750.5)
    expect(report.columns.map((c) => c.code)).toEqual(['TEL', 'WEB', null])
    expect(report.cells).toEqual([
      [250.5, 1000, 0],
      [0, 0, 400],
      [0, 0, 100],
    ])
    expect(dimensionCrossMeasureNote(report)).toBe('Belopp: konto 3000-3999')
  })

  it('drops the untagged row and column when every line carries both tags', async () => {
    lines = [{ account_number: '3001', debit_amount: 0, credit_amount: 500, dimensions: { '1': 'NORR', '6': 'WEB' } }]
    mockTrialBalance.mockResolvedValue(tb([tbRow({ account_number: '3001', period_credit: 500, closing_credit: 500 })]))
    const report = await generateDimensionCross(supabase, 'company-1', 'period-1', { dimA: '1', dimB: '6' })
    expect(report.rows.map((r) => r.code)).toEqual(['NORR'])
    expect(report.columns.map((c) => c.code)).toEqual(['WEB'])
    expect(report.cells).toEqual([[500]])
    expect(report.total).toBe(500)
  })

  it('rounds each cell to whole öre and keeps the grand total exact', async () => {
    lines = [
      { account_number: '3001', debit_amount: 0, credit_amount: 0.105, dimensions: { '1': 'NORR', '6': 'WEB' } },
      { account_number: '3001', debit_amount: 0, credit_amount: 0.105, dimensions: { '1': 'SYD', '6': 'WEB' } },
    ]
    mockTrialBalance.mockResolvedValue(tb([tbRow({ account_number: '3001', period_credit: 0.21, closing_credit: 0.21 })]))
    const report = await generateDimensionCross(supabase, 'company-1', 'period-1', { dimA: '1', dimB: '6' })
    // 0.105 rounds half away to 0.11 twice; the remainder takes the -0.01.
    expect(report.cells).toEqual([[0.11, 0], [0.11, 0], [0, -0.01]])
    expect(report.total).toBe(0.21)
    expect(report.row_totals.reduce((s, v) => s + v, 0)).toBeCloseTo(report.total, 10)
  })

  it('names a dimension the registry lacks by its number', async () => {
    mockResults = { fiscal_periods: [{ data: PERIOD, error: null }], dimensions: [{ data: [], error: null }] }
    const report = await generateDimensionCross(supabase, 'company-1', 'period-1', { dimA: '6', dimB: '9' })
    expect(report.dim_a.name).toBe('Projekt')
    expect(report.dim_b.name).toBe('Dimension 9')
    expect(report.rows.every((r) => r.name === null)).toBe(true)
  })

  it('says the report is not ready while its migration is not applied', async () => {
    rpcError = { code: 'PGRST202', message: 'Could not find the function public.get_dimension_cross_buckets' }
    await expect(generateDimensionCross(supabase, 'company-1', 'period-1', { dimA: '1', dimB: '6' })).rejects.toBeInstanceOf(
      DimensionCrossNotReadyError,
    )
  })

  it('refuses one dimension twice and a broken range before reading anything', async () => {
    await expect(generateDimensionCross(supabase, 'company-1', 'period-1', { dimA: '1', dimB: '1' })).rejects.toThrow()
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('dimensionCrossAxesError', () => {
  it.each([
    [{ dimA: '1', dimB: '6' }, null],
    [{ dimA: '1', dimB: '6', accountFrom: '4000', accountTo: '7999' }, null],
    [{ dimA: '1', dimB: '1' }, 'two'],
    [{ dimA: '0', dimB: '6' }, 'number'],
    [{ dimA: '1', dimB: '6', accountFrom: '4000' }, 'together'],
    [{ dimA: '1', dimB: '6', accountFrom: '2000', accountTo: '3999' }, 'range'],
    [{ dimA: '1', dimB: '6', accountFrom: '3000', accountTo: '9999' }, 'range'],
    [{ dimA: '1', dimB: '6', accountFrom: '4999', accountTo: '4000' }, 'order'],
    [{ dimA: '1', dimB: '6', accountFrom: '40', accountTo: '4000' }, 'digits'],
  ] as const)('%j', (axes, expected) => {
    const error = dimensionCrossAxesError(axes)
    if (expected === null) expect(error).toBeNull()
    else expect(error).toEqual(expect.any(String))
  })
})

describe('fetchDimensionCrossLines', () => {
  it('sends the cell trimmed, a blank code as untagged, and hands back the next cursor', async () => {
    pageAnswer = {
      lines: [
        {
          line_id: 'l1', journal_entry_id: 'e1', entry_date: '2026-03-02', voucher_series: 'A', voucher_number: 12,
          description: 'Bokning', line_description: null, account_number: '3001',
          debit_amount: '0.00', credit_amount: '4800.50', dimensions: { '1': 'NORR' },
        },
      ],
      has_more: true,
    }
    const page = await fetchDimensionCrossLines(supabase, 'company-1', 'period-1', {
      dimA: '1', codeA: ' NORR ', dimB: '6', codeB: '  ', fromDate: '2026-01-01',
    })
    expect(supabase.rpc).toHaveBeenCalledWith('get_dimension_cross_lines', expect.objectContaining({
      p_dim_a: '1', p_code_a: 'NORR', p_dim_b: '6', p_code_b: null, p_account_from: null, p_account_to: null,
      p_from_date: '2026-01-01', p_after_date: null, p_limit: 200,
    }))
    expect(page.lines[0].credit_amount).toBe(4800.5)
    expect(page.next).toEqual({ after_date: '2026-03-02', after_voucher: 12, after_line: 'l1' })

    pageAnswer = { lines: [], has_more: false }
    expect((await fetchDimensionCrossLines(supabase, 'company-1', 'period-1', { dimA: '1', codeA: null, dimB: '6', codeB: null })).next).toBeNull()
  })
})
