import { beforeEach, describe, expect, it } from 'vitest'

// The period's unlinked IB verifikat has its own tests
// (opening-balance/unlinked.test.ts, opening-balances.test.ts); here the
// year has none, so the queued journal reads stay the report's own.
vi.mock('@/lib/import/opening-balance/unlinked', () => ({
  findUnlinkedOpeningBalance: vi.fn(async () => null),
}))
import { createQueuedMockSupabase } from '@/tests/helpers'
import { parseSIEFile } from '@/lib/import/sie-parser'
import type { AccountMapping } from '@/lib/import/types'
import {
  compareOpeningBalances,
  continuityNotices,
  continuityWarnings,
  diagnoseCarriedForwardDifferences,
  diagnoseOpeningBalanceContinuity,
  fileOpeningBalanceByAccount,
  findSourceOpeningBalanceEdits,
} from '../sie-continuity'

// A continuation year whose source system edited two opening balances by hand
// (crm#1099): 500 moved onto 1730/2990 without a voucher, so #IB 0 no longer
// equals #UB -1. Invented amounts.
const SECOND_YEAR = [
  '#FLAGGA 0',
  '#FORMAT PC8',
  '#SIETYP 4',
  '#PROGRAM "Testprogram" 1.0',
  '#GEN 20260316',
  '#FNAMN "Testbolaget AB"',
  '#ORGNR 556677-8899',
  '#RAR 0 20190101 20191231',
  '#RAR -1 20180101 20181231',
  '#KONTO 1730 "Förutbetalda försäkringspremier"',
  '#KONTO 1930 "Företagskonto"',
  '#KONTO 2099 "Årets resultat"',
  '#KONTO 2990 "Övriga upplupna kostnader"',
  '#KONTO 3001 "Försäljning"',
  '#UB -1 1730 200.00',
  '#UB -1 1930 5000.00',
  '#UB -1 2099 -4200.00',
  '#UB -1 2990 -1000.00',
  '#IB 0 1730 700.00',
  '#IB 0 1930 5000.00',
  '#IB 0 2099 -4200.00',
  '#IB 0 2990 -1500.00',
  '#VER A 1 20190315 "Försäljning"',
  '{',
  '#TRANS 1930 {} 100.00',
  '#TRANS 3001 {} -100.00',
  '}',
].join('\n')

// The year the books end on: what an earlier import left carried forward.
const BOOKS_AFTER_FIRST_YEAR = [
  { account_number: '1730', debit: 200, credit: 0 },
  { account_number: '1930', debit: 5000, credit: 0 },
  { account_number: '2099', debit: 0, credit: 4200 },
  { account_number: '2990', debit: 0, credit: 1000 },
]

const identity = (accounts: string[]): AccountMapping[] =>
  accounts.map((account) => ({
    sourceAccount: account,
    sourceName: account,
    targetAccount: account,
    targetName: account,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
  })) as AccountMapping[]

const MAPPINGS = identity(['1730', '1930', '2099', '2990', '3001'])

describe('findSourceOpeningBalanceEdits', () => {
  it('lists the accounts where #IB 0 differs from the file\'s own #UB -1', () => {
    expect(findSourceOpeningBalanceEdits(parseSIEFile(SECOND_YEAR))).toEqual([
      { account: '1730', previousClosing: 200, opening: 700, difference: 500 },
      { account: '2990', previousClosing: -1000, opening: -1500, difference: -500 },
    ])
  })

  it('treats a missing record as a zero balance', () => {
    const parsed = parseSIEFile(SECOND_YEAR.replace('#UB -1 1730 200.00\n', ''))
    expect(findSourceOpeningBalanceEdits(parsed)[0]).toEqual({
      account: '1730', previousClosing: 0, opening: 700, difference: 700,
    })
  })

  it('has nothing to compare in a first year without #UB -1', () => {
    const firstYear = SECOND_YEAR.split('\n').filter((line) => !line.startsWith('#UB -1')).join('\n')
    expect(findSourceOpeningBalanceEdits(parseSIEFile(firstYear))).toEqual([])
  })
})

