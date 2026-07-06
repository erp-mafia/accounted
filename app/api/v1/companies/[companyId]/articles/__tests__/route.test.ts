/**
 * Tests for GET /api/v1/companies/:companyId/articles (#895).
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
import { GET as listArticles } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const SAMPLE_ARTICLE = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  article_number: 'A-0001',
  name: 'Takarbete',
  name_en: null,
  type: 'tjanst',
  unit: 'tim',
  price_excl_vat: 850,
  vat_rate: 25,
  revenue_account: null,
  cost_price: null,
  ean: null,
  housework_type: 'BYGG',
  notes: null,
  active: true,
  created_at: '2026-05-01T09:14:33Z',
  updated_at: '2026-05-01T09:14:33Z',
}

/** Chainable mock whose terminal await resolves per-table. Records eq() calls. */
function makeSupabase(byTable: Record<string, { data?: unknown; error?: unknown }>) {
  const eqCalls: Array<[string, unknown, unknown]> = []
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
        }
        return (...args: unknown[]) => {
          if (prop === 'eq') eqCalls.push([table, args[0], args[1]])
          return buildChain(table)
        }
      },
    }
    return new Proxy({}, handler)
  }
  return {
    from: vi.fn((table: string) => buildChain(table)),
    rpc: vi.fn(() => buildChain('rpc')),
    eqCalls,
  }
}

function makeRequest(url: string): Request {
  return new Request(url, {
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}

const routeParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/articles', () => {
  it('returns active articles with the documented projection', async () => {
    const client = makeSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      articles: { data: [SAMPLE_ARTICLE], error: null },
    })
    mockServiceClient.mockReturnValue(client)

    const res = await listArticles(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/articles`),
      routeParams,
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.articles).toHaveLength(1)
    expect(body.data.articles[0].housework_type).toBe('BYGG')
    // Default: inactive articles filtered out.
    expect(client.eqCalls).toContainEqual(['articles', 'active', true])
  })

  it('includes inactive articles with ?include_inactive=true', async () => {
    const client = makeSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      articles: { data: [SAMPLE_ARTICLE, { ...SAMPLE_ARTICLE, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', active: false }], error: null },
    })
    mockServiceClient.mockReturnValue(client)

    const res = await listArticles(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/articles?include_inactive=true`),
      routeParams,
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.articles).toHaveLength(2)
    expect(client.eqCalls).not.toContainEqual(['articles', 'active', true])
  })

  it('rejects a malformed include_inactive with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await listArticles(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/articles?include_inactive=1`),
      routeParams,
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects keys without invoices:read scope (403)', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      scopes: ['reports:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeSupabase({}))

    const res = await listArticles(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/articles`),
      routeParams,
    )

    expect(res.status).toBe(403)
  })
})
