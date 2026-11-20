/**
 * A bank file has the same effects through this door as through the
 * dashboard's: the rows bind to the account the file names, a period a SIE
 * import booked is matched and never auto-booked, transaction.synced fires,
 * and an import where every row failed reads failed. The door passes no
 * chosen ledger, so none of this can refuse a file.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

const { ingestMock, startOperationMock, completeOperationMock, failOperationMock, announceMock, sweepMock, matchMock } = vi.hoisted(() => ({
  ingestMock: vi.fn(),
  startOperationMock: vi.fn(),
  completeOperationMock: vi.fn().mockResolvedValue(undefined),
  failOperationMock: vi.fn().mockResolvedValue(undefined),
  announceMock: vi.fn().mockResolvedValue(1),
  sweepMock: vi.fn(),
  matchMock: vi.fn(),
}))

vi.mock('@/lib/transactions/ingest', () => ({ ingestTransactions: ingestMock }))
vi.mock('@/lib/transactions/announce-synced', () => ({ announceSyncedTransactions: announceMock }))
vi.mock('@/lib/cash-accounts/file-account', () => ({ loadFileAccountMatch: matchMock }))
vi.mock('@/lib/reconciliation/unattended-sweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reconciliation/unattended-sweep')>()),
  runUnattendedReconciliationSweep: sweepMock,
}))
vi.mock('@/lib/api/v1/operations', () => ({
  startOperation: startOperationMock,
  completeOperation: completeOperationMock,
  failOperation: failOperationMock,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { POST } from '../route'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

/** A Handelsbanken statement: it names its own account above the rows. */
const STATEMENT = [
  'Kontonummer: 6123-123456789',
  'Reskontradatum;Transaktionsdatum;Text;Belopp;Saldo',
  '2024-01-15;2024-01-15;SPOTIFY AB;-99,00;12345,67',
].join('\n')

function setup(byTable: Parameters<typeof createTableMockSupabase>[0] = {}) {
  const db = createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' } },
    bank_file_imports: { data: { id: 'import-1' } },
    ...byTable,
  })
  const supabase = Object.assign(db.supabase, {
    storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: null }) }) },
  })
  vi.mocked(createServiceClientNoCookies).mockReturnValue(supabase as never)
  return { ...db, supabase }
}

function post(content = STATEMENT, search = '') {
  const body = new FormData()
  body.append('file', new File([content], 'kontoutdrag.csv', { type: 'text/csv' }))
  return POST(
    new Request(`https://x.test/api/v1/companies/${COMPANY_ID}/imports/bank${search}`, {
      method: 'POST', body, headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
    }),
    { params: Promise.resolve({ companyId: COMPANY_ID }) },
  )
}

const imported = (over: Record<string, unknown> = {}) => ({
  imported: 1, duplicates: 0, reconciled: 0, auto_categorized: 0, auto_matched_invoices: 0, errors: 0, transaction_ids: ['t-1'], ...over,
})

