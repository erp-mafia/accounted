/**
 * Integration tests for GET /api/v1/companies — the list-companies endpoint.
 *
 * Regression coverage for #781: this is the only AUTHENTICATED static route on
 * the v1 surface (no `[companyId]` segment), so Next.js 16 invokes its handler
 * with `{ params: undefined }` rather than `{ params: Promise<{}> }`. The v1
 * wrapper used to `await params.params` blindly and null-deref, returning 500
 * for every valid key. These tests invoke the real handler with that exact
 * static-route context.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `companies route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as listCompanies } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const USER_ID = '930abb54-c5ef-4ae0-b274-30fb16e9a295'

// A Proxy-based supabase stub: every chained builder method returns the chain,
// and awaiting it resolves to the configured { data, error } for the table.
function makeFlexibleSupabase(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

function makeRequest(url = 'https://x.test/api/v1/companies'): Request {
  return new Request(url, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

// THE crux of the regression: Next.js 16 passes `{ params: undefined }` to the
// handler of a static (non-dynamic) route. Reproduce that exact shape.
type GetCtx = Parameters<typeof listCompanies>[1]
function staticRouteContext(): GetCtx {
  return { params: undefined } as unknown as GetCtx
}

function membershipRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'owner',
    joined_at: '2025-01-04T08:00:00.000Z',
    companies: {
      id: '8fd5b1f4-0000-4000-8000-000000000001',
      name: 'Acme AB',
      org_number: '556677-8899',
      entity_type: 'aktiebolag',
      archived_at: null,
      created_at: '2025-01-04T08:00:00.000Z',
    },
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: undefined,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['companies:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(makeFlexibleSupabase({ company_members: { data: [], error: null } }))
})

describe('GET /api/v1/companies', () => {
  it('returns 200 (not 500) for a static-route context where params is undefined — regression #781', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ company_members: { data: [membershipRow()], error: null } }),
    )

    const res = await listCompanies(makeRequest(), staticRouteContext())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error).toBeUndefined()
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.meta.request_id).toMatch(/^req_/)
  })

  it('maps each membership row to a company summary in the { data, meta } envelope', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ company_members: { data: [membershipRow()], error: null } }),
    )

    const res = await listCompanies(makeRequest(), staticRouteContext())
    const body = await res.json()

    expect(body.data).toEqual([
      {
        id: '8fd5b1f4-0000-4000-8000-000000000001',
        name: 'Acme AB',
        org_number: '556677-8899',
        entity_type: 'aktiebolag',
        role: 'owner',
        created_at: '2025-01-04T08:00:00.000Z',
      },
    ])
  })

  it('drops rows whose joined company was filtered out (archived → null embed)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: {
          data: [membershipRow(), membershipRow({ id: '22222222-2222-4222-8222-222222222222', companies: null })],
          error: null,
        },
      }),
    )

    const res = await listCompanies(makeRequest(), staticRouteContext())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toHaveLength(1)
  })

  it('returns an empty list (200) when the key user has no memberships', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({ company_members: { data: [], error: null } }),
    )

    const res = await listCompanies(makeRequest(), staticRouteContext())
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.data).toEqual([])
  })

  it('returns 401 for a missing bearer token (auth still enforced)', async () => {
    const res = await listCompanies(
      new Request('https://x.test/api/v1/companies'),
      staticRouteContext(),
    )
    expect(res.status).toBe(401)
  })
})
