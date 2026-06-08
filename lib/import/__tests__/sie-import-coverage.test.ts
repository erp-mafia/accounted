/**
 * Regression suite for the Lookma AB support case (2026-05-28).
 *
 * The bug: gnubok_import_sie + executeSIEImport accepted mappings that
 * couldn't cover a single account in the file. The per-voucher loop then
 * silently skipped every verifikation, finalizeImportRecord marked the
 * sie_imports row 'completed' with transactions_count=0, and the partial
 * unique index on (company_id, file_hash) held the slot — blocking retry.
 *
 * The fix layers three guards:
 *   1. Stage-time refusal in gnubok_import_sie (covered in
 *      extensions/general/mcp-server/__tests__/import-sie-stage.test.ts).
 *   2. Defense-in-depth refusal in executeSIEImport (this file).
 *   3. Finalizer downgrade of any 0-entry success to 'failed' (this file).
 */
import { describe, it, expect } from 'vitest'
import { executeSIEImport, finalizeImportRecord } from '../sie-import'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ParsedSIEFile, AccountMapping, ImportResult } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeParsedFile(overrides?: Partial<ParsedSIEFile>): ParsedSIEFile {
  return {
    header: {
      sieType: 4,
      flagga: 0,
      program: 'TestProg',
      programVersion: '1.0',
      generatedDate: '2024-01-01',
      format: 'PC8',
      companyName: 'Lookma Mock AB',
      orgNumber: '5567201701',
      address: null,
      fiscalYears: [{ yearIndex: 0, start: '2024-01-01', end: '2024-12-31' }],
      currency: 'SEK',
      kontoPlanType: null,
    },
    accounts: [
      { number: '1930', name: 'Företagskonto' },
      { number: '6110', name: 'Kontorsmaterial' },
    ],
    openingBalances: [{ yearIndex: 0, account: '1930', amount: 50000 }],
    closingBalances: [],
    resultBalances: [],
    vouchers: [
      {
        series: 'A',
        number: 1,
        date: new Date(2024, 0, 15),
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
      fiscalYearStart: '2024-01-01',
      fiscalYearEnd: '2024-12-31',
    },
    ...overrides,
  }
}

function makeMapping(source: string, target: string | null): AccountMapping {
  return {
    sourceAccount: source,
    sourceName: `Account ${source}`,
    targetAccount: target as string,
    targetName: target ? `Target ${target}` : '',
    confidence: target ? 1 : 0,
    matchType: target ? 'exact' : 'manual',
    isOverride: false,
  }
}

describe('executeSIEImport — defense-in-depth coverage check', () => {
  it('refuses to insert a sie_imports row when mappings is empty', async () => {
    const { supabase } = createQueuedMockSupabase()
    const parsed = makeParsedFile()

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      parsed,
      [],
      {
        filename: 'lookma.se',
        fileContent: '#dummy',
        createFiscalPeriod: false,
        importOpeningBalances: false,
        importTransactions: true,
      },
    )

    expect(result.success).toBe(false)
    expect(result.importId).toBeNull()
    expect(result.errors.join(' ')).toMatch(/täcker inga konton/i)
  })

  it('refuses when mappings exist but cover none of the file\'s accounts', async () => {
    const { supabase } = createQueuedMockSupabase()
    const parsed = makeParsedFile()

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      parsed,
      [makeMapping('9999', '9999')],
      {
        filename: 'wrong.se',
        fileContent: '#dummy',
        createFiscalPeriod: false,
        importOpeningBalances: false,
        importTransactions: true,
      },
    )

    expect(result.success).toBe(false)
    expect(result.importId).toBeNull()
    expect(result.errors.join(' ')).toMatch(/täcker inga konton/i)
  })

  it('still rejects mappings with targetAccount=null (existing guard)', async () => {
    const { supabase } = createQueuedMockSupabase()
    const parsed = makeParsedFile()

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      parsed,
      [makeMapping('6110', null), makeMapping('1930', null)],
      {
        filename: 'half.se',
        fileContent: '#dummy',
        createFiscalPeriod: false,
        importOpeningBalances: false,
        importTransactions: true,
      },
    )

    expect(result.success).toBe(false)
    expect(result.errors.join(' ')).toMatch(/not mapped/i)
  })
})

