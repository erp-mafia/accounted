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

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

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

  it('creates the picked settlement account when the company has no such cash account', async () => {
    // Without a cash_accounts row for the chosen ledger account, ingest
    // imports every row unbound and booking falls back to 1930.
    enqueue({ data: { id: 'import-1' } }) // bank_file_imports upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: null }) // cash_accounts lookup: missing
    enqueue({ data: { id: 'ca-new' } }) // cash_accounts insert
    enqueue({ data: null }) // status update
    enqueue({ data: [{ id: 't-1' }] }) // imported tx for event

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1940' }),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    const inserts = findCalls('cash_accounts', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toMatchObject({
      company_id: 'company-1',
      ledger_account: '1940',
      source: 'manual',
      currency: 'SEK',
    })
    const ingestOptions = ingestMock.mock.calls[0][4] as Record<string, unknown>
    expect(ingestOptions.settlementAccount).toBe('1940')
  })

  it('stops the import when the cash account cannot be created', async () => {
    // Rows imported without their account is the bug, not a fallback.
    enqueue({ data: { id: 'import-1' } }) // bank_file_imports upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: null }) // cash_accounts lookup: missing
    enqueue({ data: null, error: { message: 'duplicate key', code: '23505' } }) // cash_accounts insert
    enqueue({ data: null }) // bank_file_imports marked failed

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1940' }),
    })
    const response = await POST(request, emptyParams)

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(500)
    expect(body.error.code).toBe('BANK_FILE_SETTLEMENT_ACCOUNT_FAILED')
    expect(ingestMock).not.toHaveBeenCalled()
    const failed = findCalls('bank_file_imports', 'update')
    expect(failed.at(-1)?.[0]).toMatchObject({ status: 'failed' })
  })

  it('rejects an account outside the 1920-1999 range before writing anything', async () => {
    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1510' }),
    })
    const response = await POST(request, emptyParams)

    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('BANK_FILE_SETTLEMENT_ACCOUNT_INVALID')
    expect(ingestMock).not.toHaveBeenCalled()
    expect(findCalls('bank_file_imports', 'upsert')).toHaveLength(0)
    expect(findCalls('cash_accounts', 'insert')).toHaveLength(0)
  })

  it('leaves an existing cash account alone', async () => {
    enqueue({ data: { id: 'import-1' } }) // bank_file_imports upsert
    enqueue({ data: null }) // sie_imports overlap: none
    enqueue({ data: { id: 'ca-1' } }) // cash_accounts lookup: found
    enqueue({ data: null }) // status update
    enqueue({ data: [{ id: 't-1' }] }) // imported tx for event

    const request = createMockRequest('/api/import/bank-file/execute', {
      method: 'POST',
      body: makeBody({ settlement_account: '1930' }),
    })
    const response = await POST(request, emptyParams)

    expect(response.status).toBe(200)
    expect(findCalls('cash_accounts', 'insert')).toHaveLength(0)
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
    expect(ensureCashAccountMock).toHaveBeenCalledWith(supabase, 'company-1', '1940', 'SEK')
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
    expect(ensureCashAccountMock).toHaveBeenCalledWith(supabase, 'company-1', '1932', 'EUR')
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