describe('compareOpeningBalances', () => {
  it('reports balance-sheet accounts that differ, books minus file', () => {
    const file = fileOpeningBalanceByAccount(
      [
        { account: '1730', amount: 700, yearIndex: 0 },
        { account: '1930', amount: 5000, yearIndex: 0 },
        { account: '3001', amount: 50, yearIndex: 0 },
      ],
      MAPPINGS,
    )
    const books = new Map([
      ['1730', { debit: 200, credit: 0 }],
      ['1930', { debit: 5000, credit: 0 }],
      ['2440', { debit: 0, credit: 300 }],
    ])
    expect(compareOpeningBalances(file, books)).toEqual([
      { account: '1730', file: 700, books: 200, difference: -500 },
      { account: '2440', file: 0, books: -300, difference: -300 },
    ])
  })

  it('sums several source accounts mapped onto one company account and skips unmapped ones', () => {
    const mappings = [
      ...identity(['1930']),
      { ...identity(['1931'])[0], targetAccount: '1930' },
      { ...identity(['1999'])[0], targetAccount: null },
    ] as AccountMapping[]
    const file = fileOpeningBalanceByAccount(
      [
        { account: '1930', amount: 100.1 },
        { account: '1931', amount: 0.2 },
        { account: '1999', amount: 9 },
        { account: '1930', amount: 7, yearIndex: -1 },
      ],
      mappings,
    )
    expect([...file]).toEqual([['1930', 100.3]])
  })
})

