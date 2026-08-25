/**
 * Issue #1882: the Ingående balanser voucher was hardcoded to series A and
 * created BEFORE the file's vouchers, so it consumed the A series' next
 * number and shifted every A voucher one number higher than in the source
 * system. It must book in a caller-chosen series, defaulting to one the
 * file's own vouchers do not use.
 *
 * Also covers the orphan-IB guard: replace_sie_import deletes only
 * source_type='import' entries and clears the period's OB pointer, so a
 * prior import's IB voucher survives every replace cycle: without the
 * guard each re-import created another IB verifikat (a field report
 * accumulated five).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSIEImport } from '../sie-import'
import {
  DEFAULT_OPENING_BALANCE_SERIES,
  defaultOpeningBalanceSeries,
  defaultImportOpeningBalancesOn,
} from '../opening-balance-defaults'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import type { ParsedSIEFile, AccountMapping } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'ob-entry-1' })),
  replaceOpeningBalanceEntry: vi.fn(),
}))

vi.mock('@/lib/reports/imbalance-diagnosis', () => ({
  findUntransferredResults: vi.fn(async () => []),
}))

// --- Helpers (same routing-mock pattern as sie-import-derived-ib.test.ts) ---

type QueuedResult = { data?: unknown; error?: unknown; count?: number | null }

function buildRoutingSupabase(tableQueues: Record<string, QueuedResult[]>) {
  const queues = new Map<string, QueuedResult[]>(
    Object.entries(tableQueues).map(([k, v]) => [k, [...v]])
  )

  const makeChain = (result: { data: unknown; error: unknown; count: number | null }): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(result)
        }
        return (..._args: unknown[]) => makeChain(result)
      },
    }
    return new Proxy({}, handler)
  }

  const supabase = {
    from: (table: string) => {
      const next = queues.get(table)?.shift() ?? {}
      return makeChain({
        data: next.data ?? null,
        error: next.error ?? null,
        count: next.count ?? null,
      })
    },
    rpc: async () => ({ data: null, error: null }),
    storage: {
      from: () => ({ upload: async () => ({ error: null }) }),
    },
  }

  return supabase as unknown as SupabaseClient
}

function makeParsedFile(overrides?: Partial<ParsedSIEFile>): ParsedSIEFile {
  return {
    header: {
      sieType: 4,
      flagga: 0,
      program: 'TestProg',
      programVersion: '1.0',
      generatedDate: '2024-01-01',
      format: 'PC8',
      companyName: 'Serie AB',
      orgNumber: '5566778899',
      address: null,
      fiscalYears: [{ yearIndex: 0, start: '2024-01-01', end: '2024-12-31' }],
      currency: 'SEK',
      kontoPlanType: null,
    },
    accounts: [
      { number: '1930', name: 'Företagskonto' },
      { number: '2010', name: 'Eget kapital' },
    ],
    openingBalances: [
      { yearIndex: 0, account: '1930', amount: 5000 },
      { yearIndex: 0, account: '2010', amount: -5000 },
    ],
    closingBalances: [],
    resultBalances: [],
    dimensions: [],
    dimensionValues: [],
    vouchers: [],
    issues: [],
    stats: {
      totalAccounts: 2,
      totalVouchers: 0,
      totalTransactionLines: 0,
      fiscalYearStart: '2024-01-01',
      fiscalYearEnd: '2024-12-31',
    },
    ...overrides,
  }
}

function makeVoucher(series: string, number: number) {
  return {
    series,
    number,
    date: new Date(2024, 5, 1),
    description: `Voucher ${series}${number}`,
    lines: [
      { account: '1930', amount: 10 },
      { account: '2010', amount: -10 },
    ],
  }
}

function makeMapping(source: string, target: string): AccountMapping {
  return {
    sourceAccount: source,
    sourceName: `Account ${source}`,
    targetAccount: target,
    targetName: `Target ${target}`,
    confidence: 1,
    matchType: 'exact',
    isOverride: false,
  }
}

function standardQueues(): Record<string, QueuedResult[]> {
  return {
    sie_imports: [
      { data: null }, // checkDuplicateImport: no duplicate
      {}, // cleanupStaleImportRecords delete
      { data: { id: 'imp-1' } }, // createPendingImportRecord insert
      { data: null }, // checkDuplicatePeriodImport: no duplicate
    ],
    chart_of_accounts: [
      {
        data: [
          { account_number: '1930', account_name: 'Företagskonto' },
          { account_number: '2010', account_name: 'Eget kapital' },
        ],
      },
    ],
    fiscal_periods: [
      { data: { id: 'fp-1' } }, // find existing fiscal period
      { data: { opening_balances_set: false, opening_balance_entry_id: null } }, // IB-block check
    ],
    journal_entries: [
      { count: 0 }, // companyHasPriorActivity: first-ever import
      { data: [] }, // orphan-IB guard: no surviving IB voucher
    ],
  }
}

/** Lines matching makeParsedFile()'s IB: 1930 D 5000 / 2010 K 5000. */
function matchingOrphanLines(): QueuedResult {
  return {
    data: [
      { account_number: '1930', debit_amount: 5000, credit_amount: 0 },
      { account_number: '2010', debit_amount: 0, credit_amount: 5000 },
    ],
  }
}

