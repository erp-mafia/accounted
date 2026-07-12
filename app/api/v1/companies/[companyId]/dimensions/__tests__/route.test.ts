/**
 * Integration tests for the v1 dimensions surface (dimensions PR2):
 *   GET  /api/v1/companies/:companyId/dimensions
 *   POST /api/v1/companies/:companyId/dimensions/:id/values
 *
 * Mirrors the suppliers/accounts test pattern: a Proxy-backed Supabase mock
 * returns whatever the route awaits, keyed by table name (plus an `rpc` key
 * for ensure_company_dimensions).
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
import { GET as listDimensions } from '../route'
import { POST as createValue } from '../[id]/values/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/**
 * Per-table queue mock: TableResp[] consumes one entry per await, then sticks
 * on the last entry. The special key `rpc` answers `supabase.rpc(...)` calls.
 */
function makeFlexibleSupabase(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (key: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(key)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(key)
      },
    }
    return new Proxy({}, handler)
  }
  return {
    from: vi.fn((table: string) => buildChain(table)),
    rpc: vi.fn(() => buildChain('rpc')),
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DIMENSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function makeRequest(url: string, init?: RequestInit): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'c1aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ...(init?.headers ?? {}),
    },
  })
}

const SAMPLE_DIMS = [
  {
    id: DIMENSION_ID,
    sie_dim_no: 1,
    name: 'Kostnadsställe',
    resets_annually: true,
    is_system: true,
    is_active: true,
    sort_order: 10,
  },
  {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    sie_dim_no: 6,
    name: 'Projekt',
    resets_annually: false,
    is_system: true,
    is_active: true,
    sort_order: 20,
  },
]

const SAMPLE_VALUE = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  dimension_id: DIMENSION_ID,
  code: 'BUTIK',
  name: 'Butiken',
  is_active: true,
  start_date: null,
  end_date: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/dimensions', () => {
  it('ensures system dims and returns the registry with nested values', async () => {
    const client = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      rpc: { data: null, error: null },
      dimensions: { data: SAMPLE_DIMS, error: null },
      dimension_values: { data: [SAMPLE_VALUE], error: null },
    })
    mockServiceClient.mockReturnValue(client)

    const res = await listDimensions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/dimensions`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )

    expect(res.status).toBe(200)
    expect(client.rpc).toHaveBeenCalledWith('ensure_company_dimensions', {
      p_company_id: COMPANY_ID,
    })
    const body = await res.json()
    expect(body.data.dimensions).toHaveLength(2)
    expect(body.data.dimensions[0].sie_dim_no).toBe(1)
    expect(body.data.dimensions[0].values).toEqual([
      {
        id: SAMPLE_VALUE.id,
        code: 'BUTIK',
        name: 'Butiken',
        is_active: true,
        start_date: null,
        end_date: null,
      },
    ])
    expect(body.data.dimensions[1].values).toEqual([])
  })

  it('rejects keys without reports:read scope (403)', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await listDimensions(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/dimensions`),
      { params: Promise.resolve({ companyId: COMPANY_ID }) },
    )

    expect(res.status).toBe(403)
  })
})

describe('POST /api/v1/companies/:companyId/dimensions/:id/values', () => {
  const url = `https://x.test/api/v1/companies/${COMPANY_ID}/dimensions/${DIMENSION_ID}/values`
  const detailParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: DIMENSION_ID }) }

  it('creates a value (201, happy path)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimensions: { data: { id: DIMENSION_ID }, error: null },
        dimension_values: { data: { ...SAMPLE_VALUE, created_at: '2026-07-02T12:00:00Z' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createValue(
      makeRequest(url, {
        method: 'POST',
        body: JSON.stringify({ code: 'BUTIK', name: 'Butiken' }),
      }),
      detailParams,
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.code).toBe('BUTIK')
  })

  it('returns 400 when Idempotency-Key is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const req = new Request(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer test' },
      body: JSON.stringify({ code: 'BUTIK', name: 'Butiken' }),
    })
    const res = await createValue(req, detailParams)

    expect(res.status).toBe(400)
  })

  it('rejects a non-Fortnox code with 400 VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createValue(
      makeRequest(url, {
        method: 'POST',
        body: JSON.stringify({ code: 'BAD CODE!', name: 'x' }),
      }),
      detailParams,
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 404 DIMENSION_NOT_FOUND for a dimension outside the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimensions: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createValue(
      makeRequest(url, {
        method: 'POST',
        body: JSON.stringify({ code: 'BUTIK', name: 'Butiken' }),
      }),
      detailParams,
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('DIMENSION_NOT_FOUND')
  })

  it('returns 409 DIMENSION_VALUE_DUPLICATE_CODE on a 23505', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimensions: { data: { id: DIMENSION_ID }, error: null },
        dimension_values: { data: null, error: { code: '23505', message: 'duplicate' } },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await createValue(
      makeRequest(url, {
        method: 'POST',
        body: JSON.stringify({ code: 'BUTIK', name: 'Butiken' }),
      }),
      detailParams,
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('DIMENSION_VALUE_DUPLICATE_CODE')
  })

  it('returns a dry-run preview without inserting when ?dry_run=true', async () => {
    const fromSpy = vi.fn()
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        fromSpy(table)
        return new Proxy({}, {
          get(_t, prop) {
            if (prop === 'then') {
              const data =
                table === 'company_members'
                  ? { company_id: COMPANY_ID, role: 'owner' }
                  : table === 'dimensions'
                    ? { id: DIMENSION_ID }
                    : null
              return (resolve: (v: unknown) => void) => resolve({ data, error: null })
            }
            return () => new Proxy({}, this!)
          },
        })
      },
      rpc: vi.fn(),
    })

    const res = await createValue(
      makeRequest(`${url}?dry_run=true`, {
        method: 'POST',
        body: JSON.stringify({ code: 'P001', name: 'Villa Almgren tak' }),
      }),
      detailParams,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    expect(fromSpy).not.toHaveBeenCalledWith('dimension_values')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.code).toBe('P001')
  })
})
