/**
 * Full-flow regression suite for issue #675.
 *
 * Some systems export SIE files without current-year #IB 0 records: the
 * opening balances exist only implicitly via the SIE continuity invariant
 * IB(year 0) = UB(year -1). executeSIEImport must derive the IB from the
 * file's #UB -1 records, create a real opening-balance entry whose voucher
 * text documents the derivation, and warn the user.
 *
 * The make-or-break line is the gate in executeSIEImport: it must open on
 * the EFFECTIVE opening balances (getEffectiveOpeningBalances), not on raw
 * parsed.openingBalances: the raw set is empty for these files.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSIEImport } from '../sie-import'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { findUntransferredResults } from '@/lib/reports/imbalance-diagnosis'
import type { ParsedSIEFile, AccountMapping } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'ob-entry-1' })),
  reverseEntry: vi.fn(),
}))

vi.mock('@/lib/reports/imbalance-diagnosis', () => ({
  findUntransferredResults: vi.fn(async () => []),
}))

// --- Helpers ---

type QueuedResult = { data?: unknown; error?: unknown; count?: number | null }

/**
 * Table-routing supabase mock: each table has its own FIFO of results
 * (consumed per .from(table) call), falling back to { data: null, error:
 * null } when the queue is empty. Order-independent across tables, so the
 * mock doesn't break when an unrelated query is added elsewhere in the flow.
 */
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
      companyName: 'Continuity AB',
      orgNumber: '5566778899',
      address: null,
      fiscalYears: [
        { yearIndex: 0, start: '2024-01-01', end: '2024-12-31' },
        { yearIndex: -1, start: '2023-01-01', end: '2023-12-31' },
      ],
      currency: 'SEK',
      kontoPlanType: null,
    },
    accounts: [
      { number: '1930', name: 'Företagskonto' },
      { number: '2010', name: 'Eget kapital' },
    ],
    // Issue #675 shape: no #IB 0 at all: only prior-year IB/UB and current UB.
    openingBalances: [{ yearIndex: -1, account: '1930', amount: 9483.08 }],
    closingBalances: [
      { yearIndex: -1, account: '1930', amount: 37400.78 },
      { yearIndex: -1, account: '2010', amount: -37400.78 },
      { yearIndex: 0, account: '1930', amount: 160406.0 },
      { yearIndex: 0, account: '2010', amount: -160406.0 },
    ],
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

function standardQueues() {
  return {
    sie_imports: [
      { data: null }, // checkDuplicateImport: no duplicate
      {}, // cleanupStaleImportRecords delete
      { data: { id: 'imp-1' } }, // createPendingImportRecord insert
      { data: null }, // checkDuplicatePeriodImport: no duplicate
      // finalizeImportRecord updates ride on defaults
    ],
    chart_of_accounts: [
      {
        // syncMappedAccounts paged fetch: both accounts already exist
        data: [
          { account_number: '1930', account_name: 'Företagskonto' },
          { account_number: '2010', account_name: 'Eget kapital' },
        ],
      },
    ],
    fiscal_periods: [
      { data: { id: 'fp-1' } }, // find existing fiscal period
      { data: { opening_balances_set: false, opening_balance_entry_id: null } }, // IB-block check
      // link update + resync next-period lookup ride on defaults (null)
    ],
    journal_entries: [
      { count: 0 }, // companyHasPriorActivity: first-ever import
    ],
  }
}

const standardOptions = {
  filename: 'continuity.se',
  fileContent: '#dummy',
  createFiscalPeriod: false,
  importOpeningBalances: true,
  importTransactions: true,
  updateAccountNames: false,
}

const standardMappings = [makeMapping('1930', '1930'), makeMapping('2010', '2010')]

// --- Tests ---

