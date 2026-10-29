/**
 * The append planner (issue #108): one verdict per file voucher, read from
 * the books (sie_append_plan, its rule pinned in tests/pg/sie-append-import),
 * and what the planner makes of it: what is added, what refuses the whole
 * append, what only warns. The books are a scripted Supabase double.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/vat/filing-record-store', () => ({ listVatFilings: vi.fn() }))
vi.mock('@/lib/company/entity-type', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/entity-type')>()),
  resolveCompanyEntityType: vi.fn(async () => 'aktiebolag'),
}))
vi.mock('../sie-continuity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sie-continuity')>()),
  appendOpeningBalanceDifferences: vi.fn(async () => []),
}))

import { listVatFilings } from '@/lib/vat/filing-record-store'
import { appendOpeningBalanceDifferences } from '../sie-continuity'
import { parseSIEFile } from '../sie-parser'
import {
  appendConflictRefusal, appendVoucherImbalance, invalidSkippedVouchers, planSIEAppend,
  selectSIEAppendEntries, type SIEAppendVerdict, type SIEAppendVerdictRow,
} from '../sie-append'
import type { SIEPreparedEntry } from '../sie-job-contract'
import { isYearEndAccount } from '@/lib/bookkeeping/bas-data/result-accounts'
import type { AccountMapping } from '../types'

const ACCOUNTS = ['1930', '3001', '6110', '2890', '8999', '2099', '3740']
const mappings: AccountMapping[] = ACCOUNTS.map((number) => ({
  sourceAccount: number, targetAccount: number, sourceName: 'Konto', targetName: 'Konto',
  confidence: 1, matchType: 'exact', isOverride: false,
}))

function ver(series: string, number: string, date: string, text: string, lines: Array<[string, string]>): string[] {
  return [`#VER ${series} ${number} ${date} "${text}"`, '{', ...lines.map(([account, amount]) => `#TRANS ${account} {} ${amount}`), '}']
}

function sie(...vouchers: string[][]): string {
  return ['#FLAGGA 0', '#PROGRAM "Fortnox" "3.0"', '#SIETYP 4', '#RAR 0 20260101 20261231', ...vouchers.flat()].join('\n')
}

const A1 = ver('A', '1', '20260304', 'Faktura 1', [['1930', '100.00'], ['3001', '-100.00']])
const A2 = ver('A', '2', '20260305', 'Faktura 2', [['1930', '200.00'], ['3001', '-200.00']])
const CARD = ver('""', '""', '20260306', 'Kortköp', [['6110', '50.00'], ['2890', '-50.00']])
const K1 = ver('K', '1', '20260307', 'Kort', [['6110', '30.00'], ['2890', '-30.00']])

interface Books {
  period?: Record<string, unknown> | null
  base?: string | null
  verdicts?: Record<string, SIEAppendVerdict>
  series?: string[]
  lockedThrough?: string | null
  nextYear?: Record<string, unknown> | null
}

const OPEN_YEAR = { id: 'period-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: false,
  locked_at: null, closed_externally: null, closing_entry_id: null }

let planRequests: Array<Record<string, unknown>> = []

/** The books, answered per table; sie_append_plan answers by sourceId. */
function books(config: Books = {}): SupabaseClient {
  const mock = createTableMockSupabase({
    fiscal_periods: (calls) => calls.some((c) => c.method === 'gt')
      ? { data: config.nextYear ?? null }
      : { data: config.period === undefined ? OPEN_YEAR : config.period },
    sie_imports: { data: config.base === null ? null : { id: config.base ?? 'base-import' } },
    chart_of_accounts: { data: ACCOUNTS.map((n) => ({ id: `acc-${n}`, account_number: n })) },
    voucher_sequences: { data: (config.series ?? ['A']).map((s) => ({ voucher_series: s })) },
    company_settings: { data: { bookkeeping_locked_through: config.lockedThrough ?? null } },
    'rpc:sie_append_plan': () => {
      const args = mock.findCalls('rpc:sie_append_plan', 'rpc').at(-1)![0] as Record<string, unknown>
      planRequests.push(args)
      return {
        data: (args.p_entries as SIEPreparedEntry[]).map((entry) => {
          const verdict = config.verdicts?.[entry.sourceId] ?? 'new'
          return { sourceOrdinal: entry.sourceOrdinal, verdict, entryId: verdict === 'new' ? null : `entry-${entry.sourceId}`,
            voucher: verdict === 'new' ? null : entry.sourceId }
        }),
      }
    },
  })
  return mock.supabase as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
  planRequests = []
  vi.mocked(listVatFilings).mockResolvedValue([])
})

