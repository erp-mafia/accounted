/**
 * Regression suite for issue #1667 (Boltonshield AB support case, 2026-08-17).
 *
 * The bug: after partially deleting imported data, a provider re-sync could
 * not re-import an earlier fiscal year. Three defects compounded:
 *
 *   1. The sie_imports 'completed' watermark survives data deletion, and the
 *      replace path aborted the WHOLE year when replaceSIEImport could not
 *      resolve the prior row (its data already gone).
 *   2. Prior-import detection used `.limit(1).maybeSingle()` with no
 *      ordering: with multiple overlapping completed rows for the same year
 *      it picked an arbitrary one and left the rest standing.
 *   3. The wizard error did not say which fiscal year failed (covered in the
 *      component, not testable here).
 *
 * The fix: findOverlappingPeriodImports returns ALL overlapping completed
 * rows newest-first (failing closed on query errors); replace mode resolves
 * every row and treats an unresolvable row (not_found / not_completed) as a
 * stale watermark: warn and continue as a fresh import — but only after
 * positively confirming no posted import entries survive in the year, since
 * replace_sie_import deletes by fiscal period and entries can outlive their
 * sie_imports row. Genuine refusals (locked period, RPC errors) still abort.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  executeSIEImport,
  replaceSIEImport,
  checkDuplicatePeriodImport,
  findOverlappingPeriodImports,
} from '../sie-import'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { ParsedSIEFile, AccountMapping } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

function makeParsedFile(overrides?: Partial<ParsedSIEFile>): ParsedSIEFile {
  return {
    header: {
      sieType: 4,
      flagga: 0,
      program: 'TestProg',
      programVersion: '1.0',
      generatedDate: '2026-08-17',
      format: 'PC8',
      companyName: 'Boltonshield Mock AB',
      orgNumber: '5567201701',
      address: null,
      fiscalYears: [{ yearIndex: 0, start: '2025-01-01', end: '2025-12-31' }],
      currency: 'SEK',
      kontoPlanType: null,
    },
    accounts: [
      { number: '1930', name: 'Företagskonto' },
      { number: '6110', name: 'Kontorsmaterial' },
    ],
    openingBalances: [],
    closingBalances: [],
    resultBalances: [],
    dimensions: [],
    dimensionValues: [],
    vouchers: [
      {
        series: 'A',
        number: 1,
        date: new Date(2025, 0, 15),
        description: 'Inköp',
        lines: [
          { account: '6110', amount: 1000 },
          { account: '1930', amount: -1000 },
        ],
      },
    ],
    issues: [],
    stats: {
      totalAccounts: 2,
      totalVouchers: 1,
      totalTransactionLines: 2,
      fiscalYearStart: '2025-01-01',
      fiscalYearEnd: '2025-12-31',
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

const mappings = [makeMapping('1930', '1930'), makeMapping('6110', '6110')]

const importOptions = {
  filename: 'migration-sie-2025.se',
  fileContent: '#dummy',
  createFiscalPeriod: false,
  importOpeningBalances: false,
  importTransactions: true,
  onExistingPeriod: 'replace' as const,
}

function makePriorImportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'imp-prior',
    user_id: 'user-1',
    filename: 'old.se',
    file_hash: 'hash-old',
    fiscal_year_start: '2025-01-01',
    fiscal_year_end: '2025-12-31',
    transactions_count: 10,
    status: 'completed',
    fiscal_period_id: 'fp-2025',
    opening_balance_entry_id: null,
    imported_at: '2026-06-01T00:00:00Z',
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  }
}

describe('findOverlappingPeriodImports', () => {
  it('returns every overlapping completed row, and [] when there are none', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const rows = [makePriorImportRow({ id: 'a' }), makePriorImportRow({ id: 'b' })]
    enqueue({ data: rows })

    const result = await findOverlappingPeriodImports(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )
    expect(result.map((r) => r.id)).toEqual(['a', 'b'])

    const empty = await findOverlappingPeriodImports(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )
    expect(empty).toEqual([])
  })

  it('orders newest first so the pick is deterministic', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await findOverlappingPeriodImports(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )

    const orderCalls = findCalls('sie_imports', 'order')
    expect(orderCalls).toEqual([
      ['imported_at', { ascending: false, nullsFirst: false }],
      ['created_at', { ascending: false }],
      ['id', { ascending: false }],
    ])
  })

  it('throws on a query error instead of returning [] (fail closed)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection reset' } })

    await expect(
      findOverlappingPeriodImports(
        supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
      )
    ).rejects.toThrow(/connection reset/)
  })
})

describe('checkDuplicatePeriodImport', () => {
  it('returns the newest row when several overlap the period', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        makePriorImportRow({ id: 'newest', imported_at: '2026-08-01T00:00:00Z' }),
        makePriorImportRow({ id: 'older', imported_at: '2026-05-01T00:00:00Z' }),
      ],
    })

    const result = await checkDuplicatePeriodImport(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )
    expect(result?.id).toBe('newest')
  })

  it('returns null when nothing overlaps', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    const result = await checkDuplicatePeriodImport(
      supabase as unknown as SupabaseClient, 'company-1', '2025-01-01', '2025-12-31'
    )
    expect(result).toBeNull()
  })
})

describe('replaceSIEImport: failure classification', () => {
  it('classifies a vanished sie_imports row as not_found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // sie_imports fetch: row gone

    const result = await replaceSIEImport(
      supabase as unknown as SupabaseClient, 'company-1', 'imp-x', 'user-1'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('not_found')
  })

  it('classifies PGRST116 (zero rows) on the pre-check as not_found', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: null,
      error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
    }) // sie_imports fetch: .single() zero-rows error

    const result = await replaceSIEImport(
      supabase as unknown as SupabaseClient, 'company-1', 'imp-x', 'user-1'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('not_found')
  })

  it('classifies a non-PGRST116 pre-check query failure as rpc_error, never not_found (fail closed)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: null,
      error: { code: '57014', message: 'canceling statement due to statement timeout' },
    }) // sie_imports fetch: transient query failure, row state UNKNOWN

    const result = await replaceSIEImport(
      supabase as unknown as SupabaseClient, 'company-1', 'imp-x', 'user-1'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('rpc_error')
    expect(result.error).toMatch(/statement timeout/i)

    // Failed before the delete RPC: nothing was touched.
    const rpcCalls = (supabase.rpc.mock.calls as [string][])
      .filter(([fn]) => fn === 'replace_sie_import')
    expect(rpcCalls).toHaveLength(0)
  })

  it('classifies a row that already left completed as not_completed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { status: 'replaced', fiscal_period_id: null } })

    const result = await replaceSIEImport(
      supabase as unknown as SupabaseClient, 'company-1', 'imp-x', 'user-1'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('not_completed')
  })

  it('classifies a locked fiscal period as period_locked', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { status: 'completed', fiscal_period_id: 'fp-1' } },
      { data: { is_closed: false, locked_at: '2026-01-31T00:00:00Z' } },
    ])

    const result = await replaceSIEImport(
      supabase as unknown as SupabaseClient, 'company-1', 'imp-x', 'user-1'
    )
    expect(result.success).toBe(false)
    expect(result.code).toBe('period_locked')
  })

  it('classifies the RPC status-race raise as not_completed and other RPC errors as rpc_error', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { status: 'completed', fiscal_period_id: null } },
      { data: null, error: { message: 'Import imp-x not found or not in completed status' } },
    ])

    const raced = await replaceSIEImport(
      supabase as unknown as SupabaseClient, 'company-1', 'imp-x', 'user-1'
    )
    expect(raced.success).toBe(false)
    expect(raced.code).toBe('not_completed')

    enqueueMany([
      { data: { status: 'completed', fiscal_period_id: null } },
      { data: null, error: { message: 'canceling statement due to statement timeout' } },
    ])

    const failed = await replaceSIEImport(
      supabase as unknown as SupabaseClient, 'company-1', 'imp-x', 'user-1'
    )
    expect(failed.success).toBe(false)
    expect(failed.code).toBe('rpc_error')
  })
})

describe('executeSIEImport replace mode: re-sync after deletion (issue #1667)', () => {
  it('replaces EVERY overlapping completed import, not just the newest', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    const rowNew = makePriorImportRow({
      id: 'imp-new',
      opening_balance_entry_id: 'ob-1',
      imported_at: '2026-08-01T00:00:00Z',
    })
    const rowOld = makePriorImportRow({
      id: 'imp-old',
      imported_at: '2026-05-01T00:00:00Z',
    })
    enqueueMany([
      { data: [rowNew, rowOld] }, // findOverlappingPeriodImports
      { data: { status: 'completed', fiscal_period_id: 'fp-2025' } }, // replace imp-new: fetch
      { data: { is_closed: false, locked_at: null } }, // replace imp-new: period check
      { data: 5 }, // rpc replace_sie_import → 5 deleted
      { data: null }, // OB safety-net update (imp-new had an OB entry)
      { data: { status: 'completed', fiscal_period_id: 'fp-2025' } }, // replace imp-old: fetch
      { data: { is_closed: false, locked_at: null } }, // replace imp-old: period check
      { data: 3 }, // rpc → 3 deleted
      { data: null }, // cleanupStaleImportRecords delete
      { data: { id: 'imp-created' } }, // pending sie_imports insert
      { data: [] }, // syncMappedAccounts chart fetch
      { data: null }, // chart insert (missing accounts)
      { data: null }, // find existing fiscal period → clean stop
    ])

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeParsedFile(),
      mappings,
      importOptions,
    )

    // Both prior rows were pushed through the replace RPC.
    const rpcCalls = (supabase.rpc.mock.calls as [string, Record<string, unknown>][])
      .filter(([fn]) => fn === 'replace_sie_import')
    expect(rpcCalls.map(([, params]) => params.p_import_id)).toEqual(['imp-new', 'imp-old'])

    // The reported shape stays a single object: newest id, total deleted.
    expect(result.replacedPriorImport).toEqual({ importId: 'imp-new', deletedEntries: 8 })

    // The run then proceeds past the replace block (stops at the benign
    // fiscal-period stop this queue sets up, NOT a replace failure).
    expect(result.errors.join(' ')).toMatch(/No matching fiscal period found/i)
    expect(result.errors.join(' ')).not.toMatch(/ersätta/i)
  })

  it('treats a stale watermark (prior row unresolvable) as a fresh import instead of aborting the year', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makePriorImportRow({ id: 'imp-stale' })] }, // findOverlappingPeriodImports
      { data: null }, // replaceSIEImport fetch: row gone (deleted between the two queries)
      { data: null, count: 0 }, // survivor guard: no posted import entries remain
      { data: null }, // cleanupStaleImportRecords delete
      { data: { id: 'imp-created' } }, // pending sie_imports insert
      { data: [] }, // chart fetch
      { data: null }, // chart insert
      { data: null }, // find existing fiscal period → clean stop
    ])

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeParsedFile(),
      mappings,
      importOptions,
    )

    // Not stranded: the import continued past the replace block.
    expect(result.errors.join(' ')).not.toMatch(/ersätta/i)
    expect(result.errors.join(' ')).toMatch(/No matching fiscal period found/i)
    expect(result.warnings.join(' ')).toMatch(/fortsätter som ny import/i)
    expect(result.replacedPriorImport).toBeNull()

    const rpcCalls = (supabase.rpc.mock.calls as [string][])
      .filter(([fn]) => fn === 'replace_sie_import')
    expect(rpcCalls).toHaveLength(0)
  })

  it('aborts when posted import entries survive a stale watermark, instead of duplicating them', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makePriorImportRow({ id: 'imp-stale' })] }, // findOverlappingPeriodImports
      { data: null }, // replaceSIEImport fetch: metadata row gone
      { data: null, count: 42 }, // survivor guard: 42 posted import entries REMAIN in the year
    ])

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeParsedFile(),
      mappings,
      importOptions,
    )

    // The metadata row is gone but its verifikationer are not: importing
    // fresh would duplicate them (BFL 4:1), so the year aborts.
    expect(result.success).toBe(false)
    expect(result.errors.join(' ')).toMatch(/42 kvarvarande verifikationer/)
    expect(result.importId).toBeNull()
  })

  it('aborts when the survivor check itself fails, instead of assuming zero survivors', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makePriorImportRow({ id: 'imp-stale' })] }, // findOverlappingPeriodImports
      { data: null }, // replaceSIEImport fetch: metadata row gone
      {
        data: null,
        count: null,
        error: { message: 'canceling statement due to statement timeout' },
      }, // survivor guard query fails: survivor state UNKNOWN
    ])

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeParsedFile(),
      mappings,
      importOptions,
    )

    expect(result.success).toBe(false)
    expect(result.errors.join(' ')).toMatch(/Kunde inte verifiera att tidigare importdata är borttagen/)
    expect(result.importId).toBeNull()
  })

  it('aborts the year when the replace pre-check query fails, instead of importing fresh', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makePriorImportRow({ id: 'imp-prior' })] }, // findOverlappingPeriodImports
      {
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      }, // replaceSIEImport fetch: transient failure, prior entries may still exist
    ])

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeParsedFile(),
      mappings,
      importOptions,
    )

    // NOT treated as a stale watermark: the year aborts fail-closed.
    expect(result.success).toBe(false)
    expect(result.errors.join(' ')).toMatch(/statement timeout/i)
    expect(result.warnings.join(' ')).not.toMatch(/fortsätter som ny import/i)
    // Aborted before any sie_imports row was created: nothing imported fresh.
    expect(result.importId).toBeNull()
    const rpcCalls = (supabase.rpc.mock.calls as [string][])
      .filter(([fn]) => fn === 'replace_sie_import')
    expect(rpcCalls).toHaveLength(0)
  })

  it('still aborts the year when the prior import sits in a locked period', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: [makePriorImportRow({ id: 'imp-locked' })] }, // findOverlappingPeriodImports
      { data: { status: 'completed', fiscal_period_id: 'fp-2025' } }, // replace fetch
      { data: { is_closed: false, locked_at: '2026-01-31T00:00:00Z' } }, // period check: LOCKED
    ])

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeParsedFile(),
      mappings,
      importOptions,
    )

    expect(result.success).toBe(false)
    expect(result.errors.join(' ')).toMatch(/låst eller stängt/i)
    // Aborted before any sie_imports row was created.
    expect(result.importId).toBeNull()
  })
})