describe('executeSIEImport: derived IB from #UB -1 (issue #675)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates the opening-balance entry from #UB -1 when #IB 0 is missing', async () => {
    const supabase = buildRoutingSupabase(standardQueues())

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(result.errors).toEqual([])
    expect(result.success).toBe(true)
    expect(result.openingBalanceEntryId).toBe('ob-entry-1')
    expect(result.journalEntriesCreated).toBe(1)
    expect(result.warnings.join(' ')).toMatch(/kontinuitetsprincipen/)

    expect(createJournalEntry).toHaveBeenCalledTimes(1)
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.source_type).toBe('opening_balance')
    expect(input.fiscal_period_id).toBe('fp-1')
    expect(input.entry_date).toBe('2024-01-01')
    expect(input.description).toBe(
      'Ingående balanser från SIE-import (härledda från föregående års utgående balans)'
    )
    expect(input.lines).toEqual([
      { account_number: '1930', debit_amount: 37400.78, credit_amount: 0, line_description: 'IB 1930' },
      { account_number: '2010', debit_amount: 0, credit_amount: 37400.78, line_description: 'IB 2010' },
    ])
  })

  it('uses the plain description and no continuity warning for explicit #IB 0', async () => {
    const supabase = buildRoutingSupabase(standardQueues())
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1930', amount: 37400.78 },
        { yearIndex: 0, account: '2010', amount: -37400.78 },
      ],
    })

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      parsed,
      standardMappings,
      standardOptions,
    )

    expect(result.success).toBe(true)
    expect(result.warnings.join(' ')).not.toMatch(/kontinuitetsprincipen/)

    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.description).toBe('Ingående balanser från SIE-import')
  })

  it('respects the continuation guard: no derived IB when the company has prior activity', async () => {
    const queues = standardQueues()
    queues.journal_entries = [{ count: 5 }] // posted entries exist
    const supabase = buildRoutingSupabase(queues)

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(result.openingBalanceEntryId).toBeNull()
    expect(result.warnings.join(' ')).toMatch(/hoppades över eftersom bolaget redan har bokförda verifikationer/)
    // Zero entries created → the finalizer safety net downgrades the run so
    // the file slot stays free for a retry (existing behavior).
    expect(result.success).toBe(false)
    expect(result.errors.join(' ')).toMatch(/0 verifikationer/)
  })

  it('creates no IB entry when the file has neither #IB 0 nor #UB -1', async () => {
    const supabase = buildRoutingSupabase(standardQueues())
    const parsed = makeParsedFile({
      openingBalances: [],
      closingBalances: [
        { yearIndex: 0, account: '1930', amount: 160406.0 },
        { yearIndex: 0, account: '2010', amount: -160406.0 },
      ],
    })

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      parsed,
      standardMappings,
      standardOptions,
    )

    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(result.openingBalanceEntryId).toBeNull()
  })
})

// --- Untransferred prior-year results (post-import walk) ---
// Prod incident: a multi-year migration where one middle year's file lacked
// the omföring av årets resultat. Every later year's derived IB inherited
// the residual as a permanent balansräkning differens. The import must
// surface the culprit years — as warning strings for the wizard and as
// structured details for UIs that don't render warnings.

describe('executeSIEImport — untransferred prior-year results', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const culprit = {
    fiscal_period_id: 'fp-0',
    period_name: 'Räkenskapsår 2024/2025',
    pl_net: 97,
  }

  it('surfaces culprit years as warnings and structured details', async () => {
    vi.mocked(findUntransferredResults).mockResolvedValue([culprit])
    const supabase = buildRoutingSupabase(standardQueues())

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(result.success).toBe(true)
    expect(result.warnings.join(' ')).toMatch(
      /Resultatet för Räkenskapsår 2024\/2025 .* har inte förts om till eget kapital/
    )
    expect(result.details?.untransferredResults).toEqual([culprit])
  })

  it('adds nothing when every prior year transferred its result', async () => {
    vi.mocked(findUntransferredResults).mockResolvedValue([])
    const supabase = buildRoutingSupabase(standardQueues())

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(result.success).toBe(true)
    expect(result.warnings.join(' ')).not.toMatch(/förts om till eget kapital/)
    expect(result.details?.untransferredResults).toBeUndefined()
  })

  it('a diagnosis failure never fails the import', async () => {
    vi.mocked(findUntransferredResults).mockRejectedValue(new Error('boom'))
    const supabase = buildRoutingSupabase(standardQueues())

    const result = await executeSIEImport(
      supabase,
      'company-1',
      'user-1',
      makeParsedFile(),
      standardMappings,
      standardOptions,
    )

    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.details?.untransferredResults).toBeUndefined()
  })
})
