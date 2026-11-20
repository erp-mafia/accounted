/**
 * GET /api/parties/[id]/open-items through the real withRouteContext: 401
 * without a session, 404 for an unparsable id or a party without a balance,
 * and the balance with setoff_enabled from COUNTERPARTY_SETOFF_ENABLED. The
 * read model is tested in lib/invoices/counterparty-setoff/__tests__.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const PARTY_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '33333333-3333-4333-8333-333333333333'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
  isCompanyAdmin: vi.fn().mockResolvedValue(true),
  companyAdminRequiredResponse: vi.fn(),
}))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({}), createServiceClient: () => ({}) }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

const loadBalance = vi.fn()
vi.mock('@/lib/invoices/counterparty-setoff/open-items', () => ({
  loadCounterpartyBalance: (...a: unknown[]) => loadBalance(...a),
}))

import { GET } from '../route'

function call(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/parties/${id}/open-items`), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireAuthMock.mockResolvedValue({ user: { id: USER_ID, email: 'a@test.se', is_anonymous: false }, supabase: {}, error: null })
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/parties/[id]/open-items', () => {
  it('answers 401 without a session', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 }),
    })
    expect((await call(PARTY_ID)).status).toBe(401)
    expect(loadBalance).not.toHaveBeenCalled()
  })

  it('answers 404 for an id it cannot parse or a party without a balance', async () => {
    expect((await call('nope')).status).toBe(404)
    loadBalance.mockResolvedValue(null)
    const res = await call(PARTY_ID)
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SETOFF_PARTY_NOT_FOUND')
  })

  it('answers the balance, with setoff_enabled following the switch', async () => {
    loadBalance.mockResolvedValue({ party: { party_id: PARTY_ID }, receivables: [], payables: [], totals: [], setoffs: [] })
    let res = await call(PARTY_ID)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { setoff_enabled: boolean } }).data.setoff_enabled).toBe(false)
    expect(loadBalance).toHaveBeenCalledWith(expect.anything(), 'company-1', { partyId: PARTY_ID })

    vi.stubEnv('COUNTERPARTY_SETOFF_ENABLED', 'true')
    res = await call(PARTY_ID)
    expect(((await res.json()) as { data: { setoff_enabled: boolean } }).data.setoff_enabled).toBe(true)
  })
})
