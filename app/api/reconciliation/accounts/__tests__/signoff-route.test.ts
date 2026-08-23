/**
 * Tests for the dashboard sign-off routes (cookie session, withRouteContext):
 * GET/POST /api/reconciliation/accounts/{accountKey}/signoff and
 * POST .../signoff/{signoffId}/reopen. The policy layer is mocked; the wrapper is real.
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

const signMock = vi.fn()
const reopenMock = vi.fn()
const listMock = vi.fn()
vi.mock('@/lib/reconciliation/signoff', async () => {
  const actual = await vi.importActual<typeof import('@/lib/reconciliation/signoff')>('@/lib/reconciliation/signoff')
  return {
    ...actual,
    signOffAccount: (...args: unknown[]) => signMock(...args),
    reopenSignoff: (...args: unknown[]) => reopenMock(...args),
  }
})
vi.mock('@/lib/reconciliation/signoff-store', () => ({
  listSignoffs: (...args: unknown[]) => listMock(...args),
}))

import { ReconciliationSignoffError } from '@/lib/reconciliation/signoff'
import { GET as listGET, POST as signPOST } from '../[accountKey]/signoff/route'
import { POST as reopenPOST } from '../[accountKey]/signoff/[signoffId]/reopen/route'

const SIGNOFF_ID = '77777777-7777-4777-8777-777777777777'
const p = (obj: Record<string, string>) => ({ params: Promise.resolve(obj) }) as never

describe('dashboard sign-off routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    listMock.mockResolvedValue([{ id: SIGNOFF_ID, through_date: '2026-07-31' }])
    signMock.mockResolvedValue({ dry_run: false, signoff: { id: SIGNOFF_ID, through_date: '2026-07-31' } })
    reopenMock.mockResolvedValue({ id: SIGNOFF_ID, reopened_at: '2026-08-24T08:00:00Z' })
  })

  it('401 without a session', async () => {
    requireAuthMock.mockResolvedValue({ error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    const res = await listGET(createMockRequest('http://localhost/api/reconciliation/accounts/skattekonto/signoff'), p({ accountKey: 'skattekonto' }))
    expect(res.status).toBe(401)
  })

  it('GET lists the history and passes include_reopened / limit through', async () => {
    const res = await listGET(
      createMockRequest('http://localhost/api/reconciliation/accounts/skattekonto/signoff?include_reopened=1&limit=5'),
      p({ accountKey: 'skattekonto' }),
    )
    expect(res.status).toBe(200)
    const { body } = await parseJsonResponse<{ data: { signoffs: Array<{ id: string }> } }>(res)
    expect(body.data.signoffs[0].id).toBe(SIGNOFF_ID)
    expect(listMock).toHaveBeenCalledWith(supabase, 'company-1', 'skattekonto', { limit: 5, includeReopened: true })
  })

  it('GET 404s a malformed account key', async () => {
    const res = await listGET(createMockRequest('http://localhost/api/reconciliation/accounts/1630/signoff'), p({ accountKey: '1630' }))
    expect(res.status).toBe(404)
  })

  it('POST signs off with the validated body and forwards dry_run', async () => {
    const res = await signPOST(
      createMockRequest('http://localhost/api/reconciliation/accounts/skattekonto/signoff', { method: 'POST', body: {
        through_date: '2026-07-31',
        note: 'ok',
        dry_run: true,
      } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(res.status).toBe(200)
    expect(signMock).toHaveBeenCalledWith(
      supabase,
      'company-1',
      'user-1',
      'skattekonto',
      { through_date: '2026-07-31', note: 'ok', force: undefined },
      { dryRun: true },
    )
  })

  it('POST 400s a missing or malformed through_date', async () => {
    const res = await signPOST(
      createMockRequest('http://localhost/api/reconciliation/accounts/skattekonto/signoff', { method: 'POST', body: { through_date: '31/07/2026' } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(res.status).toBe(400)
    expect(signMock).not.toHaveBeenCalled()
  })

  it('POST maps policy refusals to 400 + code, races to 409, and a null result to 404', async () => {
    signMock.mockRejectedValueOnce(new ReconciliationSignoffError('oförklarat', 'NOT_RECONCILED'))
    const refused = await signPOST(
      createMockRequest('http://localhost/api/reconciliation/accounts/skattekonto/signoff', { method: 'POST', body: { through_date: '2026-07-31' } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(refused.status).toBe(400)
    const refusedBody = (await parseJsonResponse<{ code: string }>(refused)).body
    expect(refusedBody.code).toBe('NOT_RECONCILED')

    signMock.mockRejectedValueOnce(new ReconciliationSignoffError('race', 'SIGNOFF_RACE'))
    const raced = await signPOST(
      createMockRequest('http://localhost/api/reconciliation/accounts/skattekonto/signoff', { method: 'POST', body: { through_date: '2026-07-31' } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(raced.status).toBe(409)

    signMock.mockResolvedValueOnce(null)
    const missing = await signPOST(
      createMockRequest('http://localhost/api/reconciliation/accounts/skattekonto/signoff', { method: 'POST', body: { through_date: '2026-07-31' } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(missing.status).toBe(404)
  })

  it('POST requires write permission', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Läsbehörighet' }, { status: 403 }) })
    const res = await signPOST(
      createMockRequest('http://localhost/api/reconciliation/accounts/skattekonto/signoff', { method: 'POST', body: { through_date: '2026-07-31' } }),
      p({ accountKey: 'skattekonto' }),
    )
    expect(res.status).toBe(403)
    expect(signMock).not.toHaveBeenCalled()
  })

  it('reopen stamps the sign-off, accepts an empty body, and 404s a malformed id', async () => {
    const res = await reopenPOST(
      createMockRequest(`http://localhost/api/reconciliation/accounts/skattekonto/signoff/${SIGNOFF_ID}/reopen`, { method: 'POST' }),
      p({ accountKey: 'skattekonto', signoffId: SIGNOFF_ID }),
    )
    expect(res.status).toBe(200)
    expect(reopenMock).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'skattekonto', SIGNOFF_ID, { reason: null })

    const bad = await reopenPOST(
      createMockRequest('http://localhost/api/reconciliation/accounts/skattekonto/signoff/not-a-uuid/reopen', { method: 'POST' }),
      p({ accountKey: 'skattekonto', signoffId: 'not-a-uuid' }),
    )
    expect(bad.status).toBe(404)

    reopenMock.mockRejectedValueOnce(new ReconciliationSignoffError('redan', 'ALREADY_REOPENED'))
    const already = await reopenPOST(
      createMockRequest(`http://localhost/api/reconciliation/accounts/skattekonto/signoff/${SIGNOFF_ID}/reopen`, { method: 'POST', body: { reason: 'x' } }),
      p({ accountKey: 'skattekonto', signoffId: SIGNOFF_ID }),
    )
    expect(already.status).toBe(400)
  })
})
