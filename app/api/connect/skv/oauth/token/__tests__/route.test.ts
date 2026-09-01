import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

let key = {
  id: 'key-1', orgNumber: 'x', instanceUrl: 'https://i', scopes: ['skatteverket'], status: 'active' as const,
  currentPeriodEnd: null as string | null, limits: { bank_connections_per_company: 1, skv_connections_per_company: 1, sync_min_interval_s: 0 },
}
const chain = { update: vi.fn(() => chain), eq: vi.fn(() => chain), then: (r: (v: unknown) => void) => r({ error: null }) }
const supabase = { from: vi.fn(() => chain) }
vi.mock('@/lib/connect/hosted/with-connector-auth', () => ({
  withConnectorAuth: (_o: string, h: (r: Request, c: unknown) => Promise<Response>) => (r: Request) =>
    h(r, { requestId: 't', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, supabase, key }),
}))
const hh = vi.hoisted(() => ({
  budget: vi.fn(),
  exchange: vi.fn(),
  refresh: vi.fn(),
  activate: vi.fn(),
  findPending: vi.fn(),
  findRefresh: vi.fn(),
}))
vi.mock('@/lib/connect/hosted/upstream-budget', () => ({ reserveUpstream: (...a: unknown[]) => hh.budget(...a) }))
vi.mock('@/lib/connect/upstreams/skatteverket-oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connect/upstreams/skatteverket-oauth')>()
  return {
    exchangeSkvCode: (...a: unknown[]) => hh.exchange(...a),
    refreshSkvToken: (...a: unknown[]) => hh.refresh(...a),
    // The dead-dialect classifier stays REAL: these tests pin that the route
    // re-codes exactly the dialects the classifier recognizes.
    isSkvDeadRefreshTokenError: actual.isSkvDeadRefreshTokenError,
  }
})
vi.mock('@/lib/connect/hosted/ledger', () => ({
  activateByPendingState: (...a: unknown[]) => hh.activate(...a),
  findPendingByState: (...a: unknown[]) => hh.findPending(...a),
  findByRefreshHash: (...a: unknown[]) => hh.findRefresh(...a),
  hashHandle: (s: string) => `h(${s})`,
}))
vi.mock('@/lib/connect/hosted/state', () => ({
  verifyConnectorState: (token: string) =>
    token === 'ck1.signed'
      ? { ok: true, payload: { kid: 'key-1', svc: 'skv', ret: 'https://i/cb', st: 's', cref: 'c1', iat: 0 } }
      : token === 'ck1.foreign'
        ? { ok: true, payload: { kid: 'key-OTHER', svc: 'skv', ret: 'x', st: 's', cref: 'c', iat: 0 } }
        : { ok: false, reason: 'malformed' },
}))
import { POST } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  key = { ...key, scopes: ['skatteverket'] }
  hh.budget.mockResolvedValue({ ok: true })
  hh.findPending.mockResolvedValue({ id: 'p1', status: 'pending' })
  hh.activate.mockResolvedValue({ id: 'p1', status: 'active' })
  hh.findRefresh.mockResolvedValue({ id: 'r1', status: 'active' })
})