describe('diagnoseOpeningBalanceContinuity', () => {
  let supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']
  let enqueueMany: ReturnType<typeof createQueuedMockSupabase>['enqueueMany']
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    mock = createQueuedMockSupabase()
    supabase = mock.supabase
    enqueueMany = mock.enqueueMany
  })

  it('shows where the carried-forward balance will differ from the file', async () => {
    enqueueMany([
      { data: null }, // the year has no IB verifikat of its own
      { data: [{ id: 'je-2018' }] },
      { data: BOOKS_AFTER_FIRST_YEAR },
      { data: [{ id: 'p2018', name: 'Räkenskapsår 2018', period_start: '2018-01-01', period_end: '2018-12-31' }] },
    ])

    const result = await diagnoseOpeningBalanceContinuity(supabase as never, 'company-1', parseSIEFile(SECOND_YEAR), MAPPINGS)

    expect(result).toEqual({
      carriedForward: true,
      differences: [
        { account: '1730', file: 700, books: 200, difference: -500 },
        { account: '2990', file: -1500, books: -1000, difference: 500 },
      ],
      sourceEdits: [
        { account: '1730', previousClosing: 200, opening: 700, difference: 500 },
        { account: '2990', previousClosing: -1000, opening: -1500, difference: -500 },
      ],
      missingYears: [],
      noVouchers: false,
    })
    // The same test start_sie_import_job seals as prior_activity.
    expect(mock.findCall('journal_entries', 'eq')).toEqual(['company_id', 'company-1'])
    expect(mock.findCalls('journal_entries', 'eq')).toContainEqual(['status', 'posted'])
    expect(mock.findCall('journal_entries', 'not')).toEqual(['source_type', 'in', '(opening_balance,storno)'])
    expect(mock.findCall('journal_entries', 'lte')).toEqual(['entry_date', '2019-12-31'])
    expect(supabase.rpc).toHaveBeenCalledWith('compute_prior_opening_balances', {
      p_company_id: 'company-1',
      p_period_start: '2019-01-01',
    })
  })

  it('does not count the import a replacement supersedes', async () => {
    enqueueMany([{ data: null }, { data: [] }, { data: [] }])
    await diagnoseOpeningBalanceContinuity(supabase as never, 'company-1', parseSIEFile(SECOND_YEAR), MAPPINGS, {
      replacesImportId: 'import-old',
    })
    expect(mock.findCall('journal_entries', 'or')).toEqual(['import_batch_id.is.null,import_batch_id.neq.import-old'])
  })

  it('books the file\'s IB when the company has no earlier activity, and only explains the source edits', async () => {
    enqueueMany([{ data: null }, { data: [] }, { data: [] }])

    const result = await diagnoseOpeningBalanceContinuity(supabase as never, 'company-1', parseSIEFile(SECOND_YEAR), MAPPINGS)

    expect(result?.carriedForward).toBe(false)
    expect(result?.differences).toEqual([])
    expect(result?.sourceEdits).toHaveLength(2)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('names a year missing between the books and the file', async () => {
    enqueueMany([
      { data: null }, // the year has no IB verifikat of its own
      { data: [{ id: 'je-2017' }] },
      { data: [] },
      { data: [{ id: 'p2017', name: 'Räkenskapsår 2017', period_start: '2017-01-01', period_end: '2017-12-31' }] },
    ])

    const result = await diagnoseOpeningBalanceContinuity(supabase as never, 'company-1', parseSIEFile(SECOND_YEAR), MAPPINGS)

    expect(result?.missingYears).toEqual([{ from: '2018-01-01', to: '2018-12-31' }])
  })

  it('flags an ended year whose file holds no vouchers', async () => {
    const empty = SECOND_YEAR.split('\n#VER')[0]
    enqueueMany([{ data: null }, { data: [] }, { data: [] }])

    const result = await diagnoseOpeningBalanceContinuity(supabase as never, 'company-1', parseSIEFile(empty), MAPPINGS)

    expect(result?.noVouchers).toBe(true)
  })

  // crm#1272: a year with its own IB verifikat (booked by hand, by the
  // year-end close) opens on it; the import never books the file's IB on top.
  const BOOKED_IB = { id: 'je-ib', voucher_series: 'A', voucher_number: 1, status: 'posted', import_batch_id: null }
  const ibLines = (credit2990: number) => [
    { id: 'l1', journal_entry_id: 'je-ib', account_number: '1730', debit_amount: 700, credit_amount: 0 },
    { id: 'l2', journal_entry_id: 'je-ib', account_number: '1930', debit_amount: 5000, credit_amount: 0 },
    { id: 'l3', journal_entry_id: 'je-ib', account_number: '2099', debit_amount: 0, credit_amount: 4200 },
    { id: 'l4', journal_entry_id: 'je-ib', account_number: '2990', debit_amount: 0, credit_amount: credit2990 },
  ]

  it('compares the file with the year\'s booked IB verifikat: equal, nothing to report', async () => {
    enqueueMany([
      { data: { opening_balance_entry_id: 'je-ib' } },
      { data: BOOKED_IB },
      { data: [{ id: 'je-ib' }] },
      { data: ibLines(1500) },
      { data: [] },
    ])

    const result = await diagnoseOpeningBalanceContinuity(supabase as never, 'company-1', parseSIEFile(SECOND_YEAR), MAPPINGS)

    expect(result).toMatchObject({
      carriedForward: true,
      bookedOpeningBalance: { entryId: 'je-ib', voucher: 'A1' },
      differences: [],
    })
    // The year opens on the verifikat, not on what earlier years carry.
    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(mock.findCall('fiscal_periods', 'lte')).toEqual(['period_start', '2019-01-01'])
  })

  it('names the accounts where the booked IB differs from the file', async () => {
    enqueueMany([
      { data: { opening_balance_entry_id: 'je-ib' } },
      { data: BOOKED_IB },
      { data: [{ id: 'je-ib' }] },
      { data: ibLines(1000) },
      { data: [] },
    ])

    const result = await diagnoseOpeningBalanceContinuity(supabase as never, 'company-1', parseSIEFile(SECOND_YEAR), MAPPINGS)

    expect(result?.differences).toEqual([{ account: '2990', file: -1500, books: -1000, difference: 500 }])
  })

  it('does not compare with an IB the replaced import booked', async () => {
    enqueueMany([
      { data: { opening_balance_entry_id: 'je-ib' } },
      { data: { ...BOOKED_IB, import_batch_id: 'import-old' } },
      { data: [] },
      { data: [] },
    ])

    const result = await diagnoseOpeningBalanceContinuity(supabase as never, 'company-1', parseSIEFile(SECOND_YEAR), MAPPINGS, {
      replacesImportId: 'import-old',
    })

    expect(result?.bookedOpeningBalance).toBeUndefined()
    expect(result?.carriedForward).toBe(false)
  })

  it('never fails the preview: a failed read returns null', async () => {
    enqueueMany([{ error: { message: 'boom' } }])
    await expect(
      diagnoseOpeningBalanceContinuity(supabase as never, 'company-1', parseSIEFile(SECOND_YEAR), MAPPINGS),
    ).resolves.toBeNull()
  })
})