describe('finalizeImportRecord — 0-entry downgrade', () => {
  it('flips a 0-entry success to status=failed and records the reason', async () => {
    const { supabase } = createQueuedMockSupabase()

    const result: ImportResult = {
      success: true,
      importId: 'imp-1',
      fiscalPeriodId: 'fp-1',
      openingBalanceEntryId: null,
      journalEntriesCreated: 0,
      journalEntryIds: [],
      errors: [],
      warnings: ['100 verifikationer hoppades över med ej mappade konton'],
      replacedPriorImport: null,
    }

    await finalizeImportRecord(
      supabase as unknown as SupabaseClient,
      'imp-1',
      'company-1',
      result,
      '#dummy',
    )

    expect(result.success).toBe(false)
    expect(result.errors.join(' ')).toMatch(/0 verifikationer/i)
  })

  it('leaves a successful run with entries alone', async () => {
    const { supabase } = createQueuedMockSupabase()

    const result: ImportResult = {
      success: true,
      importId: 'imp-2',
      fiscalPeriodId: 'fp-2',
      openingBalanceEntryId: null,
      journalEntriesCreated: 42,
      journalEntryIds: Array(42).fill('je'),
      errors: [],
      warnings: [],
      replacedPriorImport: null,
    }

    await finalizeImportRecord(
      supabase as unknown as SupabaseClient,
      'imp-2',
      'company-1',
      result,
      '#dummy',
    )

    expect(result.success).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('leaves a 0-voucher run alone when an OB entry was created', async () => {
    const { supabase } = createQueuedMockSupabase()

    const result: ImportResult = {
      success: true,
      importId: 'imp-3',
      fiscalPeriodId: 'fp-3',
      openingBalanceEntryId: 'ob-1',
      journalEntriesCreated: 1,
      journalEntryIds: ['ob-1'],
      errors: [],
      warnings: [],
      replacedPriorImport: null,
    }

    await finalizeImportRecord(
      supabase as unknown as SupabaseClient,
      'imp-3',
      'company-1',
      result,
      '#dummy',
    )

    expect(result.success).toBe(true)
  })
})

describe('executeSIEImport — coverage check with derived IB (issue #675)', () => {
  // SIE type 1/2-style file: no vouchers, no #IB 0 — only #UB -1. The
  // current-year IB must be derived from #UB -1, and the derived accounts
  // must feed the coverage guard (before the fix this set was empty, so the
  // guard never inspected UB-1-only files at all).
  function makeUb1OnlyFile(): ParsedSIEFile {
    return makeParsedFile({
      openingBalances: [],
      closingBalances: [
        { yearIndex: -1, account: '1930', amount: 37400.78 },
        { yearIndex: -1, account: '2010', amount: -37400.78 },
      ],
      vouchers: [],
      stats: {
        totalAccounts: 2,
        totalVouchers: 0,
        totalTransactionLines: 0,
        fiscalYearStart: '2024-01-01',
        fiscalYearEnd: '2024-12-31',
      },
    })
  }

  it('refuses when mappings cover none of the derived IB accounts', async () => {
    const { supabase } = createQueuedMockSupabase()

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeUb1OnlyFile(),
      [makeMapping('9999', '9999')],
      {
        filename: 'ub1-only.se',
        fileContent: '#dummy',
        createFiscalPeriod: false,
        importOpeningBalances: true,
        importTransactions: true,
      },
    )

    expect(result.success).toBe(false)
    expect(result.importId).toBeNull()
    expect(result.errors.join(' ')).toMatch(/täcker inga konton/i)
  })

  it('passes the coverage guard when mappings cover the derived IB accounts', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    // Past the guard the flow proceeds: dup check → stale cleanup → pending
    // record insert → chart fetch → period-dup check → find fiscal period
    // (null → clean stop with a NON-coverage error, which is all this test
    // needs to prove).
    enqueueMany([
      { data: null }, // checkDuplicateImport
      { data: null }, // cleanupStaleImportRecords delete
      { data: { id: 'imp-1' } }, // createPendingImportRecord insert
      { data: [] }, // syncMappedAccounts chart fetch
      { data: null }, // chart insert (missing accounts)
      { data: null }, // checkDuplicatePeriodImport
      { data: null }, // find existing fiscal period → stops here
    ])

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeUb1OnlyFile(),
      [makeMapping('1930', '1930'), makeMapping('2010', '2010')],
      {
        filename: 'ub1-only.se',
        fileContent: '#dummy',
        createFiscalPeriod: false,
        importOpeningBalances: true,
        importTransactions: true,
      },
    )

    expect(result.errors.join(' ')).not.toMatch(/täcker inga konton/i)
    expect(result.errors.join(' ')).toMatch(/No matching fiscal period found/i)
  })

  it('skips the IB accounts in the guard when importOpeningBalances is false', async () => {
    const { supabase } = createQueuedMockSupabase()

    const result = await executeSIEImport(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeUb1OnlyFile(),
      [makeMapping('9999', '9999')],
      {
        filename: 'ub1-only.se',
        fileContent: '#dummy',
        createFiscalPeriod: false,
        importOpeningBalances: false,
        importTransactions: true,
      },
    )

    // No vouchers + IB import disabled → sourceAccountsInFile is empty and
    // the guard does not fire (existing semantics preserved).
    expect(result.errors.join(' ')).not.toMatch(/täcker inga konton/i)
  })
})
