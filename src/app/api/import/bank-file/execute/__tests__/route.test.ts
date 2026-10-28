/**
 * Tests for POST /api/import/bank-file/execute, focused on the SIE-overlap
 * behavior: a bank file covering a period a completed SIE import already
 * booked must (a) suppress auto-categorization to prevent double-booking and
 * (b) trigger the per-account reconciliation sweep and stamp its summary,
 * because CSV is how a migrator gets pre-PSD2 history into the system.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const getCompanyRoleMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  getCompanyRole: (...args: unknown[]) => getCompanyRoleMock(...args),
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const ingestMock = vi.fn()
vi.mock('@/lib/transactions/ingest', () => ({
  ingestTransactions: (...args: unknown[]) => ingestMock(...args),
}))

const ensureCashAccountMock = vi.fn()
vi.mock('@/lib/cash-accounts/service', () => ({
  ensureManualCashAccount: (...args: unknown[]) => ensureCashAccountMock(...args),
}))

const sweepMock = vi.fn()
vi.mock('@/lib/reconciliation/unattended-sweep', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reconciliation/unattended-sweep')>()
  return {
    ...actual,
    runUnattendedReconciliationSweep: (...args: unknown[]) => sweepMock(...args),
  }
})

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

function makeBody(overrides: Record<string, unknown> = {}) {
  return {
    transactions: [
      { date: '2025-03-10', description: 'Hyra mars', amount: -12000, currency: 'SEK' },
      { date: '2025-01-05', description: 'Kundbetalning', amount: 25000, currency: 'SEK' },
    ],
    format: 'seb',
    filename: 'kontoutdrag.csv',
    file_hash: 'abc123',
    skip_duplicates: true,
    auto_categorize: true,
    ...overrides,
  }
}

function emptyIngestResult(overrides: Record<string, unknown> = {}) {
  return {
    imported: 2,
    duplicates: 0,
    reconciled: 0,
    auto_categorized: 0,
    auto_matched_invoices: 0,
    errors: 0,
    transaction_ids: ['t-1', 't-2'],
    ...overrides,
  }
}

function emptySweepResult(overrides: Record<string, unknown> = {}) {
  return {
    accounts: [],
    applied: 1,
    errors: 0,
    skippedBelowThreshold: 1,
    suggested: 1,
    unmatched: 0,
    ...overrides,
  }
}

describe('POST /api/import/bank-file/execute (SIE overlap)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
    ingestMock.mockResolvedValue(emptyIngestResult())
    sweepMock.mockResolvedValue(emptySweepResult())
    ensureCashAccountMock.mockResolvedValue('ca-1')
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody(),
    })
    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
  })

  it('suppresses auto-categorization, runs the sweep over the file window, and stamps the summary on SIE overlap', async () => {
    enqueue({ data: { id: 'import-1' } }) // bank_file_imports upsert
    enqueue({ data: { id: 'sie-1' } }) // sie_imports overlap: found
    enqueue({ data: null }) // bank_file_imports status update
    enqueue({ data: null }) // sie_sweep stamp update
    enqueue({ data: [{ id: 't-1' }, { id: 't-2' }] }) // imported tx for event

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody(),
    })
    const response = await POST(request, emptyParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // Ingest was told to skip auto-categorization (double-booking guard).
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.skipAutoCategorization).toBe(true)
    // Sweep ran over the file's own date window (min/max of its rows).
    expect(sweepMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      dateFrom: '2025-01-05',
      dateTo: '2025-03-10',
    })
  })

  it('runs no sweep and keeps categorization when there is no SIE overlap', async () => {
    enqueue({ data: { id: 'import-1' } }) // upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: null }) // status update
    enqueue({ data: [{ id: 't-1' }] }) // imported tx for event

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody(),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.skipAutoCategorization).toBeUndefined()
    // Every inserted row is stamped with the batch id so the owner/admin
    // "undo this import" action can scope its bulk delete exactly.
    expect(ingestOptions.bankFileImportId).toBe('import-1')
    expect(sweepMock).not.toHaveBeenCalled()
  })

  // The response says WHY rows were skipped (the split by reason). The per-row
  // list stays server-side: a re-exported statement skips every row on
  // content, and the wizard's preview already marked those rows one by one.
  it('returns the duplicate count split by reason, without the per-row list', async () => {
    const duplicatesByReason = { external_id_match: 1, content_match_booked: 0, content_match_unbooked: 1 }
    ingestMock.mockResolvedValue(emptyIngestResult({
      imported: 0,
      duplicates: 2,
      duplicates_by_reason: duplicatesByReason,
      skipped: [
        { external_id: 'seb_a', reason: 'external_id_match', matched_external_id: 'seb_a', matched_transaction_id: 't-9' },
        { external_id: 'seb_b', reason: 'content_match_unbooked', matched_external_id: 'eb_x', matched_transaction_id: 't-8' },
      ],
      transaction_ids: [],
    }))
    enqueue({ data: { id: 'import-1' } }) // upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: null }) // status update

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody(),
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(response)

    expect(status).toBe(200)
    expect(body.data.duplicates).toBe(2)
    expect(body.data.duplicates_by_reason).toEqual(duplicatesByReason)
    expect(body.data).not.toHaveProperty('skipped')
  })

  it('never sweeps for a viewer (raw insert only)', async () => {
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'viewer', companyId: 'company-1' })
    enqueue({ data: { id: 'import-1' } }) // upsert
    enqueue({ data: { id: 'sie-1' } }) // overlap found
    enqueue({ data: null }) // status update
    enqueue({ data: [{ id: 't-1' }] }) // imported tx for event

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody(),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.rawInsertOnly).toBe(true)
    expect(sweepMock).not.toHaveBeenCalled()
  })
})

/**
 * The wizard offers any active 19xx chart account. A picked ledger with no
 * cash_accounts row used to be dropped silently by ingest (cash_account_id
 * NULL on every row, booking dialog defaulting to 1930). The route now finds
 * or creates the manual cash account before anything is written.
 */
