import { describe, it, expect, vi, beforeEach } from 'vitest'

let key = {
  id: 'key-1', orgNumber: 'x', instanceUrl: 'https://i', scopes: ['skatteverket'], status: 'active' as const,
  currentPeriodEnd: null as string | null, limits: { bank_connections_per_company: 1, skv_connections_per_company: 1, sync_min_interval_s: 0 },
}
vi.mock('@/lib/connect/hosted/with-connector-auth', () => ({
  withConnectorAuth: (_o: string, h: (r: Request, c: unknown) => Promise<Response>) => (r: Request) =>
    h(r, { requestId: 't', log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, supabase: {}, key }),
}))
const hh = vi.hoisted(() => ({ budget: vi.fn(), find: vi.fn(), touch: vi.fn() }))
vi.mock('@/lib/connect/hosted/upstream-budget', () => ({ reserveUpstream: (...a: unknown[]) => hh.budget(...a) }))
vi.mock('@/lib/connect/hosted/ledger', () => ({ findByHandle: (...a: unknown[]) => hh.find(...a), touchConnection: (...a: unknown[]) => hh.touch(...a) }))
vi.mock('@/lib/connect/upstreams/skatteverket-oauth', () => ({
  SKV_API_BASES: {
    moms: () => 'https://api.skv/momsdeklaration/v1',
    skattekonto: () => 'https://api.skv/skattekonto/v2',
    'agd-inlamning': () => 'https://api.skv/agd/inlamning/v1',
    'agd-period': () => 'https://api.skv/agd/period/v1',
  },
  skvGatewayHeaders: () => ({ Client_Id: 'gw', Client_Secret: 'gws', skv_client_correlation_id: 'corr' }),
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
import { GET, POST } from '../route'

function req(method: string, path: string, token = 'user-token', body?: string): Request {
  const headers: Record<string, string> = { 'x-connector-upstream-authorization': `Bearer ${token}` }
  return new Request(`https://app.gnubok.se/api/connect/skv/api${path}`, { method, headers, ...(body !== undefined ? { body } : {}) })
}
function skvOk(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  key = { ...key, scopes: ['skatteverket'] }
  hh.budget.mockResolvedValue({ ok: true })
  hh.find.mockResolvedValue({ id: 'l1' })
})

describe('skv data proxy', () => {
  it('rejects dot-segment traversal, raw and percent-encoded', async () => {
    // Raw ../ and %2E dot segments are normalized away by the WHATWG URL
    // parser before the route sees them (they cannot escape past the route
    // prefix). What survives to splitPath is an encoded separator INSIDE a
    // segment, which would traverse once the upstream fetch re-normalizes:
    // those must be rejected here.
    for (const path of ['/moms/a%2Fb', '/moms/..%2Fx', '/moms/a%5Cb']) {
      const res = await GET(req('GET', path))
      expect(res.status, path).toBe(403)
      expect((await res.json()).code).toBe('CONNECTOR_PATH_NOT_ALLOWED')
    }
  })

  it('403 without the scope', async () => {
    key = { ...key, scopes: [] }
    expect((await GET(req('GET', '/moms/deklarationer'))).status).toBe(403)
  })
  it('403 on an unknown service', async () => {
    const res = await GET(req('GET', '/unknown/x'))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('CONNECTOR_PATH_NOT_ALLOWED')
  })
  it('400 without a user token', async () => {
    const res = await GET(new Request('https://app.gnubok.se/api/connect/skv/api/moms/x', { method: 'GET' }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('CONNECTOR_UPSTREAM_TOKEN_MISSING')
  })
  it('404 when the token is not owned by this key', async () => {
    hh.find.mockResolvedValue(null)
    expect((await GET(req('GET', '/moms/x'))).status).toBe(404)
  })
  it('forwards a GET with the user Bearer + Arcim gateway headers to the right backing API', async () => {
    skvOk({ ok: true })
    const res = await GET(req('GET', '/skattekonto/saldo?period=2026-08'))
    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.skv/skattekonto/v2/saldo?period=2026-08')
    expect(init.headers.Authorization).toBe('Bearer user-token')
    expect(init.headers.Client_Id).toBe('gw')
    expect(hh.touch).toHaveBeenCalledWith(expect.anything(), 'l1')
  })
  it('forwards a POST body to the AGI inlämning API', async () => {
    skvOk({ id: 'u1' }, 201)
    const res = await POST(req('POST', '/agd-inlamning/underlag', 'user-token', '<xml/>'))
    expect(res.status).toBe(201)
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.skv/agd/inlamning/v1/underlag')
    expect(fetchMock.mock.calls[0][1].body).toBe('<xml/>')
  })
  it('forwards SKV diagnostic headers (WWW-Authenticate, x-skv-*) but nothing else', async () => {
    // The instance's 401 classifier reads WWW-Authenticate (insufficient_scope
    // → MISSING_SCOPE) and the x-skv-* family on body-less gateway
    // rejections; stripping them blinded connector-mode classification.
    fetchMock.mockResolvedValueOnce(new Response('', {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="agd"',
        'x-skv-trace': 'abc',
        'x-amzn-requestid': 'req-1',
        'set-cookie': 'secret=1',
        'x-internal-other': 'nope',
      },
    }))
    const res = await GET(req('GET', '/moms/x'))
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer error="insufficient_scope", scope="agd"')
    expect(res.headers.get('x-skv-trace')).toBe('abc')
    expect(res.headers.get('x-amzn-requestid')).toBe('req-1')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-internal-other')).toBeNull()
  })

  it('429 when the budget is exhausted', async () => {
    hh.budget.mockResolvedValue({ ok: false, scope: 'hour', retryAfterSec: 3600 })
    const res = await GET(req('GET', '/moms/x'))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('3600')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
