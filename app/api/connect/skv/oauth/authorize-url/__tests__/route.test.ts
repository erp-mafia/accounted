import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

let key = {
  id: 'key-1', orgNumber: '5561234567', instanceUrl: 'https://bokforing.example.se',
  scopes: ['skatteverket'], status: 'active' as const, currentPeriodEnd: null as string | null,
  limits: { bank_connections_per_company: 1, skv_connections_per_company: 1, sync_min_interval_s: 0 },
}
vi.mock('@/lib/connect/hosted/with-connector-auth', () => ({
  withConnectorAuth: (_o: string, h: (r: Request, c: unknown) => Promise<Response>) => (r: Request) =>
    h(r, { requestId: 't', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, supabase: {}, key }),
}))
const hh = vi.hoisted(() => ({ budget: vi.fn(), count: vi.fn(), deletePending: vi.fn(), pending: vi.fn() }))
vi.mock('@/lib/connect/hosted/upstream-budget', () => ({ reserveUpstream: (...a: unknown[]) => hh.budget(...a) }))
vi.mock('@/lib/connect/hosted/ledger', () => ({ countHeldConnections: (...a: unknown[]) => hh.count(...a), deletePendingConnectionById: (...a: unknown[]) => hh.deletePending(...a), createPendingConnection: (...a: unknown[]) => hh.pending(...a) }))
vi.mock('@/lib/connect/hosted/state', () => ({ signConnectorState: () => 'ck1.signed' }))
vi.mock('@/lib/connect/upstreams/skatteverket-oauth', () => ({
  buildSkvAuthorizeUrl: (redirectUri: string, state: string) => `https://skv/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
  skvDefaultScopes: () => 'moms agd',
}))
import { POST } from '../route'

const body = (o: Record<string, unknown> = {}) => ({
  company_ref: 'company-1', return_url: 'https://bokforing.example.se/cb', state: 'inst', code_challenge: 'a'.repeat(43), ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_SKV_OAUTH_BASE_URL = 'https://app.gnubok.se'
  key = { ...key, scopes: ['skatteverket'], limits: { bank_connections_per_company: 1, skv_connections_per_company: 1, sync_min_interval_s: 0 } }
  hh.budget.mockResolvedValue({ ok: true })
  hh.count.mockResolvedValue(0)
})

describe('POST /api/connect/skv/oauth/authorize-url', () => {
  it('403 without the skatteverket scope', async () => {
    key = { ...key, scopes: [] }
    const res = await POST(createMockRequest('/api/connect/skv/oauth/authorize-url', { method: 'POST', body: body() }))
    expect(res.status).toBe(403)
  })
  it('400 on a return_url off the instance', async () => {
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body({ return_url: 'https://evil.example.com/cb' }) }))
    const { status, body: b } = await parseJsonResponse<{ code: string }>(res)
    expect(status).toBe(400)
    expect(b.code).toBe('CONNECTOR_REDIRECT_INVALID')
  })
  it('403 when the per-company SKV quota is reached', async () => {
    hh.count.mockResolvedValue(1)
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body() }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CONNECTOR_QUOTA_EXCEEDED')
  })
  it('records a pending row and returns the authorize URL with our redirect + signed state', async () => {
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body() }))
    const { status, body: b } = await parseJsonResponse<{ data: { authorize_url: string; redirect_uri: string; connector_state: string } }>(res)
    expect(status).toBe(200)
    expect(hh.pending).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ service: 'skatteverket', companyRef: 'company-1', pendingState: 'ck1.signed' }))
    expect(b.data.redirect_uri).toBe('https://app.gnubok.se/api/extensions/ext/skatteverket/callback')
    expect(b.data.connector_state).toBe('ck1.signed')
    expect(b.data.authorize_url).toContain('state=ck1.signed')
  })
  it('429 when the budget is exhausted', async () => {
    hh.budget.mockResolvedValue({ ok: false, scope: 'minute', retryAfterSec: 60 })
    const res = await POST(createMockRequest('/x', { method: 'POST', body: body() }))
    expect(res.status).toBe(429)
  })
})