describe('planSIEAppend', () => {
  it('adds only what the books do not hold, and reads source numbers within the file\'s program', async () => {
    const plan = await planSIEAppend(books({ verdicts: { A1: 'present' } }), 'company-1', parseSIEFile(sie(A1, A2)), mappings)
    expect(plan.refusal).toBeNull()
    expect(plan).toMatchObject({ fiscalPeriodId: 'period-2026', baseImportId: 'base-import' })
    expect(plan.counts).toEqual({ total: 2, present: 1, conflicts: 0, possibleDuplicates: 0, new: 1, toAdd: 1 })
    expect(plan.vouchers.map((v) => [v.sourceId, v.verdict, v.amount])).toEqual([['A2', 'new', 200]])
    expect(planRequests[0]).toMatchObject({ p_company_id: 'company-1', p_period_id: 'period-2026', p_source_program: 'Fortnox' })
  })

  it('skips a possible duplicate by default and books it when the user includes it', async () => {
    const parsed = () => parseSIEFile(sie(A1, CARD))
    const config = { verdicts: { A1: 'present', '#2': 'possible_duplicate' } as Record<string, SIEAppendVerdict> }
    const skipped = await planSIEAppend(books(config), 'company-1', parsed(), mappings)
    expect(skipped.refusal?.code).toBe('SIE_IMPORT_APPEND_NOTHING_NEW')
    expect(skipped.refusal?.message).toContain('1 ser ut som dubbletter')
    const included = await planSIEAppend(books(config), 'company-1', parsed(), mappings, { includePossibleDuplicates: true })
    expect(included.refusal).toBeNull()
    expect(included.counts).toMatchObject({ possibleDuplicates: 1, toAdd: 1 })
  })

  it('refuses the whole append when a booked voucher changed, naming it', async () => {
    const plan = await planSIEAppend(books({ verdicts: { A1: 'conflict' } }), 'company-1', parseSIEFile(sie(A1, A2)), mappings)
    expect(plan.refusal?.code).toBe('SIE_IMPORT_APPEND_CONFLICT')
    expect(plan.refusal?.message).toContain('A1')
    expect(plan.refusal?.details).toEqual({ conflicts: [{ sourceId: 'A1', voucher: 'A1' }] })
  })

  it('refuses a file whose #IB differs from what the year opens on', async () => {
    vi.mocked(appendOpeningBalanceDifferences).mockResolvedValueOnce([{ account: '1930', file: 500, books: 400, difference: -100 }])
    const withIb = sie(A2).replace('#RAR 0 20260101 20261231', '#RAR 0 20260101 20261231\n#IB 0 1930 500.00\n#IB 0 2099 -500.00')
    const plan = await planSIEAppend(books(), 'company-1', parseSIEFile(withIb), mappings)
    expect(plan.refusal?.code).toBe('SIE_IMPORT_APPEND_OPENING_BALANCE_DIFFERS')
    expect(plan.refusal?.message).toContain('1930 (filen 500, bokfört 400)')
  })

  it('is strict about balance: a voucher 0.50 off refuses, where the import books 3740 öresutjämning', async () => {
    const off = ver('A', '3', '20260308', 'Avrundad', [['1930', '100.50'], ['3001', '-100.00']])
    const plan = await planSIEAppend(books(), 'company-1', parseSIEFile(sie(off)), mappings)
    expect(plan.refusal?.code).toBe('SIE_IMPORT_APPEND_INVALID_VOUCHERS')
    expect(plan.refusal?.message).toContain('A3')
  })

  it('refuses an unmapped account in a new voucher', async () => {
    const plan = await planSIEAppend(books(), 'company-1', parseSIEFile(sie(A2)),
      mappings.filter((m) => m.sourceAccount !== '3001'))
    expect(plan.refusal?.code).toBe('SIE_IMPORT_APPEND_INVALID_VOUCHERS')
    expect(plan.refusal?.message).toContain('konton utan mappning: A2')
  })

  it('refuses a closed or locked year with the import\'s own sentence', async () => {
    const plan = await planSIEAppend(books({ period: { ...OPEN_YEAR, locked_at: '2026-06-30T00:00:00Z' } }), 'company-1',
      parseSIEFile(sie(A2)), mappings)
    expect(plan.refusal?.code).toBe('SIE_IMPORT_PERIOD_LOCKED')
    expect(plan.refusal?.message).toContain('är låst')
    expect(planRequests).toHaveLength(0)
  })

  it('refuses a new voucher behind the company lock date', async () => {
    const plan = await planSIEAppend(books({ lockedThrough: '2026-03-31' }), 'company-1', parseSIEFile(sie(A2)), mappings)
    expect(plan.refusal?.code).toBe('SIE_IMPORT_PERIOD_LOCKED')
    expect(plan.refusal?.message).toContain('låst t.o.m. 2026-03-31')
  })

  it('refuses a year without an import to add to', async () => {
    const plan = await planSIEAppend(books({ base: null }), 'company-1', parseSIEFile(sie(A2)), mappings)
    expect(plan.refusal?.code).toBe('SIE_IMPORT_APPEND_NO_BASE')
    expect(planRequests).toHaveLength(0)
  })

  it('maps a series the year lacks and lists the year\'s own', async () => {
    const plan = await planSIEAppend(books({ series: ['A', 'B'] }), 'company-1', parseSIEFile(sie(A2, K1)), mappings,
      { seriesMap: { K: 'A' } })
    expect(plan.series).toEqual([
      { source: 'A', target: 'A', exists: true, vouchers: 1 },
      { source: 'K', target: 'A', exists: false, vouchers: 1 },
    ])
    expect(plan.yearSeries).toEqual(['A', 'B'])
    expect(plan.vouchers.find((v) => v.sourceId === 'K1')?.series).toBe('A')
  })

  it('warns about a filed VAT period and about year-end vouchers while next year has a posted IB', async () => {
    vi.mocked(listVatFilings).mockResolvedValue([{ tax_period: '2026-03', period_start: '2026-03-01', period_end: '2026-03-31' }] as never)
    const closing = ver('A', '9', '20261231', 'Årets resultat', [['8999', '100.00'], ['2099', '-100.00']])
    const plan = await planSIEAppend(books({ nextYear: { id: 'p-2027', name: '2027', opening_balance_entry_id: 'ib-2027' } }),
      'company-1', parseSIEFile(sie(A2, closing)), mappings)
    expect(plan.refusal).toBeNull()
    expect(plan.vouchers.map((v) => [v.sourceId, v.yearEnd])).toEqual([['A2', false], ['A9', true]])
    expect(plan.warnings).toHaveLength(2)
    expect(plan.warnings[0]).toContain('Momsdeklarationen för 2026-03 är redan inlämnad')
    expect(plan.warnings[1]).toContain('Räkenskapsåret 2027 har redan en bokförd ingående balans')
  })
})

