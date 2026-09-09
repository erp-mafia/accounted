/**
 * executeSIEImport ↔ syncMappedAccounts wiring (F: customized #KONTO names
 * from Fortnox were lost on import).
 *
 * The name-resolution behavior itself is covered by account-sync.test.ts:
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
    { data: null }, // checkDuplicateImport: no prior import
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

describe('executeSIEImport: account name sync wiring', () => {
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

  it('reports the number of accounts the sync inserted', async () => {
    mockSync.mockResolvedValue({
      created: 109,
      renamed: 0,
      renamedAccounts: [],
      renameFailed: 0,
      error: null,
    })

    const result = await runImport()

    expect(result.accountsCreated).toBe(109)
  })

  it('leaves accountsCreated unset when the create pass fails', async () => {
    mockSync.mockResolvedValue({
      created: 3,
      renamed: 0,
      renamedAccounts: [],
      renameFailed: 0,
      error: 'permission denied',
    })

    const result = await runImport()

    expect(result.accountsCreated).toBeUndefined()
  })
})

// Regression for 2026-09-09: the account insert timed out, executeSIEImport
// returned through the early `return result` after syncMappedAccounts, and
// the sie_imports row it had just created stayed 'pending'. That row holds
// the (company_id, file_hash) slot in the partial unique index, so the user's
// retry 40 s later failed on the index with a message that named the retired
// brand and a button that does not exist.
describe('executeSIEImport: pending import record on early exit', () => {
  function importWith(mock: ReturnType<typeof createQueuedMockSupabase>) {
    return executeSIEImport(
      mock.supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      makeParsedFile(),
      makeMappings(),
      {
        filename: 'bokio.se',
        fileContent: '#dummy',
        createFiscalPeriod: false,
        importOpeningBalances: false,
        importTransactions: true,
      }
    )
  }

  it('closes the pending record as failed when the create pass aborts', async () => {
    mockSync.mockResolvedValue({
      created: 0,
      renamed: 0,
      renamedAccounts: [],
      renameFailed: 0,
      error: 'canceling statement due to statement timeout',
    })
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: null }, // checkDuplicateImport: no prior import
      { data: null }, // cleanupStaleImportRecords
      { data: { id: 'imp-1' } }, // createPendingImportRecord insert
      { data: null }, // finalizeImportRecord update
    ])

    const result = await importWith(mock)

    expect(result.success).toBe(false)
    expect(result.importId).toBe('imp-1')
    const updates = mock.findCalls('sie_imports', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toMatchObject({
      status: 'failed',
      imported_at: null,
      transactions_count: 0,
      error_message: expect.stringContaining('statement timeout'),
    })
  })

  it('closes the pending record as failed when the file has no fiscal year', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: null },
      { data: null },
      { data: { id: 'imp-2' } },
      { data: null },
    ])

    const result = await importWith(mock)

    expect(result.errors).toContain('No fiscal year defined in the SIE file')
    const updates = mock.findCalls('sie_imports', 'update')
    expect(updates).toHaveLength(1)
    expect(updates[0][0]).toMatchObject({ status: 'failed' })
  })

  it('explains a held file-hash slot in Swedish, without the retired brand or a missing button', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueueMany([
      { data: null }, // checkDuplicateImport
      { data: null }, // cleanupStaleImportRecords
      {
        data: null,
        error: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "sie_imports_company_id_file_hash_active_idx"',
        },
      },
    ])

    const result = await importWith(mock)

    expect(result.success).toBe(false)
    expect(result.importId).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(
      /^Importen misslyckades: Samma SIE-fil håller redan på att importeras/
    )
    expect(result.errors[0]).toMatch(/Vänta några minuter och försök igen/)
    expect(result.errors[0]).not.toMatch(/gnubok|Ersätt import|Fortnox/)
    // No row was created, so there is nothing to close.
    expect(mock.findCalls('sie_imports', 'update')).toHaveLength(0)
  })
})