describe('POST /api/import/bank-file/execute (settlement account)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
    ingestMock.mockResolvedValue(emptyIngestResult())
    sweepMock.mockResolvedValue(emptySweepResult())
    ensureCashAccountMock.mockResolvedValue('ca-1')
  })

  it('finds or creates the cash account for the picked ledger and hands it to ingest', async () => {
    enqueue({ data: { account_number: '1940' } }) // chart_of_accounts: active 1940
    enqueue({ data: { id: 'import-1' } }) // upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: null }) // status update
    enqueue({ data: [{ id: 't-1' }] }) // imported tx for event

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1940' }),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(ensureCashAccountMock).toHaveBeenCalledWith(supabase, 'company-1', '1940', 'SEK', 'Bankkonto 1940')
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.settlementAccount).toBe('1940')
  })

  it('denominates a new cash account in the currency most rows use', async () => {
    enqueue({ data: { account_number: '1932' } }) // chart_of_accounts
    enqueue({ data: { id: 'import-1' } })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: [{ id: 't-1' }] })

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({
        settlement_account: '1932',
        // A Wise or camt.053 file for a EUR account with one row in SEK.
        transactions: [
          { date: '2025-03-10', description: 'Rent', amount: -1200, currency: 'EUR' },
          { date: '2025-03-11', description: 'Fee', amount: -3, currency: 'SEK' },
          { date: '2025-03-12', description: 'Client', amount: 4000, currency: 'EUR' },
        ],
      }),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(ensureCashAccountMock).toHaveBeenCalledWith(supabase, 'company-1', '1932', 'EUR', 'Bankkonto 1932')
  })

  it('returns 400 for a class 19 ledger the company chart does not have, before any write', async () => {
    enqueue({ data: null }) // chart_of_accounts: no active 1945

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1945' }),
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { account: string } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('BANK_FILE_INVALID_SETTLEMENT_ACCOUNT')
    expect(body.error.details.account).toBe('1945')
    expect(ensureCashAccountMock).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalledWith('bank_file_imports')
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('touches no cash account when the request names none', async () => {
    enqueue({ data: { id: 'import-1' } })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: [{ id: 't-1' }] })

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody(),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(ensureCashAccountMock).not.toHaveBeenCalled()
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.settlementAccount).toBeUndefined()
  })

  it('returns 400 for a settlement account outside class 19, before any write', async () => {
    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '2440' }),
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('BANK_FILE_INVALID_SETTLEMENT_ACCOUNT')
    expect(ensureCashAccountMock).not.toHaveBeenCalled()
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('accepts kassa 1910: the wizard offers all of class 19, not only 1920-1999', async () => {
    enqueue({ data: { account_number: '1910' } }) // chart_of_accounts: active 1910
    enqueue({ data: { id: 'import-1' } }) // upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: null }) // status update
    enqueue({ data: [{ id: 't-1' }] }) // imported tx for event

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1910' }),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(ensureCashAccountMock).toHaveBeenCalledWith(supabase, 'company-1', '1910', 'SEK', 'Bankkonto 1910')
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.settlementAccount).toBe('1910')
  })

  it('returns 409 and writes nothing when the cash account cannot be used', async () => {
    ensureCashAccountMock.mockRejectedValue(
      new Error('Cash account 1940 is denominated in EUR, not SEK'),
    )
    enqueue({ data: { account_number: '1940' } }) // chart_of_accounts

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1940' }),
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { account: string } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('BANK_FILE_SETTLEMENT_ACCOUNT_UNAVAILABLE')
    expect(body.error.details.account).toBe('1940')
    // No bank_file_imports record and no ingest: the refusal leaves nothing behind.
    expect(supabase.from).not.toHaveBeenCalledWith('bank_file_imports')
    expect(ingestMock).not.toHaveBeenCalled()
  })
})