describe('selectSIEAppendEntries', () => {
  const entry = (sourceOrdinal: number, sourceId: string, series = 'A') =>
    ({ sourceOrdinal, sourceId, series, lines: [] }) as unknown as SIEPreparedEntry
  const row = (sourceOrdinal: number, verdict: SIEAppendVerdict): SIEAppendVerdictRow =>
    ({ sourceOrdinal, verdict, entryId: null, voucher: verdict === 'new' ? null : `A${sourceOrdinal}` })
  const balanced = { lines: [{ account: '1930', amount: 10 }, { account: '3001', amount: -10 }] }
  const map = new Map([['1930', '1930'], ['3001', '3001']])

  it('applies each verdict and the series map', () => {
    const verdicts = new Map([[0, row(0, 'present')], [1, row(1, 'conflict')], [2, row(2, 'possible_duplicate')], [3, row(3, 'new')]])
    const result = selectSIEAppendEntries([entry(0, 'A1'), entry(1, 'A2'), entry(2, 'B#3'), entry(3, 'K4', 'K')], verdicts,
      () => balanced as never, map, { seriesMap: { K: 'A' } })
    expect(result.present).toBe(1)
    expect(result.conflicts).toEqual([{ sourceId: 'A2', voucher: 'A1' }])
    expect(result.possibleDuplicatesSkipped).toBe(1)
    expect(result.entries.map((e) => [e.sourceId, e.series])).toEqual([['K4', 'A']])
  })

  it('throws when the books gave no verdict for an entry', () => {
    expect(() => selectSIEAppendEntries([entry(0, 'A1')], new Map(), () => balanced as never, map, {})).toThrow(/no verdict/)
  })
})

describe('helpers', () => {
  it('measures a voucher\'s own balance in öre, mapped lines only', () => {
    const map = new Map([['1930', '1930'], ['3001', '3001']])
    expect(appendVoucherImbalance({ lines: [{ account: '1930', amount: 0.1 }, { account: '3001', amount: 0.2 },
      { account: '3001', amount: -0.3 }] } as never, map)).toBe(0)
    expect(appendVoucherImbalance({ lines: [{ account: '1930', amount: 100.5 }, { account: '3001', amount: -100 }] } as never, map)).toBe(0.5)
  })

  it('knows the year-end accounts: 88xx, 89xx and the form\'s result account', () => {
    expect(['8811', '8999', '2099', '1930', '2098'].map((a) => isYearEndAccount(a, '2099'))).toEqual([true, true, true, false, false])
  })

  it('keeps an unmapped or unbalanced skipped voucher, never an empty one', () => {
    expect(invalidSkippedVouchers([
      { voucherId: 'A1', date: '2026-01-01', description: '', reason: 'unmapped' },
      { voucherId: 'A2', date: '2026-01-01', description: '', reason: 'single_line' },
      { voucherId: 'A3', date: '2026-01-01', description: '', reason: 'zero_lines' },
    ])).toEqual([{ sourceId: 'A1', reason: 'unmapped' }, { sourceId: 'A2', reason: 'unbalanced' }])
  })

  it('names at most ten vouchers in a refusal', () => {
    const conflicts = Array.from({ length: 12 }, (_, i) => ({ sourceId: `A${i + 1}`, voucher: `A${i + 1}` }))
    expect(appendConflictRefusal(conflicts).message).toContain('A10 och 2 till')
  })
})