describe('diagnoseCarriedForwardDifferences', () => {
  it('compares the IB a job manifest stored with the books after the import', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: BOOKS_AFTER_FIRST_YEAR }])

    const differences = await diagnoseCarriedForwardDifferences(
      supabase as never,
      'company-1',
      '2019-01-01',
      [
        { account: '1730', amount: 700, yearIndex: 0 },
        { account: '1930', amount: 5000, yearIndex: 0 },
        { account: '2099', amount: -4200, yearIndex: 0 },
        { account: '2990', amount: -1500, yearIndex: 0 },
        { account: 'bad', amount: 'x' },
      ],
      MAPPINGS,
    )

    expect(differences.map((row) => [row.account, row.difference])).toEqual([
      ['1730', -500],
      ['2990', 500],
    ])
  })

  it('compares with the year\'s own IB verifikat when the year has one (crm#1272)', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: { opening_balance_entry_id: 'je-ib' } },
      { data: { id: 'je-ib', voucher_series: 'A', voucher_number: 1, status: 'posted', import_batch_id: null } },
      { data: [{ id: 'je-ib' }] },
      { data: [{ id: 'l1', journal_entry_id: 'je-ib', account_number: '1930', debit_amount: 5000, credit_amount: 0 }] },
    ])

    const differences = await diagnoseCarriedForwardDifferences(
      supabase as never, 'company-1', '2019-01-01', [{ account: '1930', amount: 5000, yearIndex: 0 }], MAPPINGS, 'fp-2019',
    )

    expect(differences).toEqual([])
    expect(findCall('fiscal_periods', 'eq')).toEqual(['company_id', 'company-1'])
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('costs the notice, not the import, when the read fails', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ error: { message: 'boom' } }])
    await expect(
      diagnoseCarriedForwardDifferences(supabase as never, 'company-1', '2019-01-01', [{ account: '1930', amount: 1 }], MAPPINGS),
    ).resolves.toEqual([])
  })
})

describe('continuity texts', () => {
  const differences = [
    { account: '1730', file: 700, books: 200, difference: -500 },
    { account: '2990', file: -1500, books: -1000, difference: 500 },
  ]

  it('emits one action notice with the count and the summed difference', () => {
    const { notices, warnings } = continuityNotices({ differences, noVouchers: null })
    expect(notices).toEqual([
      { code: 'sie_ib_differs_from_file', severity: 'action', params: { count: 2, amount: expect.stringContaining('1') } },
    ])
    expect(warnings[0]).toContain('2 konton')
  })

  it('says nothing when the file and the books agree', () => {
    expect(continuityNotices({ differences: [], noVouchers: null })).toEqual({ warnings: [], notices: [] })
  })

  it('says the year opens on its booked IB when it has one (crm#1272)', () => {
    const lines = continuityWarnings(
      { carriedForward: true, bookedOpeningBalance: { entryId: 'je-ib', voucher: 'A1' }, differences, sourceEdits: [], missingYears: [], noVouchers: false },
      { start: '2019-01-01', end: '2019-12-31' },
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('verifikation A1')
    expect(lines[0]).toContain('1730')
    expect(lines[0]).not.toContain('föregående års utgående balans')
  })

  it('warns before import with the accounts that differ', () => {
    const lines = continuityWarnings(
      { carriedForward: true, differences, sourceEdits: [], missingYears: [{ from: '2018-01-01', to: '2018-12-31' }], noVouchers: true },
      { start: '2019-01-01', end: '2019-12-31' },
    )
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('2018-01-01 till 2018-12-31')
    expect(lines[1]).toContain('1730')
    expect(lines[2]).toContain('inga verifikationer')
  })
})
