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

const { supabase, enqueue, reset } = createQueuedMockSupabase()

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