// crm#1204: a Swedbank statement of the account the bank feed holds on 1931,
// while 1930 is another account of the same connection. Invented numbers.
const FEED_IBAN = 'SE1280000832791234567890'
const OTHER_IBAN = 'SE5580000832799876543210'
const SWEDBANK_ACCOUNT = { iban: null, clearing: '8327-9', account_number: '123 456 789-0' }
const CASH_ACCOUNTS = [
  { ledger_account: '1930', iban: OTHER_IBAN, bban: null, clearing_number: null, account_number: null, currency: 'SEK', enabled: true, is_primary: false, bank_connection_id: 'conn-1' },
  { ledger_account: '1931', iban: FEED_IBAN, bban: null, clearing_number: null, account_number: null, currency: 'SEK', enabled: true, is_primary: true, bank_connection_id: 'conn-1' },
]

describe('POST /api/import/bank-file/execute (the file names its own account, crm#1204)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
    ingestMock.mockResolvedValue(emptyIngestResult())
    ensureCashAccountMock.mockResolvedValue('ca-1931')
  })

  it('refuses another ledger with 409 and writes nothing', async () => {
    enqueue({ data: CASH_ACCOUNTS }) // cash_accounts for the match

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ format: 'swedbank', settlement_account: '1930', account: SWEDBANK_ACCOUNT }),
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{
      error: { code: string; message: string; details: { account: string; selected: string } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('BANK_FILE_ACCOUNT_MISMATCH')
    expect(body.error.details).toEqual({ account: '1931', selected: '1930' })
    expect(body.error.message).toContain('1931')
    expect(ensureCashAccountMock).not.toHaveBeenCalled()
    expect(supabase.from).not.toHaveBeenCalledWith('bank_file_imports')
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('imports onto the matched ledger, so ingest guards duplicates against the feed rows', async () => {
    enqueue({ data: CASH_ACCOUNTS }) // cash_accounts for the match
    enqueue({ data: { account_number: '1931' } }) // chart_of_accounts
    enqueue({ data: { id: 'import-1' } }) // bank_file_imports upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: null }) // status update
    enqueue({ data: [{ id: 't-1' }] }) // imported tx for event

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ format: 'swedbank', settlement_account: '1931', account: SWEDBANK_ACCOUNT }),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(ensureCashAccountMock).toHaveBeenCalledWith(supabase, 'company-1', '1931', 'SEK', 'Bankkonto 1931')
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.settlementAccount).toBe('1931')
  })

  it('settles on the matched ledger when the request names none', async () => {
    enqueue({ data: CASH_ACCOUNTS })
    enqueue({ data: { account_number: '1931' } })
    enqueue({ data: { id: 'import-1' } })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: [{ id: 't-1' }] })

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ format: 'swedbank', account: SWEDBANK_ACCOUNT }),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.settlementAccount).toBe('1931')
  })

  it('imports a file of an account the company does not know onto the chosen ledger', async () => {
    enqueue({ data: CASH_ACCOUNTS }) // no row is this account
    enqueue({ data: { account_number: '1940' } })
    enqueue({ data: { id: 'import-1' } })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: [{ id: 't-1' }] })

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({
        format: 'swedbank',
        settlement_account: '1940',
        account: { iban: null, clearing: '8327-9', account_number: '555 666 777-8' },
      }),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.settlementAccount).toBe('1940')
  })

  it('returns 400 for a malformed account, before any read or write', async () => {
    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1930', account: { iban: 42 } }),
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(supabase.from).not.toHaveBeenCalled()
    expect(ingestMock).not.toHaveBeenCalled()
  })

  it('returns 500 and writes nothing when the cash accounts cannot be read', async () => {
    enqueue({ error: { message: 'connection reset' } })

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1930', account: SWEDBANK_ACCOUNT }),
    })
    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(500)
    expect(body.error.code).toBe('BANK_FILE_EXECUTE_FAILED')
    expect(ensureCashAccountMock).not.toHaveBeenCalled()
    expect(ingestMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/import/bank-file/execute (row fields)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: 'company-1' })
    ingestMock.mockResolvedValue(emptyIngestResult({ imported: 1, transaction_ids: ['t-1'] }))
  })

  it('hands ingest every field the parser read, the counterparty as merchant_name', async () => {
    enqueue({ data: { id: 'import-1' } }) // upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: null }) // status update
    enqueue({ data: [{ id: 't-1' }] }) // imported tx for event

    const row = {
      date: '2025-03-10', description: 'Faktura 1001', amount: 12500, currency: 'SEK',
      reference: '1001000000017', counterparty: 'Kund AB', raw_line: 'ACSR-1',
      value_date: '2025-03-11', end_to_end_id: 'E2E-1', provider_transaction_id: 'ACSR-1',
      counterparty_iban: 'SE4550000000058398257466', bank_transaction_code: 'PMNT-RCDT-DMCT',
      balance: 98765.43,
    }
    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ transactions: [row], format: 'camt053' }),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(ingestMock.mock.calls[0][3]).toEqual([{
      external_id: 'camt053_ACSR-1', date: '2025-03-10', description: 'Faktura 1001', amount: 12500,
      currency: 'SEK', reference: '1001000000017', merchant_name: 'Kund AB', import_source: 'camt053',
      value_date: '2025-03-11', end_to_end_id: 'E2E-1', provider_transaction_id: 'ACSR-1',
      counterparty_iban: 'SE4550000000058398257466', bank_transaction_code: 'PMNT-RCDT-DMCT',
      balance_after: 98765.43,
    }])
  })
})