describe('POST /api/connect/skv/oauth/token', () => {
  it('exchanges an authorization code, activates the ledger row, returns tokens', async () => {
    hh.exchange.mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' })
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.gnubok.se/cb', code_verifier: 'v'.repeat(20), connector_state: 'ck1.signed' } }))
    const { status, body } = await parseJsonResponse<{ data: { access_token: string; refresh_token: string } }>(res)
    expect(status).toBe(200)
    expect(body.data).toEqual({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' })
    expect(hh.activate).toHaveBeenCalledWith(supabase, { keyId: 'key-1', pendingState: 'ck1.signed', handle: 'at' })
  })

  it('refuses an invalid or foreign connector state before spending the client secret', async () => {
    let res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.gnubok.se/cb', connector_state: 'garbage' } }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('CONNECTOR_STATE_INVALID')
    res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.gnubok.se/cb', connector_state: 'ck1.foreign' } }))
    expect(res.status).toBe(403)
    hh.findPending.mockResolvedValue(null)
    res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.gnubok.se/cb', connector_state: 'ck1.signed' } }))
    expect(res.status).toBe(404)
    expect(hh.exchange).not.toHaveBeenCalled()
  })

  it('withholds tokens with 409 when the state was consumed concurrently', async () => {
    hh.exchange.mockResolvedValue({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' })
    hh.activate.mockResolvedValue(null)
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.gnubok.se/cb', connector_state: 'ck1.signed' } }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('CONNECTOR_STATE_CONSUMED')
  })

  it('refreshes only a refresh token owned by this key (rotates the ledger hashes)', async () => {
    hh.refresh.mockResolvedValue({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, scope: 's' })
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: 'rt' } }))
    expect(res.status).toBe(200)
    expect(hh.findRefresh).toHaveBeenCalledWith(supabase, { keyId: 'key-1', refreshHash: 'h(rt)' })
    expect(supabase.from).toHaveBeenCalledWith('connector_connections')
  })

  it('404s a refresh token with no active ledger row for this key, never calling upstream', async () => {
    hh.findRefresh.mockResolvedValue(null)
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: 'stolen-rt' } }))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('CONNECTOR_NOT_OWNED')
    expect(hh.refresh).not.toHaveBeenCalled()
  })

  it('400 on an invalid grant shape', async () => {
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'client_credentials' } }))
    expect(res.status).toBe(400)
  })

  it('502 when the upstream exchange fails', async () => {
    hh.exchange.mockRejectedValue(new Error('boom'))
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.gnubok.se/cb', connector_state: 'ck1.signed' } }))
    expect(res.status).toBe(502)
  })

  // SKV per-flow refresh tokens live 65 minutes, so a dead refresh token is
  // the DOMINANT refresh outcome. The broker must re-code SKV's terminal
  // dialects distinctly: the instance maps this to SESSION_EXPIRED and shows
  // its reconnect flow. Collapsing it into the generic 502 stripped every
  // connector instance of that flow (skeptic refutation on PR6b-2).
  it('401 CONNECTOR_SKV_REFRESH_DEAD when SKV declares the refresh token dead', async () => {
    hh.refresh.mockRejectedValue(new Error(
      'Skatteverket token refresh failed (404): {"error":"id_not_found","error_description":"The refresh token is not found"}',
    ))
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: 'rt' } }))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('CONNECTOR_SKV_REFRESH_DEAD')
  })

  it('401 CONNECTOR_SKV_REFRESH_DEAD on the 400 invalid_grant dialect too', async () => {
    hh.refresh.mockRejectedValue(new Error(
      'Skatteverket token refresh failed (400): {"error": "invalid_grant"}',
    ))
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: 'rt' } }))
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('CONNECTOR_SKV_REFRESH_DEAD')
  })

  it('keeps transient refresh failures as the generic 502 (never a reconnect signal)', async () => {
    hh.refresh.mockRejectedValue(new Error('Skatteverket token refresh failed (503): upstream unavailable'))
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: 'rt' } }))
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('CONNECTOR_SKV_TOKEN_FAILED')
  })

  it('does NOT re-code a dead-dialect failure on the authorization_code grant', async () => {
    // An expired one-shot code also answers 400 invalid_grant, but that is
    // not "refresh token dead": the exchange keeps the generic 502.
    hh.exchange.mockRejectedValue(new Error(
      'Skatteverket token exchange failed (400): {"error": "invalid_grant"}',
    ))
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'authorization_code', code: 'c', redirect_uri: 'https://app.gnubok.se/cb', connector_state: 'ck1.signed' } }))
    expect(res.status).toBe(502)
    expect((await res.json()).code).toBe('CONNECTOR_SKV_TOKEN_FAILED')
  })
})
