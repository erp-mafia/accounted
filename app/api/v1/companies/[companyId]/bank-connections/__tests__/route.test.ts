/**
 * Tests for GET /api/v1/companies/{companyId}/bank-connections.
 *
 * Exercises the real withApiV1 wrapper (auth, scope, company membership)
 * with the Supabase client mocked.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BASE = `http://localhost/api/v1/companies/${COMPANY_ID}/bank-connections`

const CONNECTION_ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  bank_name: 'Swedbank',
  status: 'active',
  created_at: '2026-08-01T00:00:00Z',
  last_synced_at: '2026-08-31T05:04:12Z',
  consent_expires: '2026-11-01T00:00:00Z',
  error_message: null,
}

function req(): Request {
  return new Request(BASE, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

function authOk(scopes: string[]) {
  mockValidate.mockResolvedValue({
    valid: true,
    userId: 'user-1',
    keyId: 'key-1',
    keyName: 'Test key',
    scopes,
    mode: 'live',
  })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

describe('v1 bank-connections list', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { role: 'owner' } },
        bank_connections: { data: [CONNECTION_ROW] },
      }),
    )
  })

  it('401 without a valid key', async () => {
    mockValidate.mockResolvedValue({ valid: false, error: 'invalid' })
    const res = await GET(req(), params)
    expect(res.status).toBe(401)
  })

  it('403 INSUFFICIENT_SCOPE when the key lacks companies:read', async () => {
    authOk(['transactions:read'])
    const res = await GET(req(), params)
    expect(res.status).toBe(403)
  })

  it('404 when the key user is not a member of the company', async () => {
    authOk(['companies:read'])
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: null },
      }),
    )
    const res = await GET(req(), params)
    expect(res.status).toBe(404)
  })

  it('returns connections with freshness fields under qualified names', async () => {
    authOk(['companies:read'])
    const res = await GET(req(), params)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { bank_connections: Array<Record<string, unknown>> }
      meta: { request_id: string }
    }
    expect(body.data.bank_connections).toEqual([
      {
        connection_id: '11111111-1111-4111-8111-111111111111',
        bank: 'Swedbank',
        status: 'active',
        since: '2026-08-01T00:00:00Z',
        last_synced_at: '2026-08-31T05:04:12Z',
        consent_expires: '2026-11-01T00:00:00Z',
        error_message: null,
      },
    ])
    expect(body.meta.request_id).toMatch(/^req_/)
  })

  it('returns an empty list when the company has no connections', async () => {
    authOk(['companies:read'])
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { role: 'owner' } },
        bank_connections: { data: [] },
      }),
    )
    const res = await GET(req(), params)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { bank_connections: unknown[] } }
    expect(body.data.bank_connections).toEqual([])
  })

  it('maps a database error into the v1 error envelope', async () => {
    authOk(['companies:read'])
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { role: 'owner' } },
        bank_connections: { data: null, error: { message: 'boom' } },
      }),
    )
    const res = await GET(req(), params)
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBeTruthy()
  })
})