describe('POST /api/v1/companies/:companyId/imports/bank: the effects of a bank file', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(validateApiKey).mockResolvedValue({
      userId: 'user-1', companyId: COMPANY_ID, apiKeyId: 'ak_1', scopes: ['transactions:write'], mode: 'live',
    } as never)
    startOperationMock.mockResolvedValue({ id: 'op-1' })
    ingestMock.mockResolvedValue(imported())
    matchMock.mockResolvedValue(null)
    sweepMock.mockResolvedValue({ accounts: [], applied: 1, errors: 0, skippedBelowThreshold: 0, suggested: 0, unmatched: 0 })
  })

  it('binds the rows to the ledger of the account the file names', async () => {
    setup()
    matchMock.mockResolvedValue({ ledger_account: '1941', ledger_accounts: ['1941'] })

    expect((await post()).status).toBe(202)

    expect(ingestMock.mock.calls[0][4]).toMatchObject({ bankFileImportId: 'import-1', settlementAccount: '1941' })
  })

  it('leaves a file naming no known account unbound, and refuses nothing', async () => {
    setup()

    expect((await post()).status).toBe(202)

    expect(ingestMock.mock.calls[0][4]).toEqual({ bankFileImportId: 'import-1' })
  })

  it('never auto-books a period a SIE import booked: it matches instead', async () => {
    const { supabase } = setup({ sie_imports: { data: { id: 'sie-1' } } })

    expect((await post()).status).toBe(202)

    expect(ingestMock.mock.calls[0][4]).toMatchObject({ skipAutoCategorization: true })
    expect(sweepMock).toHaveBeenCalledWith(supabase, COMPANY_ID, 'user-1', { dateFrom: '2024-01-15', dateTo: '2024-01-15' })
  })

  it('announces transaction.synced for the rows that entered, as its docs promise', async () => {
    setup()

    await post()

    expect(announceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId: COMPANY_ID, userId: 'user-1', transactionIds: ['t-1'],
    }))
  })

  it('fails the operation and writes nothing when the cash accounts cannot be read', async () => {
    setup()
    matchMock.mockRejectedValue(new Error('connection reset'))

    const response = await post()

    expect((await response.json()).error.code).toBe('BANK_IMPORT_FAILED')
    expect(failOperationMock).toHaveBeenCalledTimes(1)
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('refuses a file whose amounts two decimal marks read a thousand apart, and names the cell', async () => {
    setup()
    const threeDecimals = ['Datum,Text,Belopp', '2026-01-02,Kaffe,-45.000', '2026-01-03,Lunch,-129.000', '2026-01-04,Swish,250.000'].join('\n')

    const response = await post(threeDecimals, '?format=generic_csv')

    expect(response.status).toBe(400)
    const { error } = await response.json()
    expect(error.code).toBe('VALIDATION_ERROR')
    expect(error.details.issues[0]).toMatchObject({ row: 2, severity: 'error' })
    expect(error.details.issues[0].message).toContain('-45.000')
    expect(startOperationMock).not.toHaveBeenCalled()
    expect(ingestMock).not.toHaveBeenCalled()
  })

  describe('a row the parser could not read', () => {
    const holes = ['Datum,Text,Belopp', '2026-01-02,Hyra,-1500.00', '2026-01-03,Swish,100.00 SEK', '2026-01-04,Retur,250.00-'].join('\n')

    it('is named on the operation, and the operation says the import is not complete', async () => {
      setup()

      expect((await post(holes, '?format=generic_csv')).status).toBe(202)

      expect(completeOperationMock.mock.calls[0][1].result).toMatchObject({
        import_complete: false,
        transactions_imported: 1,
        transactions_skipped: 2,
        skipped_rows: [
          { row: 3, reason: 'Invalid amount: 100.00 SEK' },
          { row: 4, reason: 'Invalid amount: 250.00-' },
        ],
      })
    })

    it('leaves a trace on the import record too', async () => {
      const { findCalls } = setup()

      await post(holes, '?format=generic_csv')

      expect(findCalls('bank_file_imports', 'update').at(-1)?.[0]).toMatchObject({
        status: 'completed',
        error_message: '2 rader kunde inte läsas och importerades inte: rad 3, 4',
      })
    })

    it('a file read to its last row says it is complete', async () => {
      setup()

      await post()

      expect(completeOperationMock.mock.calls[0][1].result).toMatchObject({
        import_complete: true, transactions_skipped: 0, skipped_rows: [],
      })
    })
  })

  it('reads failed when every row failed, with the reason on the record', async () => {
    const { findCalls } = setup()
    ingestMock.mockResolvedValue(imported({
      imported: 0, errors: 1, transaction_ids: [], first_error: { message: 'row refused', code: null, details: null, hint: null },
    }))

    await post()

    expect(findCalls('bank_file_imports', 'update').at(-1)?.[0]).toMatchObject({ status: 'failed', error_message: '1 fel: row refused' })
  })
})
