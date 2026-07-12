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
      expect.objectContaining({ accountNumber: '1930', currency: 'SEK', dryRun: false }),
    )
  })
})
