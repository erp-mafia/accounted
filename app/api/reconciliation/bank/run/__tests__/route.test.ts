/**
 * Tests for POST /api/reconciliation/bank/run.
 *
 * Exercises the route through the real withRouteContext wrapper, mocking only
 * its auth/company/write dependencies plus the runReconciliation service.
 * Covers: 401, 403 viewer, unknown cash account (400), and the happy path.
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

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const runReconciliationMock = vi.fn()
vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  runReconciliation: (...args: unknown[]) => runReconciliationMock(...args),
  DEFAULT_UNATTENDED_CONFIDENCE_THRESHOLD: 0.9,
}))

const sweepMock = vi.fn()
vi.mock('@/lib/reconciliation/unattended-sweep', () => ({
  runUnattendedReconciliationSweep: (...args: unknown[]) => sweepMock(...args),
}))

import { POST } from '../route'

const emptyParams = { params: Promise.resolve({}) }

describe('POST /api/reconciliation/bank/run', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    runReconciliationMock.mockResolvedValue({ matches: [], applied: 0, errors: [] })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: { dry_run: true },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(401)
  })

  it('returns 403 for a viewer', async () => {
    requireWriteMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
    })

    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: { dry_run: true },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(403)
  })

  it('rejects an out-of-range confidence_threshold with 400', async () => {
    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: { dry_run: false, confidence_threshold: 1.5 },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
    expect(runReconciliationMock).not.toHaveBeenCalled()
  })

  it('rejects a negative confidence_threshold with 400', async () => {
    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: { dry_run: false, confidence_threshold: -0.1 },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
    expect(runReconciliationMock).not.toHaveBeenCalled()
  })

  it('passes confidence_threshold and selected_matches through to runReconciliation', async () => {
    // cash_accounts lookup: no row, '1930' default is exempt.
    enqueue({ data: null })

    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: {
        dry_run: false,
        confidence_threshold: 0.85,
        selected_matches: [
          {
            transaction_id: '11111111-1111-4111-8111-111111111111',
            journal_entry_id: '22222222-2222-4222-8222-222222222222',
          },
        ],
      },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(200)
    expect(runReconciliationMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({
        confidenceThreshold: 0.85,
        applyOnly: [
          {
            transactionId: '11111111-1111-4111-8111-111111111111',
            journalEntryId: '22222222-2222-4222-8222-222222222222',
          },
        ],
      }),
    )
  })

  it('defaults a no-selection apply to the 0.9 unattended floor when the client sends no threshold', async () => {
    // Merged semantics (#1571 x bank-and-sie-match): an explicit
    // confidence_threshold always wins; WITHOUT one, an apply with no
    // selected_matches is effectively unattended, so it floors at 0.9 and
    // persists the review band instead of auto-committing fuzzy matches.
    // cash_accounts lookup: no row, '1930' default is exempt.
    enqueue({ data: null })

    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: { dry_run: false },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(200)
    expect(runReconciliationMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ confidenceThreshold: 0.9, persistSuggestions: true }),
    )
  })

  it('rejects a non-default account with no cash_accounts row', async () => {
    // cash_accounts lookup finds nothing for 1932.
    enqueue({ data: null })

    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: { account_number: '1932', dry_run: true },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect(body.error).toBe('Okänt kassakonto för det här företaget')
    expect(runReconciliationMock).not.toHaveBeenCalled()
  })

  it('runs reconciliation on the default 1930 account even without a cash_accounts row', async () => {
    // cash_accounts lookup: no row, but '1930' is exempt.
    enqueue({ data: null })
    runReconciliationMock.mockResolvedValue({
      matches: [
        {
          transaction: { id: 't-1', date: '2024-06-15', description: 'Betalning', amount: 1250 },
          glLine: {
            journal_entry_id: 'je-1',
            voucher_number: 12,
            voucher_series: 'A',
            entry_date: '2024-06-15',
            entry_description: 'Kundfaktura',
          },
          method: 'exact',
          confidence: 1,
        },
      ],
      applied: 1,
      errors: [],
    })

    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: { date_from: '2024-06-01', date_to: '2024-06-30' },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{
      data: { matches: { transaction_id: string }[]; applied: number; dry_run: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.applied).toBe(1)
    expect(body.data.dry_run).toBe(false)
    expect(body.data.matches[0].transaction_id).toBe('t-1')
    expect(runReconciliationMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      // A no-selection apply run persists the review band as suggestions
      // behind the unattended confidence floor ("Kör matchning igen").
      expect.objectContaining({
        accountNumber: '1930',
        currency: 'SEK',
        dryRun: false,
        confidenceThreshold: 0.9,
        persistSuggestions: true,
      }),
    )
  })

  it('keeps the legacy no-threshold behavior for a reviewed selected_matches apply', async () => {
    // cash_accounts lookup: no row, '1930' exempt.
    enqueue({ data: null })
    runReconciliationMock.mockResolvedValue({
      matches: [],
      applied: 0,
      errors: 0,
      skippedBelowThreshold: 0,
      suggested: 0,
      candidates: 0,
    })

    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: {
        selected_matches: [
          {
            transaction_id: '11111111-1111-4111-8111-111111111111',
            journal_entry_id: '22222222-2222-4222-8222-222222222222',
          },
        ],
      },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(200)

    const options = runReconciliationMock.mock.calls[0][3] as Record<string, unknown>
    expect(options.applyOnly).toHaveLength(1)
    // The user already reviewed these pairs in the dry-run preview: no floor,
    // no suggestion persistence.
    expect(options.confidenceThreshold).toBeUndefined()
    expect(options.persistSuggestions).toBeUndefined()
  })

  it('routes all_accounts to the per-account sweep ("Kör matchning igen")', async () => {
    sweepMock.mockResolvedValue({
      accounts: [
        { accountNumber: '1930', applied: 3, suggested: 1 },
        { accountNumber: '1931', applied: 1, suggested: 0 },
      ],
      applied: 4,
      errors: 0,
      skippedBelowThreshold: 1,
      suggested: 1,
      unmatched: 2,
    })

    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: { all_accounts: true },
    })

    const response = await POST(request, emptyParams)
    const { status, body } = await parseJsonResponse<{
      data: { applied: number; suggested: number; unmatched: number }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.applied).toBe(4)
    expect(body.data.suggested).toBe(1)
    expect(body.data.unmatched).toBe(2)
    expect(sweepMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', {
      dateFrom: undefined,
      dateTo: undefined,
    })
    expect(runReconciliationMock).not.toHaveBeenCalled()
  })

  it('rejects all_accounts combined with dry_run: the sweep has no preview form and must never apply on a requested preview', async () => {
    const request = createMockRequest('/api/reconciliation/bank/run', {
      method: 'POST',
      body: { all_accounts: true, dry_run: true },
    })

    const response = await POST(request, emptyParams)
    expect(response.status).toBe(400)
    expect(sweepMock).not.toHaveBeenCalled()
    expect(runReconciliationMock).not.toHaveBeenCalled()
  })

  it('rejects all_accounts combined with account_number or selected_matches', async () => {
    for (const body of [
      { all_accounts: true, account_number: '1930' },
      { all_accounts: true, confidence_threshold: 0.85 },
      {
        all_accounts: true,
        selected_matches: [
          {
            transaction_id: '11111111-1111-4111-8111-111111111111',
            journal_entry_id: '22222222-2222-4222-8222-222222222222',
          },
        ],
      },
    ]) {
      const request = createMockRequest('/api/reconciliation/bank/run', { method: 'POST', body })
      const response = await POST(request, emptyParams)
      expect(response.status).toBe(400)
    }
    expect(sweepMock).not.toHaveBeenCalled()
  })
})
