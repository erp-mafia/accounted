import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

let selfHosted = true
vi.mock('@/lib/env/public-flags', () => ({ isSelfHosted: () => selfHosted }))
vi.mock('@/lib/api/with-route-context', () => ({
  withRouteContext: (_op: string, handler: (req: unknown, ctx: unknown) => unknown) => (req: unknown) =>
    handler(req, { supabase: {}, companyId: 'company-1', user: { id: 'u1' } }),
}))
const held = vi.fn()
vi.mock('@/lib/entitlements/has-capability', () => ({ getCompanyIdsWithCapability: (...a: unknown[]) => held(...a) }))

import { GET } from '../route'

const ENV = ['GNUBOK_CONNECTOR_KEY', 'GNUBOK_CONNECT_URL', 'ENABLE_BANKING_APP_ID', 'SKATTEVERKET_APIGW_CLIENT_ID'] as const
beforeEach(() => {
  vi.clearAllMocks()
  selfHosted = true
  for (const k of ENV) vi.stubEnv(k, '')
  held.mockResolvedValue(new Set())
})
afterEach(() => vi.unstubAllEnvs())

describe('GET /api/connector/status', () => {
  it('reports self_hosted:false on hosted', async () => {
    selfHosted = false
    const { body } = await parseJsonResponse<{ data: { self_hosted: boolean } }>(await GET(createMockRequest('/api/connector/status'), { params: Promise.resolve({}) }))
    expect(body.data.self_hosted).toBe(false)
  })

  it('reports unconfigured when no key is set', async () => {
    const { body } = await parseJsonResponse<{ data: { configured: boolean; upstreams: Record<string, string> } }>(await GET(createMockRequest('/x'), { params: Promise.resolve({}) }))
    expect(body.data.configured).toBe(false)
    expect(body.data.upstreams).toEqual({ bank: 'unconfigured', skatteverket: 'unconfigured' })
  })

  it('reports connector mode per upstream and the key prefix (never the key)', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_secretsecret')
    held.mockImplementation((_s: unknown, _ids: unknown, cap: string) => Promise.resolve(cap === 'bank_sync' ? new Set(['company-1']) : new Set()))
    const { body } = await parseJsonResponse<{ data: { configured: boolean; key_prefix: string; upstreams: Record<string, string>; granted_capabilities: string[] } }>(await GET(createMockRequest('/x'), { params: Promise.resolve({}) }))
    expect(body.data.configured).toBe(true)
    expect(body.data.key_prefix).toBe('gnubok_ck_sec')
    expect(body.data.key_prefix).not.toContain('secretsecret')
    expect(body.data.upstreams).toEqual({ bank: 'connector', skatteverket: 'connector' })
    expect(body.data.granted_capabilities).toEqual(['bank_sync'])
  })

  it('reports own_credentials for an upstream configured directly on the instance', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    vi.stubEnv('ENABLE_BANKING_APP_ID', 'app')
    const { body } = await parseJsonResponse<{ data: { upstreams: Record<string, string> } }>(await GET(createMockRequest('/x'), { params: Promise.resolve({}) }))
    expect(body.data.upstreams.bank).toBe('own_credentials')
    expect(body.data.upstreams.skatteverket).toBe('connector')
  })
})
