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
const hh = vi.hoisted(() => ({ budget: vi.fn(), exchange: vi.fn(), refresh: vi.fn(), activate: vi.fn() }))
vi.mock('@/lib/connect/hosted/upstream-budget', () => ({ reserveUpstream: (...a: unknown[]) => hh.budget(...a) }))
vi.mock('@/lib/connect/upstreams/skatteverket-oauth', () => ({ exchangeSkvCode: (...a: unknown[]) => hh.exchange(...a), refreshSkvToken: (...a: unknown[]) => hh.refresh(...a) }))
vi.mock('@/lib/connect/hosted/ledger', () => ({ activateByPendingState: (...a: unknown[]) => hh.activate(...a), hashHandle: (s: string) => `h(${s})` }))
import { POST } from '../route'

beforeEach(() => {
  vi.clearAllMocks()
  key = { ...key, scopes: ['skatteverket'] }
  hh.budget.mockResolvedValue({ ok: true })
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
  it('refreshes and rotates the ledger hashes', async () => {
    hh.refresh.mockResolvedValue({ access_token: 'at2', refresh_token: 'rt2', expires_in: 3600, scope: 's' })
    const res = await POST(createMockRequest('/x', { method: 'POST', body: { grant_type: 'refresh_token', refresh_token: 'rt' } }))
    expect(res.status).toBe(200)
    expect(supabase.from).toHaveBeenCalledWith('connector_connections')
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
})
