/**
 * executeSIEImport ↔ syncMappedAccounts wiring (F: customized #KONTO names
 * from Fortnox were lost on import).
 *
 * The name-resolution behavior itself is covered by account-sync.test.ts —
 * these tests assert that executeSIEImport threads the updateAccountNames
 * option through (default ON), surfaces rename counts as Swedish warnings,
 * and aborts on a fatal create error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeSIEImport } from '../sie-import'
import { syncMappedAccounts } from '../account-sync'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ParsedSIEFile, AccountMapping } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('../account-sync', () => ({
  syncMappedAccounts: vi.fn(),
}))

const mockSync = vi.mocked(syncMappedAccounts)

// Stops right after the account sync: stats carry no fiscal year, so
// executeSIEImport returns "No fiscal year defined" without needing the
// fiscal-period / voucher mocks.
function makeParsedFile(): ParsedSIEFile {
  return {
    header: {
      sieType: 4,
      flagga: 0,
      program: 'TestProg',
      programVersion: '1.0',
      generatedDate: '2024-01-01',
      format: 'PC8',
      companyName: 'Test AB',
      orgNumber: '5566778899',
      address: null,
      fiscalYears: [],
      currency: 'SEK',
      kontoPlanType: null,
    },
    accounts: [
      { number: '1930', name: 'Företagskonto Swedbank' },
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
      fiscalYearStart: null,
      fiscalYearEnd: null,
    },
  } as unknown as ParsedSIEFile
}

function makeMappings(): AccountMapping[] {
  return [
    {
      sourceAccount: '1930',
      sourceName: 'Företagskonto Swedbank',
      targetAccount: '1930',
      targetName: 'Företagskonto/checkkonto',
      confidence: 1,
      matchType: 'exact',
      isOverride: false,
    },
    {
      sourceAccount: '6110',
      sourceName: 'Kontorsmaterial',
      targetAccount: '6110',
      targetName: 'Kontorsmaterial',
      confidence: 1,
      matchType: 'exact',
      isOverride: false,
    },
  ]
}

function buildSupabase() {
  const { supabase, enqueueMany } = createQueuedMockSupabase()
  enqueueMany([
    { data: null }, // checkDuplicateImport — no prior import
    { data: null }, // cleanupStaleImportRecords
    { data: { id: 'imp-1' } }, // createPendingImportRecord insert
  ])
  return supabase as unknown as SupabaseClient
}

function runImport(opts?: { updateAccountNames?: boolean }) {
  return executeSIEImport(
    buildSupabase(),
    'company-1',
    'user-1',
    makeParsedFile(),
    makeMappings(),
    {
      filename: 'fortnox.se',
      fileContent: '#dummy',
      createFiscalPeriod: false,
      importOpeningBalances: false,
      importTransactions: true,
      ...opts,
    }
  )
}

beforeEach(() => {
  mockSync.mockReset()
  mockSync.mockResolvedValue({
    created: 0,
    renamed: 0,
    renamedAccounts: [],
    renameFailed: 0,
    error: null,
  })
})

describe('executeSIEImport — account name sync wiring', () => {
  it('defaults updateAccountNames to true', async () => {
    await runImport()

    expect(mockSync).toHaveBeenCalledTimes(1)
    const [, companyId, userId, mappings, updateNames] = mockSync.mock.calls[0]
    expect(companyId).toBe('company-1')
    expect(userId).toBe('user-1')
    expect(mappings).toHaveLength(2)
    expect(updateNames).toBe(true)
  })

  it('passes updateAccountNames: false through', async () => {
    await runImport({ updateAccountNames: false })

    expect(mockSync.mock.calls[0][4]).toBe(false)
  })

  it('surfaces rename counts as a Swedish warning (plural)', async () => {
    mockSync.mockResolvedValue({
      created: 1,
      renamed: 2,
      renamedAccounts: [
        { accountNumber: '1930', from: 'Företagskonto/checkkonto', to: 'Företagskonto Swedbank' },
        { accountNumber: '1510', from: 'Kundfordringar', to: 'Kundfordringar SEK' },
      ],
      renameFailed: 0,
      error: null,
    })

    const result = await runImport()

    expect(result.warnings).toContain('2 konton bytte namn till namnen från SIE-filen')
  })

  it('uses singular wording for one rename', async () => {
    mockSync.mockResolvedValue({
      created: 0,
      renamed: 1,
      renamedAccounts: [
        { accountNumber: '1930', from: 'Företagskonto/checkkonto', to: 'Företagskonto Swedbank' },
      ],
      renameFailed: 0,
      error: null,
    })

    const result = await runImport()

    expect(result.warnings).toContain('1 konto bytte namn till namnet från SIE-filen')
  })

  it('warns about failed renames without failing the import step', async () => {
    mockSync.mockResolvedValue({
      created: 0,
      renamed: 0,
      renamedAccounts: [],
      renameFailed: 1,
      error: null,
    })

    const result = await runImport()

    expect(result.warnings).toContain('1 kontonamn kunde inte uppdateras från SIE-filen')
    expect(result.errors.join(' ')).not.toMatch(/Failed to create accounts/)
  })

  it('aborts with an error when the create pass fails', async () => {
    mockSync.mockResolvedValue({
      created: 0,
      renamed: 0,
      renamedAccounts: [],
      renameFailed: 0,
      error: 'permission denied',
    })

    const result = await runImport()

    expect(result.success).toBe(false)
    expect(result.errors).toContain('Failed to create accounts: permission denied')
  })

  it('adds no rename warning when nothing was renamed', async () => {
    const result = await runImport()

    expect(result.warnings.join(' ')).not.toMatch(/bytte namn/)
  })
})
