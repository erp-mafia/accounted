/**
 * Tests for POST /api/reconciliation/accounts/{accountKey}/residual (cookie
 * session, withRouteContext). The residual engine is mocked; the wrapper is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

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

const residualMock = vi.fn()
vi.mock('@/lib/reconciliation/residual', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/residual')>('@/lib/reconciliation/residual')
  return { ...actual, bookResidualAndLink: (...args: unknown[]) => residualMock(...args) }
})

import { ReconciliationResidualError } from '@/lib/reconciliation/residual'
import { POST } from '../[accountKey]/residual/route'

const CASH = '11111111-1111-4111-8111-111111111111'
const KEY = `bank:${CASH}`
const T1 = '22222222-2222-4222-8222-222222222222'
const E1 = '44444444-4444-4444-8444-444444444444'
const URL = `http://localhost/api/reconciliation/accounts/${KEY}/residual`
const p = (obj: Record<string, string>) => ({ params: Promise.resolve(obj) }) as never
const body = { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee' }

describe('POST /api/reconciliation/accounts/{accountKey}/residual', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    residualMock.mockResolvedValue({ dry_run: false, residual_journal_entry_id: 'res-1', residual_amount: -10, applied: [], skipped: [] })
  })

  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await POST(createMockRequest(URL, { method: 'POST', body }), p({ accountKey: KEY }))
    expect(res.status).toBe(401)
  })

  it('400 on a body without kind, 404 on a malformed key', async () => {
    const bad = await POST(createMockRequest(URL, { method: 'POST', body: { external_ids: [T1], journal_entry_id: E1 } }), p({ accountKey: KEY }))
    expect(bad.status).toBe(400)
    const badKey = await POST(createMockRequest(URL, { method: 'POST', body }), p({ accountKey: '1930' }))
    expect(badKey.status).toBe(404)
    expect(residualMock).not.toHaveBeenCalled()
  })

  it('books and links, forwarding dry_run', async () => {
    const res = await POST(createMockRequest(URL, { method: 'POST', body: { ...body, dry_run: true } }), p({ accountKey: KEY }))
    expect(res.status).toBe(200)
    expect(residualMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      KEY,
      { external_ids: [T1], journal_entry_id: E1, kind: 'bank_fee', entry_date: undefined, description: undefined },
      { dryRun: true },
    )
    const { body: out } = await parseJsonResponse<{ data: { residual_journal_entry_id: string } }>(res)
    expect(out.data.residual_journal_entry_id).toBe('res-1')
  })

  it('maps refusals to 400 + code, missing rows to 404, unknown account to 404, and requires write', async () => {
    residualMock.mockRejectedValueOnce(new ReconciliationResidualError('för stort', 'RESIDUAL_TOO_LARGE'))
    const refused = await POST(createMockRequest(URL, { method: 'POST', body }), p({ accountKey: KEY }))
    expect(refused.status).toBe(400)
    expect((await parseJsonResponse<{ code: string }>(refused)).body.code).toBe('RESIDUAL_TOO_LARGE')

    residualMock.mockRejectedValueOnce(new ReconciliationResidualError('saknas', 'RESIDUAL_ROWS_NOT_FOUND'))
    const missingRows = await POST(createMockRequest(URL, { method: 'POST', body }), p({ accountKey: KEY }))
    expect(missingRows.status).toBe(404)

    residualMock.mockResolvedValueOnce(null)
    const unknown = await POST(createMockRequest(URL, { method: 'POST', body }), p({ accountKey: KEY }))
    expect(unknown.status).toBe(404)

    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Läsbehörighet' }, { status: 403 }) })
    const forbidden = await POST(createMockRequest(URL, { method: 'POST', body }), p({ accountKey: KEY }))
    expect(forbidden.status).toBe(403)
  })
})