const standardOptions = {
  filename: 'serie.se',
  fileContent: '#dummy',
  createFiscalPeriod: false,
  importOpeningBalances: true,
  // False so voucher batch insertion is skipped: the vouchers in these
  // fixtures exist only to exercise the IB default-series computation.
  importTransactions: false,
  updateAccountNames: false,
}

const standardMappings = [makeMapping('1930', '1930'), makeMapping('2010', '2010')]

// --- Tests ---

describe('opening-balance defaults helpers', () => {
  it('defaults to M and never A', () => {
    expect(DEFAULT_OPENING_BALANCE_SERIES).toBe('M')
    expect(defaultOpeningBalanceSeries([])).toBe('M')
    expect(defaultOpeningBalanceSeries(['A', 'B', 'F'])).toBe('M')
  })

  it('avoids series the file already uses', () => {
    expect(defaultOpeningBalanceSeries(['A', 'M'])).toBe('O')
    expect(defaultOpeningBalanceSeries(['m', ' o '])).toBe('P')
  })

  it('falls back to M when every candidate is taken', () => {
    const all = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
    expect(defaultOpeningBalanceSeries(all)).toBe('M')
  })

  it('IB toggle defaults on only for a first import with IB in the file', () => {
    expect(
      defaultImportOpeningBalancesOn({ hasOpeningBalances: true, existingIbEntryCount: 0 })
    ).toBe(true)
    expect(
      defaultImportOpeningBalancesOn({ hasOpeningBalances: true, existingIbEntryCount: 1 })
    ).toBe(false)
    expect(
      defaultImportOpeningBalancesOn({ hasOpeningBalances: false, existingIbEntryCount: 0 })
    ).toBe(false)
  })
})

describe('executeSIEImport: IB voucher series (issue #1882)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('books the IB voucher in the caller-chosen series', async () => {
    const result = await executeSIEImport(
      buildRoutingSupabase(standardQueues()),
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      { ...standardOptions, openingBalanceSeries: 'K' },
    )

    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)
    expect(createJournalEntry).toHaveBeenCalledTimes(1)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.source_type).toBe('opening_balance')
    expect(input.voucher_series).toBe('K')
  })

  it('defaults to M, not A, for a file whose vouchers use series A', async () => {
    const parsed = makeParsedFile({
      vouchers: [makeVoucher('A', 1), makeVoucher('A', 2)],
      stats: {
        totalAccounts: 2,
        totalVouchers: 2,
        totalTransactionLines: 4,
        fiscalYearStart: '2024-01-01',
        fiscalYearEnd: '2024-12-31',
      },
    })

    const result = await executeSIEImport(
      buildRoutingSupabase(standardQueues()),
      'company-1',
      'user-1',
      parsed,
      standardMappings,
      standardOptions,
    )

    expect(result.success).toBe(true)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.voucher_series).toBe('M')
  })

  it('moves off M when the file itself uses an M series', async () => {
    const parsed = makeParsedFile({
      vouchers: [makeVoucher('A', 1), makeVoucher('M', 1)],
      stats: {
        totalAccounts: 2,
        totalVouchers: 2,
        totalTransactionLines: 4,
        fiscalYearStart: '2024-01-01',
        fiscalYearEnd: '2024-12-31',
      },
    })

    const result = await executeSIEImport(
      buildRoutingSupabase(standardQueues()),
      'company-1',
      'user-1',
      parsed,
      standardMappings,
      standardOptions,
    )

    expect(result.success).toBe(true)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.voucher_series).toBe('O')
  })

  it('ignores a blank openingBalanceSeries option and falls back to the default', async () => {
    const result = await executeSIEImport(
      buildRoutingSupabase(standardQueues()),
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      { ...standardOptions, openingBalanceSeries: '  ' },
    )

    expect(result.success).toBe(true)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.voucher_series).toBe('M')
  })

  it('falls back to the default when openingBalanceSeries is not a string', async () => {
    const result = await executeSIEImport(
      buildRoutingSupabase(standardQueues()),
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      // Web execute and MCP accept untyped JSON: a non-string must not
      // crash mid-import (after the fiscal period is already created).
      { ...standardOptions, openingBalanceSeries: 123 as unknown as string },
    )

    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.voucher_series).toBe('M')
  })

  it('avoids the effective default series when the file has series-less vouchers', async () => {
    // Series-less #VER records resolve to options.voucherSeries at import
    // time, so an IB voucher in that series would shift their numbering:
    // the same #1882 pattern through the fallback.
    const parsed = makeParsedFile({
      vouchers: [makeVoucher('', 1), makeVoucher('', 2)],
      stats: {
        totalAccounts: 2,
        totalVouchers: 2,
        totalTransactionLines: 4,
        fiscalYearStart: '2024-01-01',
        fiscalYearEnd: '2024-12-31',
      },
    })

    const result = await executeSIEImport(
      buildRoutingSupabase(standardQueues()),
      'company-1',
      'user-1',
      parsed,
      standardMappings,
      { ...standardOptions, voucherSeries: 'M' },
    )

    expect(result.success).toBe(true)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.voucher_series).toBe('O')
  })

  it('warns when an explicitly chosen IB series collides with the file', async () => {
    const parsed = makeParsedFile({
      vouchers: [makeVoucher('A', 1)],
      stats: {
        totalAccounts: 2,
        totalVouchers: 1,
        totalTransactionLines: 2,
        fiscalYearStart: '2024-01-01',
        fiscalYearEnd: '2024-12-31',
      },
    })

    const result = await executeSIEImport(
      buildRoutingSupabase(standardQueues()),
      'company-1',
      'user-1',
      parsed,
      standardMappings,
      // importTransactions must be on for the shift to be real: the
      // warning is gated on it.
      { ...standardOptions, importTransactions: true, openingBalanceSeries: 'A' },
    )

    expect(result.warnings.join(' ')).toMatch(
      /Vald verifikationsserie för ingående balanser \(A\) används även av filens verifikationer/
    )
    // The choice is honored: the caller may know better.
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.voucher_series).toBe('A')
  })
})

