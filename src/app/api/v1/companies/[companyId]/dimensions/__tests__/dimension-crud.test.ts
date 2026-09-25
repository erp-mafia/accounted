/**
 * The dimension registry through the v1 door of the operation registry
 * (src/lib/operations/dimensions.ts via lib/operations/v1.ts):
 *   POST   /api/v1/companies/:companyId/dimensions
 *   PATCH  /api/v1/companies/:companyId/dimensions/:id
 *   DELETE /api/v1/companies/:companyId/dimensions/:id
 *
 * Also the adapter's own contract: the path id reaches the input, a dry run
 * writes nothing, a failure answers the registry code, 201 for a created row.
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
import { POST as createDimension } from '../route'
import { PATCH as updateDimension, DELETE as deleteDimension } from '../[id]/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/** Per-table queue mock that also records every (table, method, args). */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  return {
    calls,
    from: vi.fn((table: string) => buildChain(table)),
    rpc: vi.fn(() => buildChain('rpc')),
  }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DIM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const MEMBER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/dimensions`

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const companyParams = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const dimParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: DIM_ID }) }

const CUSTOM_DIM = {
  id: DIM_ID,
  sie_dim_no: 20,
  name: 'Avdelning',
  parent_sie_dim_no: null,
  resets_annually: true,
  is_system: false,
  is_active: true,
  sort_order: 100,
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

describe('POST /api/v1/companies/:companyId/dimensions', () => {
  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    mockServiceClient.mockReturnValue(makeClient({}))
    const res = await createDimension(request(BASE, { method: 'POST', body: '{"name":"Avdelning"}' }), companyParams)
    expect(res.status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await createDimension(request(BASE, { method: 'POST', body: '{"name":"Avdelning"}' }), companyParams)
    expect(res.status).toBe(403)
  })

  it('400 VALIDATION_ERROR when name is missing', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await createDimension(request(BASE, { method: 'POST', body: '{}' }), companyParams)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('201 with the next free number from 20 when sie_dim_no is omitted', async () => {
    const client = makeClient({
      company_members: MEMBER,
      rpc: { data: null, error: null },
      dimensions: [
        { data: [{ sie_dim_no: 1 }, { sie_dim_no: 6 }, { sie_dim_no: 20 }], error: null },
        { data: { ...CUSTOM_DIM, sie_dim_no: 21 }, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await createDimension(request(BASE, { method: 'POST', body: '{"name":"Avdelning"}' }), companyParams)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.dimension.sie_dim_no).toBe(21)
    const insert = client.calls.find((c) => c.table === 'dimensions' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({ company_id: COMPANY_ID, sie_dim_no: 21, name: 'Avdelning', is_system: false })
  })

  it('409 DIMENSION_NUMBER_TAKEN for an explicit number in use', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        rpc: { data: null, error: null },
        dimensions: { data: [{ sie_dim_no: 1 }, { sie_dim_no: 6 }, { sie_dim_no: 20 }], error: null },
      }),
    )
    const res = await createDimension(
      request(BASE, { method: 'POST', body: '{"name":"Avdelning","sie_dim_no":20}' }),
      companyParams,
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DIMENSION_NUMBER_TAKEN')
  })

  it('a dry run previews the number and writes nothing, not even the system-dimension seed', async () => {
    const client = makeClient({
      company_members: MEMBER,
      dimensions: { data: [], error: null },
    })
    mockServiceClient.mockReturnValue(client)
    const res = await createDimension(
      request(`${BASE}?dry_run=true`, { method: 'POST', body: '{"name":"Avdelning","parent_sie_dim_no":6}' }),
      companyParams,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({ sie_dim_no: 20, parent_sie_dim_no: 6, number_auto_picked: true })
    expect(client.rpc).not.toHaveBeenCalled()
    expect(client.calls.some((c) => c.method === 'insert')).toBe(false)
  })
})

describe('PATCH /api/v1/companies/:companyId/dimensions/:id', () => {
  it('takes the dimension id from the path and applies a sparse update', async () => {
    const client = makeClient({
      company_members: MEMBER,
      dimensions: [
        { data: { id: DIM_ID, name: 'Avdelning', is_system: false }, error: null },
        { data: { ...CUSTOM_DIM, is_active: false }, error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await updateDimension(
      request(`${BASE}/${DIM_ID}`, { method: 'PATCH', body: '{"is_active":false}' }),
      dimParams,
    )
    expect(res.status).toBe(200)
    expect((await res.json()).data.is_active).toBe(false)
    const update = client.calls.find((c) => c.table === 'dimensions' && c.method === 'update')
    expect(update?.args[0]).toEqual({ is_active: false })
    expect(client.calls.some((c) => c.table === 'dimensions' && c.method === 'eq' && c.args[1] === DIM_ID)).toBe(true)
  })

  it('400 when the body changes nothing', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER }))
    const res = await updateDimension(request(`${BASE}/${DIM_ID}`, { method: 'PATCH', body: '{}' }), dimParams)
    expect(res.status).toBe(400)
  })

  it('404 DIMENSION_NOT_FOUND for an id outside the company', async () => {
    mockServiceClient.mockReturnValue(makeClient({ company_members: MEMBER, dimensions: { data: null, error: null } }))
    const res = await updateDimension(
      request(`${BASE}/${DIM_ID}`, { method: 'PATCH', body: '{"name":"X"}' }),
      dimParams,
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('DIMENSION_NOT_FOUND')
  })

  it('400 DIMENSION_SYSTEM_RENAME for a system dimension', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        dimensions: { data: { id: DIM_ID, name: 'Kostnadsställe', is_system: true }, error: null },
      }),
    )
    const res = await updateDimension(
      request(`${BASE}/${DIM_ID}`, { method: 'PATCH', body: '{"name":"Avdelning"}' }),
      dimParams,
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('DIMENSION_SYSTEM_RENAME')
  })
})

describe('DELETE /api/v1/companies/:companyId/dimensions/:id', () => {
  it('deletes a custom dimension', async () => {
    const client = makeClient({
      company_members: MEMBER,
      dimensions: [
        { data: { id: DIM_ID, name: 'Avdelning', sie_dim_no: 20, is_system: false }, error: null },
        { data: [{ id: DIM_ID }], error: null },
      ],
    })
    mockServiceClient.mockReturnValue(client)
    const res = await deleteDimension(request(`${BASE}/${DIM_ID}`, { method: 'DELETE' }), dimParams)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ deleted: true, dimension_id: DIM_ID })
  })

  it('400 DIMENSION_SYSTEM_DELETE for a system dimension', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        dimensions: { data: { id: DIM_ID, name: 'Projekt', sie_dim_no: 6, is_system: true }, error: null },
      }),
    )
    const res = await deleteDimension(request(`${BASE}/${DIM_ID}`, { method: 'DELETE' }), dimParams)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('DIMENSION_SYSTEM_DELETE')
  })

  it('409 DIMENSION_REFERENCED when the DB guard refuses a booked dimension', async () => {
    mockServiceClient.mockReturnValue(
      makeClient({
        company_members: MEMBER,
        dimensions: [
          { data: { id: DIM_ID, name: 'Avdelning', sie_dim_no: 20, is_system: false }, error: null },
          { data: null, error: { code: 'P0001', message: 'Dimension 20 används på bokförda rader' } },
        ],
      }),
    )
    const res = await deleteDimension(request(`${BASE}/${DIM_ID}`, { method: 'DELETE' }), dimParams)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('DIMENSION_REFERENCED')
  })
})
