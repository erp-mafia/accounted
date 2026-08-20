import { describe, it, expect, vi, beforeEach } from 'vitest'

let currentKey = {
  id: 'key-1',
  orgNumber: '5561234567',
  instanceUrl: 'https://bokforing.example.se',
  scopes: ['bank_sync'],
  status: 'active' as const,
  currentPeriodEnd: null as string | null,
  limits: { bank_connections_per_company: 1, skv_connections_per_company: 1, sync_min_interval_s: 0 },
}
vi.mock('@/lib/connect/hosted/with-connector-auth', () => ({
  withConnectorAuth: (_op: string, handler: (req: Request, ctx: unknown) => Promise<Response>) => (req: Request) =>
    handler(req, { requestId: 'conn_test', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, supabase: {}, key: currentKey }),
}))
vi.mock('@/lib/connect/upstreams/enable-banking-jwt', () => ({ getAuthorizationHeader: () => 'Bearer eb-jwt' }))
const h = vi.hoisted(() => ({
  budget: vi.fn(),
  ledger: {
    countActiveConnections: vi.fn(),
    createPendingConnection: vi.fn(),
    activateByPendingState: vi.fn(),
    findByHandle: vi.fn(),
    findByAccountUid: vi.fn(),
    revokeByHandle: vi.fn(),
    touchConnection: vi.fn(),
  },
}))
const budget = h.budget
const ledger = h.ledger
vi.mock('@/lib/connect/hosted/upstream-budget', () => ({ reserveUpstream: (...a: unknown[]) => h.budget(...a) }))
vi.mock('@/lib/connect/hosted/ledger', () => h.ledger)
vi.mock('@/lib/connect/hosted/state', () => ({ signConnectorState: () => 'ck1.signed.state' }))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

import { GET, POST, DELETE } from '../route'

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.gnubok.se/api/connect/bank${path}`, {
    method,
    headers: { 'x-connector-company': 'company-1', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
function ebOk(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.ENABLE_BANKING_API_URL = 'https://api.enablebanking.com'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.gnubok.se'
  currentKey = { ...currentKey, scopes: ['bank_sync'], limits: { bank_connections_per_company: 1, skv_connections_per_company: 1, sync_min_interval_s: 0 } }
  budget.mockResolvedValue({ ok: true })
})

describe('bank proxy', () => {
  it('403s when the key lacks the bank_sync scope', async () => {
    currentKey = { ...currentKey, scopes: [] }
    const res = await GET(req('GET', '/aspsps'))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CONNECTOR_SCOPE_MISSING')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('forwards GET /aspsps with the EB JWT', async () => {
    ebOk({ aspsps: [] })
    const res = await GET(req('GET', '/aspsps?country=SE'))
    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.enablebanking.com/aspsps?country=SE')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer eb-jwt')
  })

  it('refuses an unknown path', async () => {
    const res = await GET(req('GET', '/accounts'))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CONNECTOR_PATH_NOT_ALLOWED')
  })

  it('POST /auth rewrites redirect + state, checks quota, records a pending row', async () => {
    ledger.countActiveConnections.mockResolvedValue(0)
    ebOk({ url: 'https://bank.example/consent', authorization_id: 'a1' })
    const res = await POST(req('POST', '/auth', {
      aspsp: { name: 'SEB', country: 'SE' },
      redirect_url: 'https://bokforing.example.se/api/extensions/enable-banking/callback',
      state: 'inst-state',
    }))
    expect(res.status).toBe(200)
    expect(ledger.createPendingConnection).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ keyId: 'key-1', service: 'bank', companyRef: 'company-1', provider: 'SEB', pendingState: 'ck1.signed.state' }))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.redirect_url).toBe('https://app.gnubok.se/api/extensions/enable-banking/callback')
    expect(body.state).toBe('ck1.signed.state')
  })

  it('POST /auth rejects a redirect_url off the pinned instance', async () => {
    const res = await POST(req('POST', '/auth', { aspsp: { name: 'SEB', country: 'SE' }, redirect_url: 'https://evil.example.com/cb', state: 's' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('CONNECTOR_REDIRECT_INVALID')
    expect(ledger.createPendingConnection).not.toHaveBeenCalled()
  })

  it('POST /auth 403s when the per-company quota is reached', async () => {
    ledger.countActiveConnections.mockResolvedValue(1)
    const res = await POST(req('POST', '/auth', { aspsp: { name: 'SEB', country: 'SE' }, redirect_url: 'https://bokforing.example.se/cb', state: 's' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'CONNECTOR_QUOTA_EXCEEDED', limit: 1 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POST /auth 400s without the company header', async () => {
    const res = await POST(new Request('https://app.gnubok.se/api/connect/bank/auth', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('CONNECTOR_COMPANY_MISSING')
  })

  it('POST /sessions activates the ledger row from the connector_state', async () => {
    ebOk({ session_id: 'sess-9', accounts: [{ uid: 'acc-1' }, { uid: 'acc-2' }] })
    const res = await POST(req('POST', '/sessions', { code: 'auth-code', connector_state: 'ck1.signed.state' }))
    expect(res.status).toBe(200)
    expect(ledger.activateByPendingState).toHaveBeenCalledWith(expect.anything(), { keyId: 'key-1', pendingState: 'ck1.signed.state', handle: 'sess-9', accountUids: ['acc-1', 'acc-2'] })
  })

  it('GET /sessions/{id} requires ownership', async () => {
    ledger.findByHandle.mockResolvedValueOnce(null)
    expect((await GET(req('GET', '/sessions/sess-x'))).status).toBe(404)
    ledger.findByHandle.mockResolvedValueOnce({ id: 'l1' })
    ebOk({ session_id: 'sess-x' })
    expect((await GET(req('GET', '/sessions/sess-x'))).status).toBe(200)
    expect(ledger.touchConnection).toHaveBeenCalledWith(expect.anything(), 'l1')
  })

  it('GET /accounts/{uid}/transactions requires account ownership', async () => {
    ledger.findByAccountUid.mockResolvedValueOnce(null)
    expect((await GET(req('GET', '/accounts/acc-1/transactions'))).status).toBe(404)
    ledger.findByAccountUid.mockResolvedValueOnce({ id: 'l2' })
    ebOk({ transactions: [] })
    const res = await GET(req('GET', '/accounts/acc-1/transactions?date_from=2026-01-01'))
    expect(res.status).toBe(200)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.enablebanking.com/accounts/acc-1/transactions?date_from=2026-01-01')
  })

  it('DELETE /sessions/{id} revokes the ledger row after the upstream delete', async () => {
    ledger.findByHandle.mockResolvedValueOnce({ id: 'l3' })
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    const res = await DELETE(req('DELETE', '/sessions/sess-z'))
    expect(res.status).toBe(204)
    expect(ledger.revokeByHandle).toHaveBeenCalledWith(expect.anything(), { keyId: 'key-1', service: 'bank', handle: 'sess-z' })
  })

  it('returns 429 with Retry-After when the global budget is exhausted', async () => {
    budget.mockResolvedValue({ ok: false, scope: 'minute', retryAfterSec: 60 })
    const res = await GET(req('GET', '/aspsps'))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