describe('executeSIEImport: orphan-IB guard (issue #1882)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips IB creation and relinks the surviving voucher when one posted IB already exists', async () => {
    const queues = standardQueues()
    queues.journal_entries = [
      { count: 0 }, // companyHasPriorActivity: replace deleted all import entries
      { data: [{ id: 'orphan-ib-1' }] }, // orphan-IB guard: one survivor
    ]
    queues.journal_entry_lines = [matchingOrphanLines()]
    queues.fiscal_periods = [
      { data: { id: 'fp-1' } },
      { data: { opening_balances_set: false, opening_balance_entry_id: null } },
      {}, // linkOpeningBalanceEntryToPeriod update: ok
    ]

    const result = await executeSIEImport(
      buildRoutingSupabase(queues),
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(result.openingBalanceEntryId).toBeNull()
    const warnings = result.warnings.join(' ')
    expect(warnings).toMatch(/verifikation för ingående balanser finns redan i räkenskapsåret/)
    // Relinked: the survivor becomes the period's OB entry again, so
    // reports, year-end's duplicate-IB blocker, and the manual IB gate
    // all see it.
    expect(warnings).toMatch(/har kopplats som räkenskapsårets ingående balans/)
    // Amounts match the file: no stale-IB callout.
    expect(warnings).not.toMatch(/skiljer sig/)
    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('calls out a surviving IB whose amounts differ from the file', async () => {
    const queues = standardQueues()
    queues.journal_entries = [
      { count: 0 },
      { data: [{ id: 'orphan-ib-1' }] },
    ]
    // Stale orphan: 1930 D 4000 (file says 5000).
    queues.journal_entry_lines = [
      {
        data: [
          { account_number: '1930', debit_amount: 4000, credit_amount: 0 },
          { account_number: '2010', debit_amount: 0, credit_amount: 4000 },
        ],
      },
    ]
    queues.fiscal_periods = [
      { data: { id: 'fp-1' } },
      { data: { opening_balances_set: false, opening_balance_entry_id: null } },
      {}, // relink update: ok
    ]

    const result = await executeSIEImport(
      buildRoutingSupabase(queues),
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(createJournalEntry).not.toHaveBeenCalled()
    const warnings = result.warnings.join(' ')
    expect(warnings).toMatch(/skiljer sig från filens ingående balanser/)
    expect(warnings).toMatch(/Ångra \(storno\)/)
    expect(result.success).toBe(true)
  })

  it('skips without relinking when several posted IB vouchers exist', async () => {
    const queues = standardQueues()
    queues.journal_entries = [
      { count: 0 },
      { data: [{ id: 'orphan-ib-1' }, { id: 'orphan-ib-2' }] },
    ]

    const result = await executeSIEImport(
      buildRoutingSupabase(queues),
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(createJournalEntry).not.toHaveBeenCalled()
    const warnings = result.warnings.join(' ')
    expect(warnings).toMatch(/2 verifikationer för ingående balanser finns redan/)
    expect(warnings).not.toMatch(/har kopplats/)
    expect(result.success).toBe(true)
  })

  it('fails closed against duplication when the orphan check errors', async () => {
    const queues = standardQueues()
    queues.journal_entries = [
      { count: 0 },
      { error: { message: 'boom' } }, // orphan-IB guard query fails
    ]

    const result = await executeSIEImport(
      buildRoutingSupabase(queues),
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(result.openingBalanceEntryId).toBeNull()
    expect(result.warnings.join(' ')).toMatch(
      /det gick inte att kontrollera om en IB-verifikation redan finns/
    )
    expect(result.success).toBe(true)
  })

  it('still creates the IB voucher when no prior IB exists', async () => {
    const result = await executeSIEImport(
      buildRoutingSupabase(standardQueues()),
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(createJournalEntry).toHaveBeenCalledTimes(1)
    expect(result.openingBalanceEntryId).toBe('ob-entry-1')
    expect(result.success).toBe(true)
  })
})
