/**
 * Tests for the v1 dimension value lifecycle endpoints (#895):
 *   PATCH  /api/v1/companies/:companyId/dimensions/:id/values/:valueId
 *   DELETE /api/v1/companies/:companyId/dimensions/:id/values/:valueId
 *
 * Same Proxy-backed Supabase mock pattern as ./route.test.ts.
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
import { PATCH as patchValue, DELETE as deleteValue } from '../[id]/values/[valueId]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

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
const VALUE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const URL_BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/dimensions/${DIMENSION_ID}/values/${VALUE_ID}`
const routeParams = {
  params: Promise.resolve({ companyId: COMPANY_ID, id: DIMENSION_ID, valueId: VALUE_ID }),
}

const SAMPLE_VALUE = {
  id: VALUE_ID,
  dimension_id: DIMENSION_ID,
  code: 'P001',
  name: 'Villa Almgren tak',
  is_active: true,
  start_date: null,
  end_date: null,
}

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

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['bookkeeping:write'],
    mode: 'live',
  })
})

describe('PATCH /api/v1/companies/:companyId/dimensions/:id/values/:valueId', () => {
  it('updates name + is_active (archive) on the value', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimension_values: [
          { data: SAMPLE_VALUE, error: null },
          { data: { ...SAMPLE_VALUE, name: 'Nytt namn', is_active: false }, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await patchValue(
      makeRequest(URL_BASE, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Nytt namn', is_active: false }),
      }),
      routeParams,
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.name).toBe('Nytt namn')
    expect(body.data.is_active).toBe(false)
  })

  it('sets an end_date on a project value (accumulating dimension)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimensions: { data: { id: DIMENSION_ID, resets_annually: false }, error: null },
        dimension_values: [
          { data: SAMPLE_VALUE, error: null },
          { data: { ...SAMPLE_VALUE, end_date: '2026-08-31' }, error: null },
        ],
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await patchValue(
      makeRequest(URL_BASE, {
        method: 'PATCH',
        body: JSON.stringify({ end_date: '2026-08-31' }),
      }),
      routeParams,
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.end_date).toBe('2026-08-31')
  })

  it('rejects dates on a resets_annually dimension (kostnadsställe)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimensions: { data: { id: DIMENSION_ID, resets_annually: true }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await patchValue(
      makeRequest(URL_BASE, {
        method: 'PATCH',
        body: JSON.stringify({ end_date: '2026-08-31' }),
      }),
      routeParams,
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('DIMENSION_VALUE_DATES_NOT_ALLOWED')
  })

  it('returns 404 DIMENSION_VALUE_NOT_FOUND when the value is not in the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimension_values: { data: null, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await patchValue(
      makeRequest(URL_BASE, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'x' }),
      }),
      routeParams,
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('DIMENSION_VALUE_NOT_FOUND')
  })

  it('rejects an empty body (schema refine)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await patchValue(
      makeRequest(URL_BASE, { method: 'PATCH', body: JSON.stringify({}) }),
      routeParams,
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('dry-run previews the merged value without writing', async () => {
    const fromSpy = vi.fn()
    mockServiceClient.mockReturnValue({
      from: (table: string) => {
        fromSpy(table)
        const handler: ProxyHandler<object> = {
          get(_t, prop) {
            if (prop === 'then') {
              const data =
                table === 'company_members'
                  ? { company_id: COMPANY_ID, role: 'owner' }
                  : table === 'dimension_values'
                    ? SAMPLE_VALUE
                    : null
              return (resolve: (v: unknown) => void) => resolve({ data, error: null })
            }
            return () => new Proxy({}, handler)
          },
        }
        return new Proxy({}, handler)
      },
      rpc: vi.fn(),
    })

    const res = await patchValue(
      makeRequest(`${URL_BASE}?dry_run=true`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active: false }),
      }),
      routeParams,
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.is_active).toBe(false)
    // Only one read (the pre-flight fetch): no second dimension_values await
    // means no UPDATE was issued through the queue.
    expect(fromSpy.mock.calls.filter(([t]) => t === 'dimension_values')).toHaveLength(1)
  })

  it('rejects keys without bookkeeping:write scope (403)', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      scopes: ['reports:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await patchValue(
      makeRequest(URL_BASE, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) }),
      routeParams,
    )

    expect(res.status).toBe(403)
  })
})

describe('DELETE /api/v1/companies/:companyId/dimensions/:id/values/:valueId', () => {
  it('deletes an unreferenced value', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimension_values: { data: [{ id: VALUE_ID }], error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteValue(makeRequest(URL_BASE, { method: 'DELETE' }), routeParams)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({ deleted: true, id: VALUE_ID })
  })

  it('returns 409 DIMENSION_VALUE_REFERENCED with an archive hint when the retention trigger blocks', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimension_values: {
          data: null,
          error: { code: 'P0001', message: 'Värdet "P001" används på bokförda verifikat' },
        },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteValue(makeRequest(URL_BASE, { method: 'DELETE' }), routeParams)

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('DIMENSION_VALUE_REFERENCED')
    expect(body.error.valid_alternatives.archive_body).toEqual({ is_active: false })
  })

  it('returns 404 DIMENSION_VALUE_NOT_FOUND when nothing was deleted', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        dimension_values: { data: [], error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteValue(makeRequest(URL_BASE, { method: 'DELETE' }), routeParams)

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('DIMENSION_VALUE_NOT_FOUND')
  })

  it('returns 400 VALIDATION_ERROR for a non-UUID valueId', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        idempotency_keys: { data: null, error: null },
      }),
    )

    const res = await deleteValue(
      makeRequest(URL_BASE, { method: 'DELETE' }),
      { params: Promise.resolve({ companyId: COMPANY_ID, id: DIMENSION_ID, valueId: 'not-a-uuid' }) },
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})