// The import's arrival: recorded once its rows entered, pointing at the
// original the parse step archived under the file's content hash.
describe('POST /api/import/bank-file/execute (arrival)', () => {
  const COMPANY = '11111111-1111-4111-8111-111111111111'
  const IMPORT_ID = '33333333-3333-4333-8333-333333333333'
  const FILE_HASH = 'e'.repeat(64)
  const bucket = supabase.storage.from('documents') as unknown as { download: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    getCompanyRoleMock.mockResolvedValue({ ok: true, role: 'owner', companyId: COMPANY })
    ingestMock.mockResolvedValue(emptyIngestResult())
  })

  function execute(arrivalAnswers: Array<{ data?: unknown; error?: unknown }> = []) {
    enqueue({ data: { id: IMPORT_ID } }) // bank_file_imports upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: null }) // bank_file_imports status update
    enqueue({ data: [{ id: 't-1' }, { id: 't-2' }] }) // imported tx for event
    for (const answer of arrivalAnswers) enqueue(answer)
    return POST(createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ file_hash: FILE_HASH, filename: 'kontoutdrag.csv' }),
    }), emptyParams)
  }

  it('records a bank_file arrival for the import, pointing at the archived original', async () => {
    bucket.download.mockResolvedValueOnce({ data: new Blob(['statement'], { type: 'text/csv' }), error: null })
    // The arrivals lookup finds none; the insert answers with the row.
    const response = await execute([{ data: null }, { data: [{ id: 'arrival-1' }] }])
    expect(response.status).toBe(200)

    expect(bucket.download).toHaveBeenCalledWith(`documents/${COMPANY}/arrivals/bank_file/${FILE_HASH}/kontoutdrag.csv`)
    const [row] = findCall('arrivals', 'upsert') as [Record<string, unknown>]
    expect(row).toMatchObject({
      company_id: COMPANY,
      source: 'bank_file',
      source_ref: IMPORT_ID,
      fetched_by: { type: 'user', user_id: 'user-1' },
      original_path: `documents/${COMPANY}/arrivals/bank_file/${FILE_HASH}/kontoutdrag.csv`,
      original_size: 9,
      original_mime: 'text/csv',
    })
    expect(row.source_meta).toMatchObject({
      via: 'app', bank_file_import_id: IMPORT_ID, format: 'seb', transaction_count: 2, imported_count: 2,
      date_from: '2025-01-05', date_to: '2025-03-10',
    })
  })

  it('records no arrival when every row failed', async () => {
    ingestMock.mockResolvedValue(emptyIngestResult({ imported: 0, errors: 2, transaction_ids: [] }))
    enqueue({ data: { id: IMPORT_ID } })
    enqueue({ data: null })
    enqueue({ data: null })
    const response = await POST(createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ file_hash: FILE_HASH }),
    }), emptyParams)
    expect(response.status).toBe(200)
    expect(supabase.from).not.toHaveBeenCalledWith('arrivals')
    expect(bucket.download).not.toHaveBeenCalled()
  })

  it('answers the import when the arrival cannot be recorded', async () => {
    bucket.download.mockRejectedValueOnce(new Error('storage down'))
    const response = await execute()
    expect(response.status).toBe(200)
  })
})
